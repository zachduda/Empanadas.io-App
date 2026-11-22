# Empanadas.io for Mac and Windows

The Empanadas.io app for the desktop. Its screens are its own: Home, Games,
Leaderboards, Friends, your profile, Settings and Updates, drawn from the
site's API rather than the website in a window. The games are kept on your
computer, so they start straight away and keep working without a connection.
Your saves go to your account as always.

How it is put together: [docs/NATIVE-APP.md](docs/NATIVE-APP.md). The iOS app
lives in [ios/](ios/README.md). Releasing: [docs/RELEASING.md](docs/RELEASING.md).

```sh
npm ci
npm start        # run it
npm test         # checks and unit tests, no Electron needed
npm run e2e      # the whole app against a stand-in site (see docs/NATIVE-APP.md)
```
