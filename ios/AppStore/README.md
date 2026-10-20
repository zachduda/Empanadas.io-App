# App Store art

The screenshots and creative assets (product page header, search results)
for the iOS app's App Store listing, and the script that draws them. The images are committed, so you can upload them as
they are. Run the script again after changing a caption, a screen or the app.

| Folder | What | Size |
|---|---|---|
| `iphone-6.9/` | iPhone screenshots, 6.9" display | 1320 × 2868 |
| `ipad-13/` | iPad screenshots, 13" display | 2064 × 2752 |
| `creative/` | Product page header, search results, universal asset, in-app event card | see below |
| `screens/` | The bare screens the screenshots are made from | device resolution |

App Store Connect scales the 6.9" and 13" sets down for smaller devices, so
these two are the only ones it needs. The app runs on iPad
(`TARGETED_DEVICE_FAMILY` 1,2 in `project.yml`), so the iPad set is required
too.

## The screenshots

In upload order. Search results show the first three, so those are the
three games.

| # | Screen | Caption |
|---|---|---|
| 1 | Spin | **Spin the empanada.** Rack up spins, earn peppers and rank up to Spin Overlord. |
| 2 | Flappy | **Flap through the gaps.** Hold to rise, let go to fall. How far can you fly? |
| 3 | Tower | **Stack it sky-high.** Drop each empanada just right, and don't let the tower topple. |
| 4 | Games | **Jump right back in.** Pick up where you left off, with your best scores on every game. |
| 5 | Home | **Every stat in one place.** Peppers, high scores and progress for all three games. |
| 6 | Leaderboards | **Climb the leaderboards.** See where you stand in Spin, Flappy and Tower. |
| 7 | Home Screen widgets | **Right on your Home Screen.** Your best scores at a glance. Tap a game to jump straight in. |
| 8 | Home, scrolled | **Play with your friends.** See who's online and how far your spins have come. (iPhone only) |

On iPad, the Games tab is held down on Flappy, with its menu open: the tab
is short there, three cards across, so the iPad is drawn larger and runs off
the bottom. The widgets float on the backdrop on their own, beside the app's
icon as on a Home Screen, rather than on a drawing of one.

The captions are in `SHOTS` at the top of `render.mjs`.

## Creative assets

New in iOS 27 and iPadOS 27: a header across the top of the product page, and
an image in search results in place of the first screenshots. Both are
optional. Upload them under Product Page Information > Header and Search
Results on the version page, or in Asset Library, where they can be approved
ahead of a release. Sizes are Apple's
[creative assets specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications):

| File | Placement | Apple's size |
|---|---|---|
| `product-page-header-3840x1646.png` | Product page header | 21:9, exactly 3840 × 1646 |
| `search-results-3840x2560.png` | Search results | 3:2, 1920 × 1280 up to 3840 × 2560 |
| `universal-5244x2950.png` | Either, or both | 16:9, exactly 5244 × 2950, PNG only |
| `event-card-3840x2160.png`, `event-card-1920x1080.png` | In-app event card | 16:9, 1920 × 1080 up to 3840 × 2160 |

Use either the header and search results pair, or the universal asset for
both: with a universal asset, App Store Connect offers "Use header asset in
search results". None of them has an alpha channel, which Apple doesn't allow.

- **Header and universal:** "Spin, flap and stack." beside the three games on
  iPhones. No app name or icon: the product page shows both right there, and
  a name ending in .io could read as a web address, which Apple asks assets
  not to show.
- **Search results:** the three games side by side, each named. Apple's advice
  for this placement is to make the app's purpose obvious and show the
  gameplay.
- **Event card:** the icon and name, for when the card turns up away from the
  product page. Only needed if you run an in-app event, which also takes a
  9:16 image for its details page (not made here).

Apple's templates
([best practices and templates](https://developer.apple.com/app-store/asset-best-practices/))
mark the exact safe areas. These are worked out from the crops instead: the
universal asset is cut to 21:9 for the header and to 3:2 for search, an
upright iPhone trims a further 8% or so off each side of the header, and the
back and share buttons sit over its top corners. Everything that matters
stays inside what all of those leave. Before submitting, check them in App
Store Connect's Preview, which shows each device and orientation. To see the
boxes used, open `templates/creative.html?kind=universal&guides=1`.

## Where the screens come from

- **Spin, Flappy and Tower** are the site's own game pages
  (zachduda/Empanadas-io, `html/`), loaded in Chromium at the device's size
  with the iPhone's safe areas filled in, as the app shows them. A script
  plays each one to a good moment: Flappy threading a gap in the 40s, under
  the day's sky it starts in, Tower 14 floors high (16 on iPad). Spin's numbers come from the account, so they
  are filled in on the page.
- **Home, Friends, Games, Leaderboard and the widgets** are
  `templates/native.html`, a copy in HTML of the SwiftUI screens (`HomeView`,
  `SpinChartCard`, `GamesView`, `GameMenu`, `LeaderboardView`, the widget's
  `GamesWidget`, the colours in `Palette`), with demo players. The iPad
  layouts follow `BalancedGrid`, `MasonryColumns` and `readableListWidth`. On a Mac it draws in SF Pro;
  elsewhere in Inter, which is close. The icons are Font Awesome stand-ins for
  the SF Symbols.

Everything shown is made up: the players are `mateo`, `luna` and friends,
with emoji for pictures, so no real account appears in the listing.

App Review asks that screenshots show the app in use. The native screens
follow the app closely, but they are drawings of it. To use real ones, take
them in the Simulator (iPhone 16 Pro Max, and iPad Pro 13-inch (M4)), save
them over the files in `screens/` (`home.png`, `friends.png`, `games.png`,
`leaderboard.png`, or any of the games) and compose again:

```sh
xcrun simctl io booted screenshot ios/AppStore/screens/iphone/home.png
node ios/AppStore/render.mjs --compose-only
```

Use the Simulator's status bar override for a clean 9:41:

```sh
xcrun simctl status_bar booted override --time 9:41 --batteryLevel 100 --batteryState charged --cellularBars 4 --wifiBars 3
```

## Running it

You need Node 18 or later, Playwright's Chromium, and a checkout of
zachduda/Empanadas-io next to this repository (or pass `--site`).

```sh
npm i --no-save playwright && npx playwright install chromium
node ios/AppStore/render.mjs --site ../Empanadas-io/html
```

It takes a couple of minutes, most of it the Tower autopilot stacking. If
the tower ever falls, run it again.

The game pages need `/Content/Icons/` (Font Awesome and the pepper), which the
site repository doesn't hold. The script takes them from empanadas.io; if
that can't be reached, `npm i --no-save @fortawesome/fontawesome-free` lets
it draw them offline.

| File | |
|---|---|
| `render.mjs` | Captures the screens, then composes everything |
| `templates/shot.html` | One screenshot: caption, backdrop and device |
| `templates/creative.html` | The creative assets and event card |
| `templates/native.html` | The native screens |
| `templates/device.css` | The iPhone and iPad frames, drawn in CSS |
| `templates/icons.js` | Icons ([Font Awesome Free](https://fontawesome.com), CC BY 4.0) |
