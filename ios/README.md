# Empanadas.io for iOS

A native SwiftUI app around empanadas.io, playing the same role the Electron
app plays on the desktop. The games are still the site's. The app adds native
navigation, a native dashboard, leaderboard and Settings screen, browser
sign-in, a full-screen game player, offline support and the iOS integrations
App Review expects.

## What's native and what's web

| | |
|---|---|
| **Tabs**: Home, Games, Leaderboard, Settings | Native. These replace the site's navbar. The navigation bars are the system's own (Liquid Glass on iOS 26, a translucent material before it), in light or dark to match the theme. Over a site page that is dark while the app is light, or the other way round (the navy sign-in and email pages, or the site in another theme), the bars take the page's colour and its light or dark, so their titles, buttons and the status bar stay readable (`pageBars` in `Features/Shared/WebViews.swift`). |
| **Home** | The dashboard, native, from `/v2/ios/dashboard.php`: the stats tiles, a card per game with its meter, the Spin Progress chart (Swift Charts: total or per day, 1W to All, drag to read a day), friends and who is online, experience and rank, and pumpkins in season. My Profile, Find Friends and friends' profiles are native screens pushed on top; the profile picture and email verification open the site's pages. Refreshes once a minute while showing, and after a game closes. |
| **Profiles** | Native, from `/v2/ios/profile.php` (`Features/Profile/`). My Profile: picture (opens the site's picture page), name and badges, member since, the status line (edited natively), friend requests to accept or decline, requests sent to take back, friends with who is online and Unfriend, experience and what earned it, game stats and star sign. Kept on the device for offline, like the other tabs. Someone else's: the same as the site shows you, under its rules (a friends-only profile shows a stranger only the name and picture), with Add Friend, Accept/Decline, Cancel Request or Unfriend. Opened from Home, a leaderboard row, Settings' View Profile, a friend, a search result, any link to `/v2/profile/<id>` in a site page, or a deep link. Changes go through `/v2/account_edit.php` as on the web. |
| **Find Friends** | Native search as you type, from `/v2/ios/search.php`, with exact matches first and more as you scroll. Each result says where you stand (friends, request sent, wants to be your friend, private, not taking requests) and has Add or Accept on it. |
| **Send Feedback** | Native form (`Features/Feedback/`), from `/v2/ios/feedback.php`: the site's feedback subjects (an animated profile picture request too, for supporters, which asks for a link to the .gif), the message with the site's length limits, and "I'd like a reply" with the address it goes to. Sent through `/v2/account_edit.php` as the web form sends it. Opened from Settings, and in a sheet from any link to `/v2/feedback` in a site page (over the game for Spin's Report a Problem, with its subject picked) or a deep link. Against a site without the endpoint yet it falls back to the web form's subjects. |
| **Games** | Native list. Each game opens in a full-screen web player. Flappy and Tower use their own close button, which closes the player. Spin draws one only in the app (`data-app-close` in `spin.html`, reported through `bridge.js`); until a game says it has one, or if it fails to load, the player shows a native one. Leaving a game for the homepage or the dashboard closes the player, and a game's links to other site pages (Spin's account button, Report a Problem) open in a sheet over it. The games draw edge to edge (`viewport-fit=cover`) and keep their controls out of the camera housing and the home indicator. |
| **Leaderboard** | Native, from `/v2/ios/leaderboard.php`: Spin, Flappy and Tower, with medals for the top three and the player's own row marked. Refreshes while showing, at the pace the site's cache rebuilds. Rows open the player's native profile. |
| **Settings** | The account (picture, name, address) and native controls for theme, privacy and email preferences, read from `/v2/ios/account.php`. The theme is the account's, so it is also read whenever the app comes to the front, and applied to the whole window. Also has sign out, delete account (a native modal: type DELETE), haptics, clear cache, the version and Send Feedback. Email/username, connections, passkeys, 2FA and the profile picture open the site's own pages. |
| **Sign-in** | Native welcome screen (`Features/SignIn/WelcomeView.swift`), on the launch screen's navy: the login page's "Got an account?", with **Yup! Log In** and **Nope. Create One**. Either opens the whole sign-in in the system browser (`ASWebAuthenticationSession`, sharing Safari's cookies), on the site's own pages: the username step or Pick a Username, passkeys, Google/GitHub/Discord and 2FA, with Safari's AutoFill and the player's iCloud Keychain passkeys. A browser already signed in to Empanadas.io asks "Continue as …?" instead. The site hands the sign-in back with `empanadas-io://signin?code=`, and the app redeems the code at `/v2/ios/signin.php` with the PKCE verifier only it holds (`Auth/AppSignIn.swift`). The login page never shows in a web view of the app's: a page that goes there is stopped, and the app asks the site whether the session ended (`loginPageReached` in `App/AppModel.swift`). Sign Out loads `/v2/auth/logout.php` out of sight, and again later if it could not reach the site. |
| **Popups** | Captcha and other script-opened windows of the signed-in pages open in a sheet, limited to the site, the providers and the SSO hosts. Connect Google/GitHub/Discord on the account page goes through the system browser too, using the site's provider hand-off (`/v2/auth/browser.php`, `empanadas-io://auth`). |
| **Quick actions** | Play Flappy / Spin / Tower from the Home Screen icon. |
| **Haptics** | The games' own `navigator.vibrate()` calls (a manual spin, a Flappy crash, a Tower slip or topple) play native haptics: WebKit on iOS has no Vibration API, so `Resources/bridge.js` fills it in, and the Haptics switch in Settings turns it off. Pages can also call `window.empanadasApp.haptic(style)` directly. Tested by `test/iosbridge.test.js` (`npm test`). |
| **Offline** | Home, Leaderboard and Settings keep their last good answer on the device (`Core/OfflineStore.swift`) and open with it at launch and without a connection, saying when it was saved. Settings can't be changed offline. Profile pictures are cached on disk. A game opened offline starts from the copy in WebKit's cache, so any game played online before works offline; the games keep their saves on the device and sync them when back online. Everything refreshes when the connection returns. |
| **Deep links** | `empanadas-io://home`, `://leaderboard`, `://settings`, `://play/<game>`, `://profile`, `://profile/<id>`, `://friends` and `://feedback` (`?reason=<subject>`) open native screens. `://signin?code=` finishes a sign-in the app started, and `://auth?...` connecting a provider, each only while one is under way. Anything else is ignored. |

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
Then run on a simulator or a device. To run the unit tests, use ⌘U, or:

```sh
xcodebuild test -project Empanadas.xcodeproj -scheme Empanadas \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

The `iOS` GitHub Actions workflow does the same on every change under `ios/`.

## Before it works end to end

The site changes the app depends on are in zachduda/Empanadas-io#70 (the
user agent and browser sign-in) and the site's `html/v2/ios/` directory, the
app's own JSON API (`account.php`, `dashboard.php`, `leaderboard.php`,
`profile.php` and `search.php`). They take effect once deployed: until they
are live, the screens that read them say they couldn't load (HTTP 404).
[SITE-CHANGES.md](SITE-CHANGES.md) lists what is still open.

Signing in needs the site's `html/v2/auth/app.php` and `html/v2/ios/signin.php`
(SITE-CHANGES.md §9). **Deploy those before shipping a build of the app with the
welcome screen**: against a site without them, the browser opens on a 404 and
nobody can sign in.

## Before submitting to the App Store

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

## Next steps

- **Offline play without a first visit.** Games start offline from WebKit's
  cache, so only after being played online once. The desktop app goes further
  with the site's service worker (`sw.js`, `lib/offline.js`). WKWebView only
  runs service workers for App-Bound Domains (`WKAppBoundDomains`), which also
  blocks script injection on every other domain, so it needs testing on a
  device against the sign-in popups before it ships. Bundling the three games
  is the other route.
- **Game Center.** Leaderboards and achievements, fed by the games through
  `window.empanadasApp`. This needs leaderboard IDs in App Store Connect.
- **Push notifications** for friend requests and messages.
