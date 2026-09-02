// Deliberately empty.
//
// A window opened from the page inherits the opener's webPreferences, preload
// included, so without this file the sign-in popup would run
// Content/JS/preload.js and hand the window controls and the updater bridge to
// accounts.google.com. Naming an empty preload is the only way to say "no
// preload" for a child window: leaving the option unset inherits.
