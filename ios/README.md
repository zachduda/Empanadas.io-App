# Empanadas.io for iOS

A native SwiftUI shell around empanadas.io, playing the same role the Electron
app plays on the desktop. The site is still the product. The app adds native
navigation, a native Settings screen, browser sign-in, a full-screen game
player and the iOS integrations App Review expects.

## What's native and what's web

| | |
|---|---|
| **Tabs**: Home, Games, Settings | Native. These replace the site's navbar. |
| **Home** | The dashboard (web). Taps on its links to `/v2/account` and the games open the native screens. |
| **Games** | Native list. Each game opens in a full-screen web player. Flappy and Tower use their own close button, which closes the player; Spin gets a native one. Leaving a game for the homepage or the dashboard closes the player. |
| **Settings** | The account (picture, name, address) and native controls for theme, privacy and email preferences, read from `/ios/account.php`. Also has sign out, delete account (a native modal: type DELETE), haptics, clear cache and the version. Email/username, connections, passkeys, 2FA and the profile picture open the site's own pages. |
| **Sign-in** | The login page (web). Google/GitHub/Discord go through the system browser (`ASWebAuthenticationSession`) using the site's existing browser sign-in flow. |
| **Popups** | 2FA, captcha and other script-opened windows open in a sheet, limited to the site, the providers and the SSO hosts. |
| **Quick actions** | Play Flappy / Spin / Tower from the Home Screen icon. |
| **Deep links** | `empanadas-io://home`, `://settings` and `://play/<game>` open native screens. `://auth?...` finishes a sign-in. Any other link is passed to the site via `window.empanadasApp.onDeepLink`. |

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
user agent and browser sign-in) and the site's `html/ios/` directory, the
app's own JSON API (`/ios/account.php`). They take effect once deployed.
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

- **Offline play.** The desktop app keeps Spin, Flappy and Tower working
  offline through the site's service worker (`lib/offline.js`). WKWebView only
  runs service workers for App-Bound Domains (`WKAppBoundDomains`), which also
  restricts navigation, so bundling the three games into the app is likely the
  better route.
- **Game Center.** Leaderboards and achievements, fed by the games through
  `window.empanadasApp`. This needs leaderboard IDs in App Store Connect.
- **Push notifications** for friend requests and messages.
