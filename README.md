# Empanadas.io Desktop App
This is a Electron wrapped native application for Desktop that runs Empanadas.io in it's best form! Play the Spin Game natively on your device, and don't worry about needing to save your progress!

## Keep Spinning When Closed

Off by default. Turn it on from the Spin Game's settings (or, on a Mac, the
Empanadas.io menu). With it on, closing the window during the Spin Game closes
the game but not the app: it goes to the system tray (the menu bar on a Mac)
with your spin count, and saves what your Auto Spinners make once a minute.

- The game page is closed completely. All that is left is one timer a minute
  and one small save request, at the lowest process priority.
- It stops at 100,000 Spins (you'll get a notification to come back and
  Prestige), when the game is opened somewhere else, or when you sign out.
- When the computer is very busy it skips its save; if that lasts five
  minutes it saves once more and quits. Time asleep is not counted.
- Click the tray icon (or **Open Spin Game** in its menu) to come back. On a
  Mac the app restarts to do this, as macOS does not let it raise its own
  priority back up.

How it works is described at the top of `lib/background.js`. It needs the Spin
Game's `window.spinBackgroundHandoff()` (Empanadas-io repo, `_spin.js`); with a
site that does not have it, the window closes as it always has.
