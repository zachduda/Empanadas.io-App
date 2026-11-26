# Empanadas.io for iOS

A native SwiftUI app around empanadas.io, playing the same role the Electron
app plays on the desktop. The games are still the site's. The app adds native
navigation, a native dashboard, leaderboard and Settings screen, browser
sign-in, a full-screen game player, offline support and the iOS integrations
App Review expects.

## What's native and what's web

| | |
|---|---|
| **Tabs**: Home, Games, Leaderboards, Settings | Native. These replace the site's navbar. Moving between them slides the tabs side by side, the new one in from its side of the tab bar: a tap on the tab bar, the app's own changes of tab (a deep link, Home's Play a Game), and a sideways swipe anywhere on a tab's first screen, which follows the finger and goes on to the tab beside it past the middle or with a flick (`App/TabSlides.swift`). The tab bar is still the system's: the slide is the tab bar controller's own custom transition, supplied through its delegate, with SwiftUI's delegate behind it for everything else. A screen pushed on a tab keeps the swipe from the edge for going back; switches, segmented controls and the Spin chart's drag to read a day keep their own sideways drags. Reduce Motion makes it a fade, and on a Mac only the tab bar's taps slide. The navigation bars are the system's own (Liquid Glass on iOS 26, a translucent material before it), in light or dark to match the theme. Over a site page that is dark while the app is light, or the other way round (the navy sign-in and email pages, or the site in another theme), the bars take the page's colour and its light or dark, so their titles, buttons and the status bar stay readable (`pageBars` in `Features/Shared/WebViews.swift`). |
| **Launch** | Over the system's launch screen (plain navy), the desktop app's splash, natively (`Features/Launch/LaunchAnimation.swift`): the empanadas fly in from below and land with a bounce, a warm glow comes up behind them, "Empanadas.io" fades in and down underneath, a little steam rises, and it all fades away into the app, which has been loading underneath meanwhile. About two seconds. A tap skips it, Reduce Motion makes it a fade, and it plays once per launch (a second window on an iPad or a Mac opens without it). The window stays dark while it plays, so the status bar is white on the navy. |
| **Look** | The site's: Poppins, its face (`Shared/Fonts`, SemiBold to ExtraBold, under the OFL beside them, in the app and the widget alike; `Shared/Poppins.swift`), for the navigation bars' titles, the names on the banners, card titles and the big numbers, growing with the text size; body text, lists and controls stay in the system font, as in the desktop app. Poppins's digits are proportional, so a column of numbers to line up keeps the system font. The navigation titles are set once at launch through UIKit's appearance (`NavigationTitles`), font only, so a bar over a dark site page still turns its title white. The site's blue wave banner (`.wave-jumbo`: an indigo-to-blue gradient under `banner-bg.svg`), drawn natively and laid out as the site's CSS lays it out, so the waves fall in the same places (`WaveBanner` in `Features/Shared/Brand.swift`), is behind the heroes of Home, the profiles, Leaderboards and Manage Game Data, the newest post on Updates, and Home's footer ("Made with ❤ by Zach", as the site's dashboard ends). With Increase Contrast it is a shade darker. |
| **Home** | The dashboard, native, from `/v2/app/dashboard.php`: the stats tiles, the daily reward (`Features/Home/DailyRewardCard.swift`: the site's streak banner, a flame for each day of this week claimed, flickering, and Claim for today's peppers, 10 a day and 50 from day 7 of a streak on; claimed at `/v2/app/daily.php`, its status from the dashboard's `daily`), a card per game with its meter, the Spin Progress chart (Swift Charts: total or per day, 1W to All, drag to read a day) with Manage Game Data under it, friends and who is online, experience and rank, and pumpkins in September and October (by the clock in New York, as the site decides; `PumpkinSeason`, which asks the clock rather than the answer on screen, so one saved in October and shown offline later has none). The hero carries the site's "Almost there!" box (verify the address, then add a picture), and the site's footer closes the screen. My Profile, Find Friends and friends' profiles are native screens pushed on top; the profile picture and email verification open the site's pages. Refreshes once a minute while showing, less often the longer nothing changes (up to five minutes; a change or pulling down puts it back to one), and after a game closes. |
| **Profiles** | Native, from `/v2/app/profile.php` (`Features/Profile/`). My Profile: picture (opens the site's picture page), name and badges, member since, the status line (edited natively), friend requests to accept or decline, requests sent to take back, friends with who is online and Unfriend, experience and what earned it, game stats and star sign. Kept on the device for offline, like the other tabs. Someone else's is kept in memory for the session, so opening it again shows it at once and asks only if it is over a minute old; they all go when a friend is added or let go, and at sign-out. Someone else's: the same as the site shows you, under its rules (a friends-only profile shows a stranger only the name and picture), with Add Friend or Accept/Decline on the banner under the name, where they stand with you in the site's words, and Request Sent and Friends as menus offering Cancel Request and Unfriend. On the banner too: a phone's hero is centred, as the site's is on one (the picture beside the name on a wide window), with their friends, XP and peppers earned at a glance. Opened from Home, a leaderboard row, Settings' View Profile, a friend, a search result, any link to `/v2/profile/<id>` in a site page, or a deep link. Changes go through `/v2/account_edit.php` as on the web. |
| **Manage Game Data** | Native (`Features/Home/SavePointsView.swift`), from "Missing or overwrote your progress?" under the Spin Progress chart, as on the site's dashboard: the save points the site keeps as the Spin Game saves (about once a session and once a day), newest first and more as you scroll, each with its prestige, ascensions, manual spins, peppers and Flappy and Tower bests against the account now (higher or lower). Picking one shows what each number becomes and asks before overwriting. The site keeps the progress it replaces as a new save point first, so a restore can be undone from the same list. Older "Spin Only" save points put back the Spin Game alone; one from before an anti-cheat reset can't be restored, and the site allows one restore every 30 seconds. It reads and restores through the site's own `/v2/gamehistory.php`, the endpoint the web dialog uses, with the session's csrf token; the games take the restored saves the next time they open (their `Restore_Id`), and Home refreshes. |
| **Messages** | Native (`Features/Messages/`), direct messages between friends from the site's `/v2/app/messages.php` (the site's `docs/MESSAGES.md`). From the Messages button beside the bell on Home, which carries the unread count (the dashboard's, then the screens' own as they read), and Message on a friend's profile banner; links to `/v2/messages` and `empanadas-io://messages[/<id>]` open it too. The inbox: each conversation's last message, when, and how many are unread, newest first, asked for again every 20 seconds while it shows; New Message picks one of your friends; players you blocked are listed under it to unblock. A conversation: bubbles, yours on the right in the accent colour, the time between messages far apart, Seen under your last once they've read it, older messages as you scroll up, and what's new every 4 seconds while it shows (marked read once it's on screen). A message shows at once, greyed until the site has it; one that didn't go says why, with Try Again (the same nonce, so the site keeps it once) or Delete. Touch and hold a message to copy it, or report one you received (spam, harassment, inappropriate, something else, with an optional note), after which Block is offered; the menu under their picture has View Profile and Block/Unblock. Friends only, as the site decides: an old friend's conversation stays, without the box to type in, and says why. Everything a player wrote is shown as text (`Text(verbatim:)`). Report and Block are what App Review's guideline 1.2 asks of an app with content between players. |
| **Find Friends** | Native search as you type, from `/v2/app/search.php`, with exact matches first and more as you scroll. Each result says where you stand (friends, request sent, wants to be your friend, private, not taking requests) and has Add or Accept on it. |
| **Send Feedback** | Native form (`Features/Feedback/`), from `/v2/app/feedback.php`: the site's feedback subjects (an animated profile picture request too, for supporters, which asks for a link to the .gif), the message with the site's length limits, and "I'd like a reply" with the address it goes to. Sent through `/v2/account_edit.php` as the web form sends it. Opened from Settings, and in a sheet from any link to `/v2/feedback` in a site page (over the game for Spin's Report a Problem, with its subject picked) or a deep link. Against a site without the endpoint yet it falls back to the web form's subjects. |
| **Updates** | Native (`Features/Updates/`): the site's announcements, from the bell at the top of Home. It reads the public API the site's Updates page reads, `api.empanadas.io/v1/updates.php`, one post a request as that page does, so there is no `/v2/app/` endpoint for it. Newest first, a card per post (title, who posted it and when, the post), the newest with its title and byline on the wave banner as the site's Updates page shows a post, and a post opened on its own the same, the next one read as the end comes into view, and the ones posted since the player last looked marked New. The bell has a red dot while there is one: Home asks as it shows, at most every ten minutes (the time the site caches the answer for), and opening Updates clears it. What the player has seen is the newest post's id, kept on the device; the first time, the newest counts as seen, as the site has a new account start with everything read. Posts are written as HTML in the admin panel: `PostHTML` (`Core/UpdatesData.swift`) reads the part of HTML they use (paragraphs, bold, italics, links, headings, lists, quotes, pictures) into native text, so they follow the text size and light and dark; an embedded video becomes a link to it, and scripts and styles are dropped. A link in a post opens the app's own screen where there is one, another site page in a sheet, and anything else in Safari. Links to `/updates` and `/updates?post=<id>` from any site page open it too. |
| **Games** | Native (`Features/Games/GamesView.swift`): **Jump Back In** for the game played last, then a card per game with when it was last played here ("Played 2 hours ago"), the player's place on its leaderboard, and three of their numbers in it from the dashboard (Spin's spins, prestige and ascensions; Flappy's and Tower's best, last and rounds). When each game was last played is kept on the device (`Core/PlayHistory.swift`), since the site keeps no such time, and goes at sign-out; a game played only on the website shows no time. Holding a card offers its leaderboard (the Leaderboards tab, on that board), Game Center and Report a Problem. At the bottom, Leaderboards and Send Feedback, the same screen Settings opens. Each game opens in a full-screen web player. Flappy and Tower use their own close button, which closes the player. Spin draws one only in the app (`data-app-close` in `spin.html`, reported through `bridge.js`); until a game says it has one, or if it fails to load, the player shows a native one. Leaving a game for the homepage or the dashboard closes the player, and a game's links to other site pages (Spin's account button, Report a Problem) open in a sheet over it. The games draw edge to edge (`viewport-fit=cover`) and keep their controls out of the camera housing and the home indicator. |
| **Leaderboards** | Native, from `/v2/app/leaderboard.php`: Spin, Flappy and Tower, under the site's banner, which says how fresh the boards are and the player's place on each of the three, and picks the board, with medals for the top three and the player's own row marked. Refreshes while showing, at the pace the site's cache rebuilds, and not before the next rebuild when the tab comes back on screen. Rows open the player's native profile. The **Game Center** button opens the same board in Game Center. |
| **Game Center** | Three Game Center leaderboards, ranked as the site's are: lifetime spins, best Flappy round, tallest Tower (`Core/GameCenter.swift`). The scores are the site's, not the games': every fresh dashboard posts whichever changed since the last post, so a best set on the website or the desktop app gets there too. Signs in to Game Center once the player has signed in to the app; a player not signed in to Game Center is offered GameKit's sign-in from Settings or the Leaderboards tab, never unasked. The Spin Game's 29 achievements are Game Center achievements too: the dashboard lists the ones the site has saved (so one earned on the website or the desktop app unlocks here as well), and the game tells the app the moment one is earned in it (`window.empanadasApp.achievement`), so Game Center's banner comes up mid-game. Settings shows the Game Center name and has **Post Scores to Game Center** to stop posting scores and achievements. |
| **Settings** | The account (picture, name, address) and native controls for theme, privacy and email preferences, read from `/v2/app/account.php`. The theme is the account's, so it is also read as the app comes to the front (at most every five minutes, and the answer is the Settings screen's too), and applied to the whole window. Also has sign out, delete account (a native modal: type DELETE), haptics, clear cache, the version and Send Feedback. Email/username, connections, passkeys, 2FA and the profile picture open the site's own pages. |
| **Sign-in** | Native welcome screen (`Features/SignIn/WelcomeView.swift`), on the launch screen's navy: the login page's "Got an account?", with **Yup! Log In** and **Nope. Create One**. Either opens the whole sign-in in the system browser (`ASWebAuthenticationSession`, sharing Safari's cookies), on the site's own pages: the username step or Pick a Username, passkeys, Google/GitHub/Discord and 2FA, with Safari's AutoFill and the player's iCloud Keychain passkeys. A browser already signed in to Empanadas.io asks "Continue as …?" instead. The site hands the sign-in back with `empanadas-io://signin?code=`, and the app redeems the code at `/v2/app/signin.php` with the PKCE verifier only it holds (`Auth/AppSignIn.swift`). The login page never shows in a web view of the app's: a page that goes there is stopped, and the app asks the site whether the session ended (`loginPageReached` in `App/AppModel.swift`). Sign Out loads `/v2/auth/logout.php` out of sight, and again later if it could not reach the site. |
| **Popups** | Captcha and other script-opened windows of the signed-in pages open in a sheet, limited to the site, the providers and the SSO hosts. Connect Google/GitHub/Discord on the account page goes through the system browser too, using the site's provider hand-off (`/v2/auth/browser.php`, `empanadas-io://auth`). |
| **Quick actions** | Play Flappy / Spin / Tower from the Home Screen icon, the game played last first and marked "Jump back in". The app sets them from the play history (`QuickActions.show` in `App/EmpanadasApp.swift`) rather than listing them in Info.plist, so they appear once the app has been opened signed in, and go at sign-out. |
| **Widget** | A Home Screen widget (`EmpanadasWidget/`): small, the game played last to jump back into, with its first number and when; medium, all three side by side. Game names and numbers in Poppins, which the widget bundles and registers itself. A tap opens the game (`empanadas-io://play/<game>`). It has none of the app's code or data: the app writes what it shows (`Shared/GamesSnapshot.swift`) to the App Group `group.io.empanadas.app` the two share, whenever the dashboard's numbers or the play history change, and only then asks it to redraw (`Core/HomeScreenWidget.swift`). Signed out, it asks the player to sign in. |
| **Haptics** | The games' own `navigator.vibrate()` calls (a manual spin, a Flappy crash, a Tower slip or topple) play native haptics: WebKit on iOS has no Vibration API, so `Resources/bridge.js` fills it in, and the Haptics switch in Settings turns it off. Pages can also call `window.empanadasApp.haptic(style)` directly. Tested by `test/iosbridge.test.js` (`npm test`). |
| **Offline** | Home, Leaderboards and Settings keep their last good answer on the device (`Core/OfflineStore.swift`) and open with it at launch and without a connection, saying when it was saved. Settings can't be changed offline. Profile pictures are cached on disk, and one checked with the site in the last day is drawn from there without asking (`PictureFreshness` in `Core/LocalCache.swift`); the player's own is asked for again after a visit to the picture page. How old each screen's answer may be before it asks again by itself is in one place (`CacheAge`), and in Low Data Mode the screens only refresh when pulled down. Every game is saved for offline play as soon as the app is open, signed in, with a connection (`Web/OfflineGames.swift`): a web view nobody sees, on a blank page of the site's, fetches each game's page and every stylesheet, script, picture, sound and font it loads into WebKit's cache, and a game opened offline starts from there. The files are found from the games themselves (`Core/OfflineAssets.swift`: the pages, then what they name, then what their stylesheets and scripts name), plus the sounds and pictures Spin builds the path of in script. It is brought up to date at most every six hours, as the app comes to the front, signs in or gets a connection, asking the site only whether each file changed; not in Low Data Mode. Settings shows whether it is done (**Offline Games**), and Clear Cache saves them again. The games keep their saves on the device and sync them when back online. Everything refreshes when the connection returns. |
| **iPad and Mac** | One app for iPhone and iPad, which also runs on Apple silicon Macs as an iPad app, in a window that can be as wide as the display. On a wide window the native screens stop growing and centre: the dashboard and profiles at 1100 points, in two columns of cards that each go to the shorter column, and the games there too, three across; lists, forms and search at 720 (`ReadableWidth` in `Features/Shared/Components.swift`). The stat tiles and game cards fill their rows evenly rather than leaving holes (`BalancedGrid`). The share sheet is a popover there, and Settings' questions point at the button that asked. Narrower than that, as in Split View, they are the phone's screens. |
| **Deep links** | `empanadas-io://home`, `://leaderboard`, `://settings`, `://play/<game>`, `://profile`, `://profile/<id>`, `://friends`, `://messages` (`/<id>` for the conversation with that player), `://feedback` (`?reason=<subject>`) and `://updates` (`/<id>` for one post) open native screens. `://signin?code=` finishes a sign-in the app started, and `://auth?...` connecting a provider, each only while one is under way. Anything else is ignored. |

The navigation rules (`Core/SiteURLs.swift`) port `lib/urls.js` one-for-one,
and the tests port `test/urls.test.js`. If you change a rule on one side,
change it on the other.

## Building

You need a Mac with Xcode 16 or later, and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
The Xcode project is generated from `project.yml` and is not checked in.

```sh
brew install xcodegen
cd ios
xcodegen generate
open Empanadas.xcodeproj
```

The signing team is set in `project.yml` (`DEVELOPMENT_TEAM`): it has to be
the one the site's apple-app-site-association names for passkeys to work.
The code is Swift 6, with complete concurrency checking: a data race is a
compile error, and anything not on the main actor that touches the UI is
caught at build time.
Then run on a simulator or a device. To run the unit tests, use ⌘U, or:

```sh
xcodebuild test -project Empanadas.xcodeproj -scheme Empanadas \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

The `iOS` GitHub Actions workflow does the same on every change under `ios/`,
on an iPhone simulator and again on the largest iPad one.

Both runs also draw the native screens with a made-up account
(`EmpanadasTests/ScreenshotTests.swift`): the iPhone's own screen, and on the
iPad its screen both ways round, Split View and a 1600-point Mac window. They
are uploaded as the run's **screenshots** artifact, for checking a layout
change at every size without a device. To draw them locally, give the test a
folder (it signs the simulator's copy of the app in as the made-up account,
so it is skipped otherwise):

```sh
TEST_RUNNER_SCREENSHOTS_DIR=/tmp/screenshots xcodebuild test -project Empanadas.xcodeproj \
  -scheme Empanadas -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' \
  -only-testing:EmpanadasTests/ScreenshotTests CODE_SIGNING_ALLOWED=NO
```

## Before it works end to end

The site changes the app depends on are in zachduda/Empanadas-io#70 (the
user agent and browser sign-in) and the site's `html/v2/app/` directory, the
native apps' own JSON API (`account.php`, `dashboard.php`, `leaderboard.php`, `messages.php`,
`profile.php`, `search.php`, `feedback.php` and `signin.php`), which the
desktop app uses too. They take effect once deployed: until they are live,
the screens that read them say they couldn't load (HTTP 404).
[SITE-CHANGES.md](SITE-CHANGES.md) lists what is still open.

The API was at `html/v2/ios/` until the desktop app used it as well. The site
still answers there (each file is an alias of its `/v2/app/` one), for builds
from before the move. This app asks `/v2/app/`, and only when the site answers
that with nginx's own 404 page (a site from before the move) does it ask the
same of `/v2/ios/`, and keep doing so for an hour before trying `/v2/app/`
again (`sendNative` in `Core/AccountAPI.swift`). So a build can ship before or
after the site is deployed.

Signing in needs the site's `html/v2/auth/app.php` and `html/v2/app/signin.php`
(or `html/v2/ios/signin.php` on a site from before the move; SITE-CHANGES.md
§9). **Deploy those before shipping a build of the app with the welcome
screen**: against a site without them, the browser opens on a 404 and nobody
can sign in.

## Before submitting to the App Store

- Set up Game Center (below).
- Register the App Group `group.io.empanadas.app` for the team, with the
  app (`io.empanadas.app`) and the widget (`io.empanadas.app.widget`) in it.
  Xcode's automatic signing usually does this the first time it signs both
  with the group in their entitlements; Xcode Cloud needs the widget's App ID
  to exist too. Without the group the widget only ever asks to sign in.
- Turn on Sign in with Apple (SITE-CHANGES.md §6). The coffee links are
  already gone in the app.
- Check `Resources/PrivacyInfo.xcprivacy` against the privacy policy, and fill
  in the matching App Privacy answers in App Store Connect.
- Replace the app icon if you want a dedicated one. The current one is
  `icon.png` from the desktop app, scaled up.
- Add screenshots, a description, a support URL and a privacy policy URL in
  App Store Connect. The screenshots (iPhone 6.9" and iPad 13") and the
  iOS 27 creative assets (product page header, search results) are in
  [AppStore/](AppStore/README.md).
- Licensing: the repo is GPL-3.0, and App Store terms are widely considered
  incompatible with the GPL for code the publisher doesn't own outright. As
  the copyright holder you can publish your own code. Be careful with outside
  contributions to `ios/` (for example, require a CLA, or license `ios/`
  separately).

## Game Center

The app has the Game Center entitlement (`Resources/Empanadas.entitlements`),
so automatic signing turns the capability on for the App ID. The leaderboards
themselves live in App Store Connect: in the app's Game Center settings, add
three **Classic** leaderboards with these IDs (`gameCenterLeaderboardID` in
`Core/GameCenter.swift`; an ID can never be changed or reused once made):

| Leaderboard ID | Name | Score format | Submission | Sort | Suffix |
|---|---|---|---|---|---|
| `io.empanadas.app.leaderboard.spin` | Most Manual Spins | Integer | Best Score | High to Low | spins |
| `io.empanadas.app.leaderboard.flappy` | Best Flappy Scores | Integer | Best Score | High to Low | points |
| `io.empanadas.app.leaderboard.tower` | Tallest Towers | Integer | Best Score | High to Low | floors |

Spin's score is the lifetime total, which only grows, so Best Score always
shows the latest. Then, on the version's page, tick **Game Center** and add
the three leaderboards to it: a leaderboard goes live with the first version
that includes it. Until they exist, posting fails quietly (and is tried again
with the next dashboard) and the Game Center button has no board to show;
nothing else in the app depends on them.

To try it before release, run a development build on a device signed in to
Game Center (it posts to Game Center's sandbox, not the live boards), play a
round, and the score shows on the board once the dashboard has refreshed.

### Achievements

The Spin Game's achievements (`SpinAchievement` in `Core/GameCenter.swift`,
from `givea()` in the site's `_spin.js`) need adding the same way, in the
app's Game Center settings under **Achievements**. Each is one achievement,
not achievable more than once, with the ID below; the titles and earned
descriptions are the site's own, without its markup. The points come to
905 of Game Center's 1,000, leaving room for more. Each also needs a
square image (512×512 or 1024×1024); the game's trophy or medals will do.

| Achievement ID | Title | Points | Hidden | Pre-earned description | Earned description |
|---|---|---|---|---|---|
| `io.empanadas.app.achievement.spin.first_spin` | The Start of Spin | 5 | No | Make your very first spin. | Make your very first spin! They grow up so fast. |
| `io.empanadas.app.achievement.spin.first_medal` | A Shiny Beginning | 10 | No | Earn a medal in the Spin Game. | Earn your very first Medal! |
| `io.empanadas.app.achievement.spin.one_thousand` | Ice Cold Spinner | 10 | No | Surpass 1,000 spins. | Surpass 1,000 spins. Way to go superstar! |
| `io.empanadas.app.achievement.spin.ten_thousand` | 10 Karats of Gold | 20 | No | Surpass 10,000 spins. | Surpass 10,000 spins! That's the spirit! |
| `io.empanadas.app.achievement.spin.fifty_thousand` | Half-done Baking | 30 | No | Achieve 50,000 spins. | Achieve 50,000 spins! You're halfway to Prestiging! |
| `io.empanadas.app.achievement.spin.prestige_one` | 1st Time Letting Go? | 30 | No | Prestige for the first time. | Starting over helps bring new beginnings. Your first prestige! |
| `io.empanadas.app.achievement.spin.prestige_two` | I've Been Here Before | 20 | No | Prestige twice. | Prestige for a second time! It's starting to click, huh? |
| `io.empanadas.app.achievement.spin.prestige_five` | High Five Steaks | 30 | No | Reach your fifth Prestige. | Your fifth Prestige! Not all cowboys have their boots. |
| `io.empanadas.app.achievement.spin.prestige_ten` | Hang Ten | 40 | No | Reach your tenth Prestige. | Your tenth Prestige! The sky is your limit, and the clouds await. |
| `io.empanadas.app.achievement.spin.prestige_twentyfive` | The Strive for Twenty-Five | 50 | No | Reach your 25th Prestige. | Have you tried turning it off and back on again 25 times? Well, you have. |
| `io.empanadas.app.achievement.spin.prestige_fifty` | Halfway Finished or Halfway Started? | 60 | No | Reach your 50th Prestige. | The clouds are the closest and farthest yet. I'm sure you'll Ascend in no time. |
| `io.empanadas.app.achievement.spin.prestige_hundred` | A Tough Choice | 80 | No | Reach your 100th Prestige. | You've been here 100 times. The choice is yours. You were made to answer this calling. |
| `io.empanadas.app.achievement.spin.ascend_one` | Answer The Call | 80 | No | Ascend for the first time. | You chose to answer your sacred calling in the sky. Sacrificing everything for the good of humanity. |
| `io.empanadas.app.achievement.spin.ascend_two` | The Phone Rings Twice | 50 | No | Ascend twice. | You've answered your calling to the clouds twice. Many cannot boast such brave acts of selflessness. |
| `io.empanadas.app.achievement.spin.ascend_three` | Loud and Clear | 50 | No | Ascend three times. | No temptation will curb your dedication. After all, the third time is the most charming of them all. |
| `io.empanadas.app.achievement.spin.ascend_four` | Four Score & 400 Prestiges Ago | 50 | No | Ascend four times. | An even number: 4. Will this be enough to sate your appetite for success? What more is there to prove? |
| `io.empanadas.app.achievement.spin.ascend_five` | The Inevitable Fall | 60 | No | Ascend five times. | This was never for Empanadas, was it? You have your own motives. Your actions have dire consequences. |
| `io.empanadas.app.achievement.spin.ascend_hundred` | A Cry for Help | 100 | Yes | Ascend 100 times. | You've ascended 100 times. That's concerning. Very concerning. |
| `io.empanadas.app.achievement.spin.ascend_one_thousand` | Cheater Cheater Empanada Eater | 10 | Yes | Ascend 1,000 times. | You cheated. Right? Please tell me you cheated. |
| `io.empanadas.app.achievement.spin.superstar_spinner` | Superstar Spinner | 20 | No | Spin over 10 times a second for a while. | Way to go Superstar! You spin empanada dough quite fast with your hands. |
| `io.empanadas.app.achievement.spin.first_autospinner` | Wait! We have Technology | 10 | No | Buy your first Auto Spinner. | Use the power of mindless robots to bake your Empanadas for you. |
| `io.empanadas.app.achievement.spin.first_burnt` | Forgot the Oven | 5 | No | Burn an Empanada. | Burn your first Empanada. There there, it happens to the best of us. |
| `io.empanadas.app.achievement.spin.second_burnt` | The Zap Strikes Back | 5 | No | Burn two Empanadas. | Clumsy or careless? Your poor empanada didn't need to be burnt twice. |
| `io.empanadas.app.achievement.spin.ten_burnt` | Be At-Ten-tive | 10 | No | Burn 10 Empanadas. | You've burnt through a lot of dough! 10 burnt to be exact. |
| `io.empanadas.app.achievement.spin.twentyfive_burnt` | House Fire | 15 | No | Burn 25 Empanadas. | Your unattended oven caught the house on fire! Guess that's your karma for burning 25 empanadas. |
| `io.empanadas.app.achievement.spin.onehundred_burnt` | Pyromaniac | 25 | No | Burn 100 Empanadas. | You have burnt 100 empanadas. Guess cooking isn't really your thing, huh? |
| `io.empanadas.app.achievement.spin.gimme_space` | Give Me Some Space | 10 | Yes | Find another way to spin. | Magical! Use the space-bar to earn spins. |
| `io.empanadas.app.achievement.spin.debug_nerd` | Nerding Out | 10 | Yes | Find the debug menu. | You discovered the debug menu, for nerds. 6 figure salary, here you come! |
| `io.empanadas.app.achievement.spin.buy_extinguisher` | Feel the Burn! Or don't! | 10 | No | Buy your first Extinguisher. | Your first extinguisher, just to be safe. |

Then add them to the version's Game Center section with the leaderboards.
An achievement goes out once per Game Center player (the app remembers which
it has reported), with Game Center's banner when it is earned in the app's
Spin player and quietly when it comes from the dashboard or a save loading in
the game (earned earlier, or somewhere else). One the site adds later is skipped until it is in
`SpinAchievement` and App Store Connect both.

## Next steps

- **Offline play from the site's service worker.** The games are saved into
  WebKit's HTTP cache (`OfflineGames`), which serves a file the game asks
  for while its page loads however old it is, but one asked for later (a
  sound the first time it plays) only while the site's caching headers say it
  is fresh. The desktop app uses the site's service worker instead (`sw.js`,
  `lib/offline.js`), which serves every saved file offline. WKWebView only
  runs service workers for App-Bound Domains (`WKAppBoundDomains`), which also
  blocks script injection in every web view not limited to those domains, so
  it needs testing on a device against the sign-in popups before it ships.
- **Push notifications** for friend requests and messages. Messages are only noticed while the app is open (the dashboard's count and the Messages screens' polling); a message arriving with the app closed needs APNs, and a site that sends them.
