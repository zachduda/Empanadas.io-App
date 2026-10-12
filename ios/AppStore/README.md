# App Store art

The screenshots and header for the iOS app's App Store listing, and the
script that draws them. The images are committed, so you can upload them as
they are. Run the script again after changing a caption, a screen or the app.

| Folder | What | Size |
|---|---|---|
| `iphone-6.9/` | iPhone screenshots, 6.9" display | 1320 × 2868 |
| `ipad-13/` | iPad screenshots, 13" display | 2064 × 2752 |
| `header/` | Wide header, 16:9 | 1920 × 1080 and 3840 × 2160 |
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
| 4 | Home | **Every stat in one place.** Peppers, high scores and progress for all three games. |
| 5 | Leaderboards | **Climb the leaderboards.** See where you stand in Spin, Flappy and Tower. |
| 6 | Home, scrolled | **Play with your friends.** See who's online and how far your spins have come. (iPhone only) |

The captions are in `SHOTS` at the top of `render.mjs`.

## The header

The app icon, name and the three games beside three iPhones. At 16:9 it
works as an in-app event card (1920 × 1080), a promotional image for App
Store featuring, or the top of a web page or README. Apple puts its own text
over the bottom of event cards, so keep anything important out of the bottom
third if you use it there.

## Where the screens come from

- **Spin, Flappy and Tower** are the site's own game pages
  (zachduda/Empanadas-io, `html/`), loaded in Chromium at the device's size
  with the iPhone's safe areas filled in, as the app shows them. A script
  plays each one to a good moment: Flappy threading a gap at 41 points, Tower
  14 floors high (16 on iPad). Spin's numbers come from the account, so they
  are filled in on the page.
- **Home, Friends and Leaderboard** are `templates/native.html`, a copy in
  HTML of the SwiftUI screens (`HomeView`, `SpinChartCard`, `LeaderboardView`,
  the colours in `Palette`), with demo players. On a Mac it draws in SF Pro;
  elsewhere in Inter, which is close. The icons are Font Awesome stand-ins for
  the SF Symbols.

Everything shown is made up: the players are `mateo`, `luna` and friends,
with emoji for pictures, so no real account appears in the listing.

App Review asks that screenshots show the app in use. The native screens
follow the app closely, but they are drawings of it. To use real ones, take
them in the Simulator (iPhone 16 Pro Max, and iPad Pro 13-inch (M4)), save
them over the files in `screens/` (`home.png`, `friends.png`,
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
| `templates/header.html` | The header |
| `templates/native.html` | The native screens |
| `templates/device.css` | The iPhone and iPad frames, drawn in CSS |
| `templates/icons.js` | Icons ([Font Awesome Free](https://fontawesome.com), CC BY 4.0) |
