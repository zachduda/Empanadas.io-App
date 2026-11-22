# Security

How this app protects the two things worth protecting: the update channel, and
the window that loads empanadas.io.

For the day-to-day steps — cutting a release, importing the signing key, pinning
a certificate — see [docs/RELEASING.md](docs/RELEASING.md).

## Reporting a vulnerability

Open an issue at <https://github.com/zachduda/Empanadas.io-App/issues>, or email
the address on <https://zachduda.com> if it should not be public first.

## The update channel

`updater.js` checks the GitHub Releases API on startup and every 6 hours,
compares the newest published tag against the running version, downloads the
asset for this platform, verifies it, and only then offers to install it.

Verification is fail-closed — anything that doesn't check out is deleted and the
update is abandoned:

| Check | Source | Config |
| --- | --- | --- |
| SHA-256 | the release asset's `digest` field from the GitHub API | `requireHash` |
| SHA-512 | the platform's `latest*.yml`, matched to this asset by name | `requireHash` |
| OpenPGP | `<asset>.sig` next to the asset, against a key pinned in `release-keys.json` | presence of `release-keys.json` |
| Authenticode (Windows) | `Get-AuthenticodeSignature` on the installer | `requireSignature`, `pinnedThumbprints`, `expectedPublisher` |
| codesign + Gatekeeper (macOS) | `codesign --verify --deep --strict`, then `spctl --assess` | `requireSignature`, `macTeamId`, `macBundleId`, `macRequireNotarized` |

The hashes only catch corruption. They come out of the same GitHub API response
as the download URL, so anyone who can change one can change the other. The two
signature checks are the real trust anchors, and they are independent of each
other and of GitHub:

- **OpenPGP** says the release came from whoever holds the release key. Checked
  first: if the release isn't ours, there is no reason to ask the OS about it.
- **Authenticode / codesign** says the binary is one the operating system will
  accept, rooted in a code-signing certificate.

Everything the updater fetches must be `https` and on a GitHub host. Redirects
are followed manually, one hop at a time, so a redirect to `http://` or to
another host is refused rather than taken silently.

The download is cached under `userData`, not the system temp directory: on a
shared machine another user can write to temp, which would let them swap the
file between the hash check and the moment it is launched.

Settings live in the `CONFIG` block at the top of `updater.js`. Updates can be
disabled at runtime with `--no-update` or `EMPANADAS_NO_UPDATE=1`.

## The window

`main.js` decides what the window may do once it is on empanadas.io:

- Navigation is filtered by parsed hostname, not by string prefix. A prefix test
  accepts `https://empanadas.io.example.com` and `https://empanadas.io@example.com`.
- `will-redirect` is filtered too, since `will-navigate` does not fire for
  server-side redirects.
- New windows are denied. A child window inherits the preload, which exposes the
  updater bridge; off-site `https` links open in the user's browser instead.
- `<webview>` is disabled and `will-attach-webview` blocked. Nothing embeds one.
- Permissions are denied except fullscreen and pointer lock, and only for our
  own origin. Device pickers and Bluetooth pairing are refused outright.
- IPC handlers check the sender frame, so a page that does end up loaded cannot
  drive the window chrome or trigger the updater.
- The renderer is sandboxed with context isolation on and node integration off.

## Site headers

Everything above hardens the *shell*. Once the window is on empanadas.io, the
page's own response headers are what stand between an injected script and the
app — and those come from the server, not from here.

The app logs a warning when the dashboard is served without a
`Content-Security-Policy`. It deliberately does not inject one: enforcing a
guess about what the site needs breaks the game with no error the user can act
on. The fix belongs on the server. A reasonable starting set:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

Roll it out with `Content-Security-Policy-Report-Only` first — the real policy
needs whatever CDN, analytics and font origins the site actually uses, and
report-only tells you which without breaking anyone.

## What the app stores

| Where | What | Cleared on uninstall? |
| --- | --- | --- |
| `localStorage` on the splash page | `AppID`, a random UUID generated on first run and passed to the dashboard as `&appid=` | No |
| `%APPDATA%\empanadas.io` (Windows) / `~/Library/Application Support/empanadas.io` (macOS) | Chromium profile: cookies, localStorage for empanadas.io, cache | No |
| `<userData>/Partitions/play` | The games' own Chromium profile: their localStorage (saves) and a copy of the account's empanadas.io cookies (`lib/cookiebridge.js`) | No |
| `<userData>/Games` | The games' files, kept for offline play (`lib/gamebundle.js`): the site's public pages, scripts, pictures and sounds | No |
| `<userData>/Answers` | The native screens' last answers from the site, for offline (`lib/answers.js`), without csrf tokens; deleted at sign-out | No |
| `<userData>/Pictures` | Profile pictures, from empanadas.io only (`lib/imagecache.js`) | No |
| `<userData>/signin.json` | The PKCE verifier of a sign-in under way, for at most 15 minutes, so it survives the browser relaunching the app | No |
| `<userData>/account.json`, `prefs.json`, `play-history.json` | Whether an account is signed in and its name; theme and notification settings; when each game was last played here | No |
| `<userData>/updates` | A downloaded installer, deleted once installed or once verification fails | No |
| `<userData>/background.json` | `{ "enabled": true/false }`, the Keep Spinning When Closed setting (off unless set) | No |

`build.nsis.deleteAppDataOnUninstall` is **false** on purpose: uninstalling
keeps settings so a reinstall picks up where the user left off. The trade-off is
that the `AppID` survives an uninstall too, so a reinstall on the same machine
is the same identifier. Flip it to `true` if uninstall should mean "forget me";
`npm test` asserts only that the value is set explicitly, not which way.

## Untested paths

What has been written but not exercised on real hardware, so nobody assumes more
coverage than exists.

| Path | State |
| --- | --- |
| The native app end to end (sign-in hand-off, every screen, games from disk online and offline, sign-out) | Run in Electron 45 on Linux against a stand-in site serving the site's real game files — `npm run e2e` (`test/e2e/run.js`). **Not yet run** on real Windows or macOS: the title bars (traffic lights, Windows caption buttons, vibrancy), the Dock menu and jump list, and the `empanadas-io://` link coming back from a real browser |
| Games served from disk (`lib/gameprotocol.js`, `lib/gamebundle.js`, `lib/cookiebridge.js`) | Unit-tested — `test/games.test.js`; cookies, POST bodies, uploads and redirects through the interception were checked in Electron 45 |
| `lib/pgp.js` signature verification | Tested against GnuPG output — `test/pgp.test.js` |
| Navigation, window and permission guards in `main.js` | Logic reviewed and unit-checked; **not** exercised in a running Electron window |
| Windows update flow end to end | Unchanged in shape from the working 1.10.8 flow, but the download path, cache location and OpenPGP step are new |
| macOS update flow (`ditto`, `codesign`, `spctl`, bundle swap) | **Never run.** Written from the documented behaviour of those tools |
| Keep Spinning When Closed (`lib/background.js`, tray, priority) | Rules unit-tested — `test/background.test.js`. The hand-off, the minute's save and reopening were run end to end in Electron 45 on Linux against a stand-in site, posing as Windows. **Not yet run** on real Windows or macOS: the tray icon and menu-bar count, the Mac relaunch on reopening, and suspend/resume |
