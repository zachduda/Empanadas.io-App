// window.empanadasApp: what the iOS app offers the site. Injected at document
// start into the main frame of every page; does nothing off empanadas.io.
// The desktop app's equivalent is window.electronWindow (Content/JS/preload.js
// in the Empanadas.io-App repo). This one deliberately has no window controls:
// the site should check for empanadasApp to know it is in the iOS app and hide
// its own navigation, which the app replaces with native tabs.
(function () {
  'use strict';

  var host = location.hostname;
  var onSite = location.protocol === 'https:' &&
    (host === 'empanadas.io' || host.slice(-'.empanadas.io'.length) === '.empanadas.io');
  if (!onSite || window.empanadasApp) return;

  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.empanadas;
  if (!handler) return;

  function call(cmd, args) {
    return handler.postMessage({ cmd: cmd, args: args || {} });
  }

  // <html data-native-app="ios">, for CSS. The server can do better (leave
  // the navigation out of the page entirely, see ios/SITE-CHANGES.md); this is
  // for anything decided in the browser.
  function mark() {
    if (document.documentElement) document.documentElement.setAttribute('data-native-app', 'ios');
  }
  mark();
  document.addEventListener('DOMContentLoaded', mark, { once: true });

  var deepLinkListeners = [];

  var app = {
    platform: 'ios',
    version: '__APP_VERSION__',
    // 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error'
    haptic: function (style) { return call('haptic', { style: String(style || 'light') }); },
    openSettings: function () { return call('openSettings'); },
    // 'spin' | 'flappy' | 'tower'
    openGame: function (game) { return call('openGame', { game: String(game) }); },
    // Opens the share sheet for an empanadas.io link.
    share: function (url) { return call('share', { url: String(url) }); },
    // Is empanadas.io reachable? Resolves { ok, status, pong }, as in the
    // desktop app.
    ping: function () { return call('ping'); },
    // Empties the app's cache but keeps cookies and saves. Resolves { ok }.
    clearCache: function () { return call('clearCache'); },
    // empanadas-io:// links the app was opened with. Returns an unsubscribe.
    onDeepLink: function (callback) {
      deepLinkListeners.push(callback);
      return function () {
        var i = deepLinkListeners.indexOf(callback);
        if (i >= 0) deepLinkListeners.splice(i, 1);
      };
    }
  };

  // Called by the app (WebPage.run) with a deep link that is not one it
  // handles natively.
  Object.defineProperty(app, '_deliverDeepLink', {
    value: function (url) {
      deepLinkListeners.slice().forEach(function (callback) {
        try { callback(url); } catch (err) { /* one bad listener must not stop the rest */ }
      });
    }
  });

  Object.freeze(app);
  Object.defineProperty(window, 'empanadasApp', { value: app, writable: false, configurable: false });
})();
