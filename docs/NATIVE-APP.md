# The native desktop app (2.0)

Up to 1.12 the desktop app was empanadas.io in a window: a splash page, then
the website, with window buttons drawn into its pages. From 2.0 the app's
screens are its own, the way the iOS app's are, and the games are kept on the
computer. The games themselves are still the site's.

## What's native and what's web

| | |
|---|---|
| **Window** | A sidebar (Home, Games, Leaderboards, Friends, Messages, My Profile, and your account at the bottom for Settings) and a title bar of the app's own: Back, the screen's title, Refresh and the Updates bell (Return to a game kept in the background too). Each place is there once: your account is the sidebar's, not also a menu in the title bar. On a Mac the system's traffic lights sit inset in it and the sidebar is the translucent sidebar material (`vibrancy: 'sidebar'`); on Windows the system's own minimize, maximize and close (with Snap Layouts) are drawn over it (`titleBarOverlay`); on Linux the window has its normal frame. System fonts and system-sized controls; Poppins only for the brand and the big numbers. Light and dark follow the system or the account's theme (`nativeTheme`). |
| **Sign-in** | Native welcome screen: "Got an account?", **Yup! Log In** or **Nope. Create One**. Either opens the whole sign-in in the player's own browser, at the site's `/v2/auth/app.php`, where their password manager, passkeys and Google/GitHub/Discord sessions already are. The site hands it back with `empanadas-io://signin?code=`, and the app redeems the code at `/v2/app/signin.php` with the PKCE verifier only it holds (`lib/signin.js`). The same arrangement as the iOS app; the login page never shows inside the app. |
| **Home** | The dashboard, from `/v2/app/dashboard.php`: stat tiles, the daily reward under them (`shell/js/daily.js`: the streak, this week of it with a flickering flame for each day claimed, on the hero's wash and bubbles, and Claim for today's peppers, 10 a day and 50 from day 7 of a streak on; its status is the dashboard's `daily`, the claim goes to `/v2/app/daily.php` through `claimDaily` in main.js), a card per game (its symbol on its colour, as in the iOS app) with its meter and a Play button, the Spin Progress chart (total or per day, 1W to All, hover to read a day), pumpkins only in September and October (by the clock in New York, as the site decides: `pumpkinSeason()` in `shell/js/format.js`, which your profile's stats use too, asks the clock rather than the answer on screen, so one saved in October has none in November), experience and rank with what earned it (the dashboard's `xp.breakdown`, as a profile has it, so Home asks for nothing more), friends and who's online, and the friend requests waiting. Refreshed every few minutes while the app is open (`startDashboardPoll()`), and after a game closes. |
| **Games** | Jump Back In for the game played last, then a card per game: when it was last played on this computer, your place on its leaderboard, three of your numbers, and whether it's downloaded for offline. Right-click for its leaderboard or Report a Problem. |
| **Leaderboards** | Spin, Flappy and Tower from `/v2/app/leaderboard.php`, medals for the top three, your row marked; a row opens that player's profile. Refreshes at the pace the site's cache rebuilds. |
| **Friends** | Find Friends (search as you type, `/v2/app/search.php`) with Add, Accept, Cancel and Unfriend on each result; then requests to answer, your friends (online first, each with a Message button) and the requests you sent. |
| **Messages** | Direct messages between friends, from `/v2/app/messages.php` (the site's `docs/MESSAGES.md`; `shell/js/screens/messages.js`): the inbox beside the conversation open in it. Each conversation's last message, when, and how many are unread; the conversation itself, newest at the bottom, with Load Earlier Messages, the time between messages far apart, and Seen under your last one once they've read it. Return sends, Shift+Return is a new line; a message shows at once and goes greyed until the site has it, and one that didn't go says why with Try Again (the site stores a retry once, by the message's nonce). An open conversation asks for what's new every 4 seconds while the window is showing, the inbox every 20; reading a conversation marks it read. New Message picks one of your friends. Right-click a message (or its … button) to copy it or report it (spam, harassment, inappropriate, something else, with an optional note), then offered Block; the conversation's … menu has View Profile and Block/Unblock, and players you blocked are listed under the inbox to unblock. Friends only, as the site decides: an old friend's conversation stays, without the box to type in, and says why. A friend's profile has Message too. The sidebar shows the unread count, the Dock badge adds it to the friend requests, and a new message while the window isn't in front is a notification (the sender and the message's start; checked every minute, `MESSAGES_POLL`), which opens the conversation. |
| **Profiles** | Yours and anyone's, from `/v2/app/profile.php`, under the site's privacy rules: picture, badges, presence, status line (edit your own in place), experience and what earned it, stats, star sign, friends. |
| **Settings** | One screen, from your account at the bottom of the sidebar (Settings… in the app menu, ⌘, / Ctrl+,). First the account, from `/v2/app/account.php`: theme, privacy and email settings saved as they change (`account_edit.php`, as the account page saves them), and Save Points. Email and username, connections, passkeys, two-factor and the profile picture open the site's own pages, in a window of their own, signed in as the app is. Then the app's own (`shell/js/screens/appsettings.js`), which needs no account and no connection, so it shows offline and when the site can't load the account: Check for Updates (with download progress); Keep Spinning When Closed; notifications (friend requests and messages); the cache (its size, Clear Cache); the games on this computer (check now, download again); and the versions: the app, Electron, Chromium, Node.js, V8, the system, which copy of the screens is showing (App Components), and the user agent, with Copy for a bug report. Then Server Status: the site's status light (Statuspage's indicator, as the site's Updates page and the iOS app show it), pulsing while it is live and checked every minute, and the full status page behind it in a sheet over the window: the app's own title bar (Back, Open in Browser, Done) over Statuspage's page, kept in a session of its own in memory, with Subscribe and Powered by left out, and links off it opened in the browser. Last, Send Feedback and the site's pages, Sign Out, and Delete Account (type DELETE). App Settings used to be a screen of its own; `empanadas-io://appsettings`, and the App Settings… menu item of apps from before, open Settings at the app's part. |
| **Save Points** | Native, from the site's `/v2/gamehistory.php`: each save point against your account now, and Restore (undoable, as on the site). |
| **Updates** | The site's announcements (`api.empanadas.io/v1/updates.php`), with New on the ones since you last looked and a dot on the bell. Posts are HTML from the admin panel; `shell/js/sanitize.js` rebuilds the parts they use and drops everything else. |
| **Send Feedback** | Native form from `/v2/app/feedback.php`, sent through `account_edit.php`. Spin's Report a Problem opens it with the subject picked. |
| **Games** (playing) | The site's own pages, in a view over the window below the title bar, which keeps **Home** (closes the game; ⌘W / Ctrl+W too) and a full-screen button. A game's own close button closes it. A game's link to one of the app's screens (a profile, Report a Problem) shows that screen with **Return to Spin** in the title bar; any other page of the site opens in a site window, anything else in the browser. |
| **Offline** | Home, Leaderboards, your profile and Settings open with their last answer and say when it was saved. The games start from the computer without a connection, from their own saves, and sync when it's back (the games already do this). |
| **System** | Native menus with shortcuts (⌘1–6 / Ctrl+1–6 for the sections in the sidebar's order, Messages on 5 and My Profile on 6, ⌘F Find Friends, ⇧⌘1–3 to play), Play Spin / Flappy / Tower in the Dock menu and the Windows jump list (last played first), the Dock badge for friend requests and unread messages, a notification for a new one of either while the app is in the background, and native context menus. `empanadas-io://` links open screens: `://home`, `://games`, `://leaderboard`, `://friends`, `://messages[/<id>]`, `://profile[/<id>]`, `://settings`, `://appsettings` (Settings, at the app's part), `://feedback[?reason=]`, `://updates[/<id>]`, `://play/<game>`. |
| **Loading screen** | At launch, the 1.x splash is back (`Content/Loading/`, on `app://loading`): the logo, steam and a progress bar while the app checks the site for a newer copy of its screens and fetches what changed. Always the app's own copy. |
| **Keep Spinning When Closed** | As before: closing the window during Spin with it on hands the game to the tray or menu bar (`lib/background.js`). |

## How it fits together

```
main.js ─┬─ default session ──── app://shell (shell/: the screens)
         │                   ├── lib/api.js ──────────── empanadas.io /v2/app/*, account_edit.php, gamehistory.php
         │                   └── site windows ────────── the site's account pages
         │
         └─ persist:play ─────── the game view ───────── https://empanadas.io/spin …
                             └── lib/gameprotocol.js ─┬─ lib/gamebundle.js (files on disk)
                                                      └─ the network (saves, clock, anything not kept)
```

**The API.** `lib/api.js` is the main process's client for the site's native
API, `/v2/app/*`, the same endpoints the iOS app draws its screens from. Each
answers JSON to any app that brings a signed-in session, checking only the
session cookie and the user agent it signed in with. They were at `/v2/ios/`
until the desktop app used them too; the site still answers there (each file
is an alias), and the app falls back to that address, for an hour at a time,
when the site answers a plain 404 for `/v2/app/`, so it works whichever of the
app and the site is updated first. The desktop app
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

**The screens over the air.** The screens (`shell/`) ship in the app, and
that copy always works, but the site can have a newer one:
`html/Content/Desktop/v<SHELL_API>/` in the site's repo, the same files at
the same paths (and `images/` or `fonts/` to replace the app's own). At
launch, behind the loading screen, `lib/resources.js` asks
`/v2/app/resources.php?shell=<SHELL_API>` for the SHA-256 of each file there,
fetches only the ones whose hash it doesn't already have (from
`/Content/Desktop/v1/<path>?v=<hash>`, so no cache hands back an old one),
keeps a file only if it hashes to what the list said, and switches to the
new set in one rename once all of it is on disk. They are kept in
`<userData>/Resources`, by hash, like the games. The check gets six seconds;
after that the app starts with what it has and the check finishes for the
next launch. Offline, it starts with what it has at once.

The site's copy is used only when:

- it is for this app's `SHELL_API` (in `main.js`): the contract between the
  screens and the native half. Bump it whenever the screens need a new IPC
  channel or preload function; the new screens then go in a new folder, so
  older apps never get screens they can't run.
- it was published from this app's version or a later one (`_release.json`,
  written by `scripts/publish-resources.js`). After an app update, the
  bundled screens are at least as new as an older set, so they win.
- it starts: the screens call `native.ready()` once drawn. A set from the
  site that doesn't within 15 seconds (a bad deploy, a file missing), or
  whose page crashes first, is replaced by the app's own at once and never
  tried again; the next revision on the site is.

What never comes from the site: `main.js`, the preloads (the only code that
can reach the main process, and every IPC call is still checked there), the
loading screen, and the content security policy, which `main.js` sets on
every page whatever the page says. The files only ever come from
`https://empanadas.io`. Settings → About This App → App Components shows which copy is showing.

To publish: `node scripts/publish-resources.js ../Empanadas-io` copies
`shell/` into the site's folder (`--with-content` adds the pictures and
fonts), then commit and deploy the site. After that, editing the files on
the site is enough: the list is worked out from the folder on each request.
Run it again after every app release. Running from source the site's copy
is off unless `EMPANADAS_RESOURCES=on`; `EMPANADAS_RESOURCES=off` turns it off
in an installed app.

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
  and serving the games, the cookie bridge), `test/routes.test.js`,
  `test/resources.test.js` (the screens over the air), `test/format.test.js` (the screens' numbers and dates, and pumpkin season), and the existing updater, signature, URL policy, window and background suites.
- `npm run e2e` (`test/e2e/run.js`): the real app, driven by Playwright,
  against a stand-in for empanadas.io (`test/e2e/fakesite.js`) that serves the
  site's real game files from a checkout of the Empanadas-io repo
  (`EMPANADAS_SITE_DIR`, default `../Empanadas-io/html`) and answers the API
  for a made-up account. It signs in through the browser hand-off (and checks
  a code minted for someone else's challenge is refused), checks the loading screen
  fetches a change deployed to the site's copy of the screens and shows it,
  visits every screen,
  plays Spin from the copy on disk (checking the page and its scripts were not
  fetched and the saves reached the site with the account's session), plays
  Flappy with the site unreachable, and signs out, then launches again with
  a broken deploy of the screens and checks the app falls back to its own. Screenshots of each step go
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
