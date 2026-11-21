# The native desktop app (2.0)

Up to 1.12 the desktop app was empanadas.io in a window: a splash page, then
the website, with window buttons drawn into its pages. From 2.0 the app's
screens are its own, the way the iOS app's are, and the games are kept on the
computer. The games themselves are still the site's.

## What's native and what's web

| | |
|---|---|
| **Window** | A sidebar (Home, Games, Leaderboards, Friends, My Profile, and your account at the bottom for Settings) and a title bar of the app's own. On a Mac the system's traffic lights sit inset in it and the sidebar is the translucent sidebar material (`vibrancy: 'sidebar'`); on Windows the system's own minimize, maximize and close (with Snap Layouts) are drawn over it (`titleBarOverlay`); on Linux the window has its normal frame. System fonts and system-sized controls; Poppins only for the brand and the big numbers. Light and dark follow the system or the account's theme (`nativeTheme`). |
| **Sign-in** | Native welcome screen: "Got an account?", **Yup! Log In** or **Nope. Create One**. Either opens the whole sign-in in the player's own browser, at the site's `/v2/auth/app.php`, where their password manager, passkeys and Google/GitHub/Discord sessions already are. The site hands it back with `empanadas-io://signin?code=`, and the app redeems the code at `/v2/ios/signin.php` with the PKCE verifier only it holds (`lib/signin.js`). The same arrangement as the iOS app; the login page never shows inside the app. |
| **Home** | The dashboard, from `/v2/ios/dashboard.php`: stat tiles, a card per game with its meter and a Play button, the Spin Progress chart (total or per day, 1W to All, hover to read a day), experience and rank, friends and who's online, and the friend requests waiting. Refreshed every few minutes while the app is open (`startDashboardPoll()`), and after a game closes. |
| **Games** | Jump Back In for the game played last, then a card per game: when it was last played on this computer, your place on its leaderboard, three of your numbers, and whether it's downloaded for offline. Right-click for its leaderboard or Report a Problem. |
| **Leaderboards** | Spin, Flappy and Tower from `/v2/ios/leaderboard.php`, medals for the top three, your row marked; a row opens that player's profile. Refreshes at the pace the site's cache rebuilds. |
| **Friends** | Find Friends (search as you type, `/v2/ios/search.php`) with Add, Accept, Cancel and Unfriend on each result; then requests to answer, your friends (online first) and the requests you sent. |
| **Profiles** | Yours and anyone's, from `/v2/ios/profile.php`, under the site's privacy rules: picture, badges, presence, status line (edit your own in place), experience and what earned it, stats, star sign, friends. |
| **Settings** | The account from `/v2/ios/account.php`: theme, privacy and email settings saved as they change (`account_edit.php`, as the account page saves them); Keep Spinning When Closed; friend request notifications; the games on this computer (check for updates, download again, save points); the cache; updates; sign out; delete account (type DELETE). Email and username, connections, passkeys, two-factor and the profile picture open the site's own pages, in a window of their own, signed in as the app is. |
| **Save Points** | Native, from the site's `/v2/gamehistory.php`: each save point against your account now, and Restore (undoable, as on the site). |
| **Updates** | The site's announcements (`api.empanadas.io/v1/updates.php`), with New on the ones since you last looked and a dot on the bell. Posts are HTML from the admin panel; `shell/js/sanitize.js` rebuilds the parts they use and drops everything else. |
| **Send Feedback** | Native form from `/v2/ios/feedback.php`, sent through `account_edit.php`. Spin's Report a Problem opens it with the subject picked. |
| **Games** (playing) | The site's own pages, in a view over the window below the title bar, which keeps **Home** (closes the game; ⌘W / Ctrl+W too) and a full-screen button. A game's own close button closes it. A game's link to one of the app's screens (a profile, Report a Problem) shows that screen with **Return to Spin** in the title bar; any other page of the site opens in a site window, anything else in the browser. |
| **Offline** | Home, Leaderboards, your profile and Settings open with their last answer and say when it was saved. The games start from the computer without a connection, from their own saves, and sync when it's back (the games already do this). |
| **System** | Native menus with shortcuts (⌘1–5 / Ctrl+1–5 for the sections, ⌘F Find Friends, ⇧⌘1–3 to play), Play Spin / Flappy / Tower in the Dock menu and the Windows jump list (last played first), the Dock badge for friend requests, a notification for a new one while the app is in the background, and native context menus. `empanadas-io://` links open screens: `://home`, `://games`, `://leaderboard`, `://friends`, `://profile[/<id>]`, `://settings`, `://feedback[?reason=]`, `://updates[/<id>]`, `://play/<game>`. |
| **Keep Spinning When Closed** | As before: closing the window during Spin with it on hands the game to the tray or menu bar (`lib/background.js`). |

## How it fits together

```
main.js ─┬─ default session ──── app://shell (shell/: the screens)
         │                   ├── lib/api.js ──────────── empanadas.io /v2/ios/*, account_edit.php, gamehistory.php
         │                   └── site windows ────────── the site's account pages
         │
         └─ persist:play ─────── the game view ───────── https://empanadas.io/spin …
                             └── lib/gameprotocol.js ─┬─ lib/gamebundle.js (files on disk)
                                                      └─ the network (saves, clock, anything not kept)
```

**The API.** `lib/api.js` is the main process's client for the site's native
API, `/v2/ios/*`. Despite the name, nothing there is specific to iOS: every
endpoint answers JSON to any app that brings a signed-in session, checking
only the session cookie and the user agent it signed in with. The desktop app
sends the same user agent as its pages, so a session signed in by either is
good for both. Changes go through `/v2/account_edit.php` with the session's
csrf token, which never leaves the main process (`forShell()`); the screens
ask for data by name over IPC (`Content/JS/shell-preload.js`), and every IPC
call checks it comes from the app's own page in the app's own window. The last
good answer of each screen is kept on disk for offline (`lib/answers.js`).

**The games on disk.** `lib/gamebundle.js` keeps every file the games need in
`<userData>/Games`, found from the games themselves as the iOS app finds them
(each game's page, the stylesheets, scripts and pictures it names, the fonts
and pictures those name, plus the sounds Spin builds the path of in script),
and anything a game fetches that none of that found is kept the first time.
It is brought up to date with conditional requests (usually a page of 304s)
at launch, every six hours, after a sleep, and before a game starts if the
copy is more than 30 minutes old. Files are stored by the hash of their
contents and the index is replaced in one rename, so a sync cut short leaves a
working copy.

`lib/gameprotocol.js` answers every https request of the games' session
(`protocol.handle('https')` on `persist:play`, and only there): a kept file
from disk, with its original security headers and byte ranges for audio;
anything else straight through to the network (`session.fetch` with
`bypassCustomProtocolHandlers`). So `https://empanadas.io/spin` is still the
site's origin, with its localStorage and cookies, and the saves
(`getdata.php`, `updatedata.php`) still go to the site. With the network known
to be down, the network gets four seconds, so a game opened offline starts
from its own save at once rather than waiting on a dead connection. This
replaces the site's service worker, which the 1.x app registered for offline
play.

**Two sessions.** The games play in a session of their own so that
interception never touches the API, the app's screens or the site's account
pages. The account's empanadas.io cookies are kept the same in both
(`lib/cookiebridge.js`): copied across before a game starts, and any change
on either side copied to the other, so the games save to the account that is
signed in, and a sign-out reaches both.

**From 1.x.** On the first launch of 2.0, before either session opens, the
games' localStorage (their saves on this computer) is copied from the default
session into `persist:play`, the old offline service workers are removed, and
a player who was signed in stays signed in (the site says otherwise if the
session has ended).

## Testing

- `npm test`: syntax of everything Electron loads, the hardening settings,
  the packaging config, and the unit tests: `test/api.test.js` (the API
  client, PKCE, the offline answers), `test/games.test.js` (finding, syncing
  and serving the games, the cookie bridge), `test/routes.test.js`, and the
  existing updater, signature, URL policy, window and background suites.
- `npm run e2e` (`test/e2e/run.js`): the real app, driven by Playwright,
  against a stand-in for empanadas.io (`test/e2e/fakesite.js`) that serves the
  site's real game files from a checkout of the Empanadas-io repo
  (`EMPANADAS_SITE_DIR`, default `../Empanadas-io/html`) and answers the API
  for a made-up account. It signs in through the browser hand-off (and checks
  a code minted for someone else's challenge is refused), visits every screen,
  plays Spin from the copy on disk (checking the page and its scripts were not
  fetched and the saves reached the site with the account's session), plays
  Flappy with the site unreachable, and signs out. Screenshots of each step go
  to `test/e2e/out/`. Needs a display (`xvfb-run` on Linux) and
  `npm install --no-save playwright`.

## Not done yet

- **Real hardware.** The end-to-end run is on Linux. The Mac and Windows
  title bars, vibrancy, the Dock menu and jump list, and a real browser
  handing `empanadas-io://signin` back are untested on those systems.
- **Windows 11 Mica.** `backgroundMaterial: 'mica'` would give the sidebar
  Windows' own material, as vibrancy does on a Mac; it needs the title bar
  overlay's colours reworked to sit on it.
- **Game Center's desktop equivalent.** Nothing yet: Steam or Xbox
  achievements would be a project of their own.
- **The coffee interstitial.** The website's dashboard shows the "buy a
  coffee" page now and then (`seenAd()`); the native Home doesn't, as the iOS
  app's doesn't. If it should, it would be a card on Home or Settings.
- **The API's name.** `/v2/ios/` serves both apps now. An alias such as
  `/v2/app/` would read better; the apps would move to it once it is live.
