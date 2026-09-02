# Empanadas.io Desktop App
This is a Electron wrapped native application for Desktop that runs Empanadas.io in it's best form! Play the Spin Game natively on your device, and don't worry about needing to save your progress!

## Signing in

"Log in with Google / GitHub / Discord" works the same way it does in a browser:
the site calls `window.open()`, and the shell opens a real popup window for it.
The window is deliberately narrow in what it can do — it gets no preload, so
none of the app's IPC or the updater bridge, and it may only navigate between
these hosts and back to `empanadas.io`:

    accounts.google.com
    github.com, www.github.com
    discord.com, canary.discord.com, ptb.discord.com, discordapp.com

The list lives in `lib/urls.js` (`AUTH_HOSTS`). Any other `window.open()` is
still denied and, if it is an off-site `https` link, handed to the user's own
browser instead. Requests to those hosts are sent with a plain Chrome user
agent, because Google refuses OAuth from a user agent that names Electron.

Two things the site has to hold up its end of:

* The redirect at the end of the flow has to land back on `empanadas.io`
  (over https). A callback served from anywhere else is blocked as an
  off-site navigation, and the popup will sit there.
* The callback page closes the popup itself (`window.close()`) after handing
  the result to `window.opener` — the shell does not close it, since it cannot
  know when the page is finished with it.

If a provider ever refuses to authenticate in the app window anyway, the other
route is already wired up: send the user to their real browser and bring the
result back through the `empanadas-io:` protocol, which arrives in the page as
the `onDeepLink` callback exposed by `Content/JS/preload.js`.
