# Empanadas.io Desktop App
This is a Electron wrapped native application for Desktop that runs Empanadas.io in it's best form! Play the Spin Game natively on your device, and don't worry about needing to save your progress!

## Offline games
Once you've signed in, Spin and Flappy keep working without a connection: when the app can't reach Empanadas.io, the start screen offers both games, and your progress syncs to your account when you're back online. Signing out removes the offline copies. How it fits together is described at the top of `lib/offline.js`; the site half is `html/sw.js` in the Empanadas-io repo.
