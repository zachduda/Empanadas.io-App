# Empanadas.io for iOS

A native SwiftUI app around empanadas.io, playing the same role the Electron
app plays on the desktop. The games are still the site's. The app adds native
navigation, a native dashboard, leaderboard and Settings screen, browser
sign-in, a full-screen game player, offline support and the iOS integrations
App Review expects.

## What's native and what's web

| | |
|---|---|
| **Tabs**: Home, Games, Leaderboard, Settings | Native. These replace the site's navbar. The navigation bars are the system's own (Liquid Glass on iOS 26, a translucent material before it), in light or dark to match the theme. |
| **Home** | The dashboard, native, from `/v2/ios/dashboard.php`: the stats tiles, a card per game with its meter, the Spin Progress chart (Swift Charts: total or per day, 1W to All, drag to read a day), friends and who is online, experience and rank, and pumpkins in season. Profiles, friend search and the profile picture open the site's pages on top. Refreshes once a minute while showing, and after a game closes. |
| **Games** | Native list. Each game opens in a full-screen web player. Flappy and Tower use their own close button, which closes the player; Spin gets a native one. Leaving a game for the homepage or the dashboard closes the player. The space around a game (the camera housing, the home indicator) takes the game's own background colour. |
| **Leaderboard** | Native, from `/v2/ios/leaderboard.php`: Spin, Flappy and Tower, with medals for the top three and the player's own row marked. Refreshes while showing, at the pace the site's cache rebuilds. Rows open the player's profile. |
| **Settings** | The account (picture, name, address) and native controls for theme, privacy and email preferences, read from `/v2/ios/account.php`. Also has sign out, delete account (a native modal: type DELETE), haptics, clear cache and the version. Email/username, connections, passkeys, 2FA and the profile picture open the site's own pages. |
| **Sign-in** | The login page (web). Google/GitHub/Discord go through the system browser (`ASWebAuthenticationSession`) using the site's existing browser sign-in flow. |
| **Popups** | 2FA, captcha and other script-opened windows open in a sheet, limited to the site, the providers and the SSO hosts. |
| **Quick actions** | Play Flappy / Spin / Tower from the Home Screen icon. |
| **Offline** | Home, Leaderboard and Settings keep their last good answer on the device (`Core/OfflineStore.swift`) and open with it at launch and without a connection, saying when it was saved. Settings can't be changed offline. Profile pictures are cached on disk. A game opened offline starts from the copy in WebKit's cache, so any game played online before works offline; the games keep their saves on the device and sync them when back online. Everything refreshes when the connection returns. |
| **Deep links** | `empanadas-io://home`, `://leaderboard`, `://settings` and `://play/<game>` open native screens. `://auth?...` finishes a sign-in. Anything else is ignored. |

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

In Xcode, open Signing & Capabilities for the Empanadas target and choose your
team (or set `DEVELOPMENT_TEAM` in `project.yml`). Then run on a simulator or
a device. To run the unit tests, use ⌘U, or:

```sh
xcodebuild test -project Empanadas.xcodeproj -scheme Empanadas \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

The `iOS` GitHub Actions workflow does the same on every change under `ios/`.

## Before it works end to end

The site changes the app depends on are in zachduda/Empanadas-io#70 (the
user agent and browser sign-in) and the site's `html/v2/ios/` directory, the
app's own JSON API (`account.php`, `dashboard.php` and `leaderboard.php`).
They take effect once deployed: until `dashboard.php` and `leaderboard.php`
are live, the Home and Leaderboard tabs say they couldn't load (HTTP 404).
[SITE-CHANGES.md](SITE-CHANGES.md) lists what is still open.

## Before submitting to the App Store

- Turn on Sign in with Apple (SITE-CHANGES.md §6). The coffee links are
  already gone in the app.
- Check `Resources/PrivacyInfo.xcprivacy` against the privacy policy, and fill
  in the matching App Privacy answers in App Store Connect.
- Replace the app icon if you want a dedicated one. The current one is
  `icon.png` from the desktop app, scaled up.
- Add screenshots, a description, a support URL and a privacy policy URL in
  App Store Connect.
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
