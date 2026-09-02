# Empanadas.io Desktop App
This is a Electron wrapped native application for Desktop that runs Empanadas.io in it's best form! Play the Spin Game natively on your device, and don't worry about needing to save your progress!

Windows (x64) ships today. macOS (Apple Silicon and Intel) builds with
`npm run build:mac`, but is not released yet — see **macOS status** below.

## macOS status

The app runs on macOS: it has an application menu (so Cmd+Q/W/C/V work), the
window keeps its traffic lights via `titleBarStyle: 'hiddenInset'`, clicking the
dock icon reopens a closed window, and `empanadas-io://` links are delivered
through `open-url`.

Updates now have a macOS path: the updater picks the
`empanadas.io-<version>-mac-<arch>.zip` asset matching `process.arch`, unpacks
it with `ditto`, verifies it with `codesign --verify --deep --strict` plus a
pinned Team ID and a Gatekeeper assessment, then hands off to a small script
that waits for the app to exit, swaps the bundle, and reopens it. The swap moves
the old bundle aside rather than deleting it, so a failure part-way through
leaves a working app rather than an empty `/Applications` entry.

One thing is still missing before a macOS release:

- **Signing and notarization.** `build.mac` is configured for the hardened
  runtime with `build/entitlements.mac.plist`, but producing a distributable
  build needs a Developer ID Application certificate, an Apple Developer
  Program membership, and a macOS runner. `npm run build:mac` on any other
  platform silently skips signing, and an unsigned build is Gatekeeper-blocked
  on other people's Macs.

Until a Team ID is pinned (`CONFIG.macTeamId` in `updater.js`), the macOS
updater downloads and then refuses to install, on the grounds that it cannot
tell whose signature it is looking at. `npm test` prints a reminder while it is
unset. **The macOS update path has not been run on a Mac yet** — see
*Untested paths* below.

## Untested paths

Honest list of what has been written but not exercised on real hardware, so
nobody assumes more coverage than exists.

| Path | State |
| --- | --- |
| `download.html` (CSP, splash, offline, retry) | Tested in real Chromium — `test/splash.test.js` |
| `lib/pgp.js` signature verification | Tested against GnuPG output — `test/pgp.test.js` |
| Navigation, window and permission guards in `main.js` | Logic reviewed and unit-checked; **not** exercised in a running Electron window |
| Windows update flow end to end | Unchanged in shape from the working 1.10.8 flow, but the download path, cache location and OpenPGP step are new |
| macOS update flow (`ditto`, `codesign`, `spctl`, bundle swap) | **Never run.** Written from the documented behaviour of those tools |

`icon.png` is 570×570, so the generated `.icns` is upscaled at 512 and 1024.
Replacing it with a 1024×1024 source would sharpen the dock icon.

## Tests

`npm test` runs everything: syntax checks on the main-process files, assertions
that the hardening settings in `main.js` and `updater.js` are still in place,
packaging-config checks, and the signature-verification suite in
`test/pgp.test.js`.

The browser tests in `test/splash.test.js` need a Chromium and skip themselves
without one. To run them locally:

```sh
npm install --no-save playwright-core
npx playwright install chromium
npm test
```

CI installs that browser, so those assertions do run on every push and PR.

## CI

`.github/workflows/node.js.yml` validates every push and PR (`npm test` —
syntax checks, hardening assertions, packaging-config assertions, and the
signature-verification suite), then
builds unsigned Windows and macOS artifacts and attaches them to the run.
Download them from the run's **Artifacts** section; they are kept for 14 days.

CI deliberately does not publish. It passes `--publish never`, because
electron-builder otherwise detects CI and implicitly tries to upload to the
GitHub release — which both fails the build when no token is set and, when a
token *is* set, will attempt to add assets to an existing release. Releases
stay a manual, signed step; see **Cutting a release** below.

CI artifacts are unsigned, so the updater will refuse to install them. They are
for checking that a change packages and launches, not for distribution.

## What the app stores

| Where | What | Cleared on uninstall? |
| --- | --- | --- |
| `localStorage` on the splash page | `AppID`, a random UUID generated on first run and passed to the dashboard as `&appid=` | No |
| `%APPDATA%\empanadas.io` (Windows) / `~/Library/Application Support/empanadas.io` (macOS) | Chromium profile: cookies, localStorage for empanadas.io, cache | No |
| `<userData>/updates` | A downloaded installer, deleted once installed or once verification fails | No |

`build.nsis.deleteAppDataOnUninstall` is **false** on purpose: uninstalling
keeps settings so a reinstall picks up where the user left off. The trade-off is
that the `AppID` survives an uninstall too, so a reinstall on the same machine
is the same identifier. Flip it to `true` if uninstall should mean "forget me";
`npm test` asserts only that the value is set explicitly, not which way.

## Site headers

Everything in `main.js` hardens the *shell*: what the window may navigate to,
what a page may open, what permissions it gets. Once the window is on
empanadas.io, the page's own response headers are what stand between an injected
script and the app — and those come from the server, not from here.

The app logs a warning when the dashboard is served without a
`Content-Security-Policy`, but it deliberately does not inject one: enforcing a
guess about what the site needs breaks the game with no error the user can act
on. The fix belongs on the server. A reasonable starting set:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

Roll it out with `Content-Security-Policy-Report-Only` first — the real policy
will need whatever CDN, analytics and font origins the site actually uses, and
report-only tells you which without breaking anyone.

## Auto updates

`updater.js` checks the GitHub Releases API on startup (and every 6 hours),
compares the newest published tag against the running version, downloads the
installer asset, verifies it, and only then offers to install it.

Verification is fail-closed — anything that doesn't check out is deleted and
the update is abandoned:

| Check | Source | Config |
| --- | --- | --- |
| SHA-256 | the release asset's `digest` field from the GitHub API | `requireHash` |
| SHA-512 | `latest.yml`, if that asset was uploaded | `requireHash` |
| OpenPGP | `<asset>.sig` next to the asset, against a key pinned in `release-keys.json` | present/absent of `release-keys.json` |
| Authenticode (Windows) | `Get-AuthenticodeSignature` on the installer | `requireSignature`, `pinnedThumbprints`, `expectedPublisher` |
| codesign + Gatekeeper (macOS) | `codesign --verify --deep --strict`, then `spctl --assess` | `requireSignature`, `macTeamId`, `macBundleId`, `macRequireNotarized` |

The hashes only catch corruption: they come out of the same GitHub API response
as the download URL, so anyone who can change one can change the other. The two
signature checks are the real trust anchors, and they are independent of each
other and of GitHub:

- **OpenPGP** says the release came from whoever holds the release key. It is
  checked first, because if the release isn't ours there is no reason to ask the
  OS about it.
- **Authenticode / codesign** says the binary is one the operating system will
  accept, rooted in a code-signing certificate.

Settings all live in the `CONFIG` block at the top of `updater.js`. Updates can
be disabled at runtime with `--no-update` or `EMPANADAS_NO_UPDATE=1`.

### Release signing

`updater.js` verifies a detached OpenPGP signature over the downloaded asset
against keys pinned in `release-keys.json`. That file ships inside the app, so
nobody can turn the check off remotely — removing it would break the app's own
code signature.

**This is not switched on until `release-keys.json` exists.** Without it the
updater logs a warning and skips the check. To enable it:

```sh
gpg --export --armor <your release key id> > key.asc
node scripts/import-release-key.js key.asc     # writes release-keys.json
rm key.asc
```

Check the printed fingerprint against `gpg --fingerprint` and commit
`release-keys.json`. Only the public half is ever read or written.

Then sign every release asset and upload the `.sig` alongside it:

```sh
gpg --detach-sign dist/empanadas.io-Setup-<version>.exe
# produces empanadas.io-Setup-<version>.exe.sig - upload BOTH to the release
```

`.asc` (armored) signatures work too. Supported: RSA keys with SHA-256/384/512.
SHA-1 signatures are rejected.

> Note: the 1.10.8 release was already signed this way — `dist/*.exe.sig` is a
> real detached signature from key `3BFF B247 6A7A 02BE 2600 948B 1388 2805 6A80
> F9DE`. The updater just had no way to check it until now. If that is still the
> release key, importing it is the only step left.

### Pinning the signing certificate

By default the Windows check accepts any Authenticode certificate whose subject
contains `Empanadas.io`, which is weaker than it looks: a certificate issued to
someone else with that string in its subject would pass. Pinning fixes that.

```sh
node scripts/thumbprint.js dist/empanadas.io-Setup-<version>.exe   # Windows
node scripts/thumbprint.js "dist/mac-arm64/Empanadas.io.app"       # macOS
```

It prints the values to paste into `CONFIG` (`pinnedThumbprints` on Windows,
`macTeamId` on macOS). Run it against an artifact **you** just signed — reading
the value off a download would pin whatever signed the download, which is the
thing the pin exists to catch.

During a certificate rollover, keep both the old and the new thumbprint in the
list so clients on the previous release accept either.

### Cutting a release

The updater reads the GitHub API directly, so it only needs the installer
attached to a **published** (not draft) release whose tag matches the version
in `package.json`:

1. Bump `version` in `package.json`.
2. `npm run build` — produces `dist/empanadas.io-Setup-<version>.exe`.
3. Sign the installer (the updater refuses anything without a valid
   Authenticode signature naming `Empanadas.io`, or matching a pinned
   thumbprint if one is set).
4. `gpg --detach-sign dist/empanadas.io-Setup-<version>.exe`
5. Publish a release tagged `v<version>` with **both** the `.exe` and the
   `.exe.sig` attached. Once `release-keys.json` exists, a release without the
   `.sig` will not install.

Upload the `.exe` with **no spaces in the filename**. GitHub rewrites spaces in
asset names to dots, which is what breaks tools that expect an exact filename.
The `artifactName` setting in `package.json` now produces dash-separated names
so this can't happen.
