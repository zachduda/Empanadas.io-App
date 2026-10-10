// window.empanadasApp: what the iOS app offers the site. Injected at document
// start into the main frame of every page; does nothing off empanadas.io.
// The desktop app's equivalent is window.electronWindow (Content/JS/preload.js
// in the Empanadas.io-App repo). This one deliberately has no window controls,
// and it hides the site's navbar: the app replaces it with native tabs.
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

  // <html data-native-app="ios">, for the site's CSS, and a style that hides
  // its navbar. Every page draws it as <nav id="nav"> (getNav() in the site's
  // config.php, or inline on the static pages). Done before the page renders
  // so the bar never flashes up; <html> may not exist yet at document start,
  // so wait for it if need be.
  var NATIVE_CSS = '#nav { display: none !important; }';

  function mark(root) {
    root.setAttribute('data-native-app', 'ios');
    var style = document.createElement('style');
    style.setAttribute('data-empanadas-app', '');
    style.textContent = NATIVE_CSS;
    root.appendChild(style);
  }

  if (document.documentElement) {
    mark(document.documentElement);
  } else {
    new MutationObserver(function (_records, observer) {
      if (!document.documentElement) return;
      observer.disconnect();
      mark(document.documentElement);
    }).observe(document, { childList: true });
  }

  // navigator.vibrate(), which WebKit on iOS does not have. The games already
  // call it (a manual spin in Spin, a crash in Flappy, a slip or topple in
  // Tower), so it is filled in here with the phone's haptics rather than
  // changed in each game. Same contract as the Vibration API: a number or a
  // pattern of on/off milliseconds, a new call cancels the pattern before
  // it, and 0 or [] just cancels. Each "on" plays one tap, firmer the longer
  // it asks for. The app's Haptics setting turns these off too.
  var buzzTimers = [];
  var MAX_PATTERN = 20;

  function strength(ms) {
    if (ms <= 10) return 'light';
    if (ms <= 40) return 'medium';
    return 'heavy';
  }

  function buzz(style) {
    call('haptic', { style: style }).catch(function () { /* the buzz is optional */ });
  }

  function vibrate(pattern) {
    buzzTimers.forEach(clearTimeout);
    buzzTimers = [];
    var steps = Array.isArray(pattern) ? pattern : [pattern];
    var at = 0;
    for (var i = 0; i < steps.length && i < MAX_PATTERN; i++) {
      var ms = Math.min(Math.max(Number(steps[i]) || 0, 0), 10000);
      if (i % 2 === 0 && ms > 0) {
        if (at === 0) {
          buzz(strength(ms));
        } else {
          buzzTimers.push(setTimeout(buzz, at, strength(ms)));
        }
      }
      at += ms;
    }
    return true;
  }

  if (typeof navigator.vibrate !== 'function') {
    try {
      Object.defineProperty(Navigator.prototype, 'vibrate', {
        value: vibrate, writable: true, configurable: true
      });
    } catch (err) {
      navigator.vibrate = vibrate;
    }
  }

  // The page's background colour, for the app to paint around the page (the
  // safe areas, the overscroll) instead of a fixed colour. Sent whenever it
  // changes: the stylesheets load without blocking, and core.js switches the
  // theme once the account arrives.
  var lastColor = null;

  function backgroundOf(el) {
    if (!el) return null;
    var color = getComputedStyle(el).backgroundColor;
    return (!color || color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color)) ? null : color;
  }

  function reportColor() {
    var color = backgroundOf(document.body) || backgroundOf(document.documentElement);
    if (!color || color === lastColor) return;
    lastColor = color;
    call('pageColor', { color: color }).catch(function () { /* not ours to worry about */ });
  }

  function watchColor() {
    reportColor();
    var observer = new MutationObserver(reportColor);
    [document.documentElement, document.body].forEach(function (el) {
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    });
    // A theme change that fades the background in reports the colour it
    // ends on, not one from halfway through.
    if (document.body) document.body.addEventListener('transitionend', reportColor);
    window.addEventListener('load', function () {
      reportColor();
      setTimeout(reportColor, 600);
    });
  }

  // A game that draws its own close button for the app marks it
  // data-app-close (Spin's, in spin.html). The game player then leaves its
  // native one off: laid over the page, it sat on Spin's rank card, store
  // and settings. Pages without one keep the native button.
  function reportCloseButton() {
    if (document.querySelector('[data-app-close]')) {
      call('ownCloseButton').catch(function () { /* the native button stays */ });
    }
  }

  function ready() {
    watchColor();
    reportCloseButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }

  var app = {
    platform: 'ios',
    version: '__APP_VERSION__',
    // 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error'
    haptic: function (style) { return call('haptic', { style: String(style || 'light') }); },
    openSettings: function () { return call('openSettings'); },
    // Closes the full-screen game player (what the games' own close button
    // should do in the app). Resolves false outside the player.
    closeGame: function () { return call('closeGame'); },
    // 'spin' | 'flappy' | 'tower'
    openGame: function (game) { return call('openGame', { game: String(game) }); },
    // Opens the share sheet for an empanadas.io link.
    share: function (url) { return call('share', { url: String(url) }); },
    // Is empanadas.io reachable? Resolves { ok, status, pong }, as in the
    // desktop app.
    ping: function () { return call('ping'); },
    // Empties the app's cache but keeps cookies and saves. Resolves { ok }.
    clearCache: function () { return call('clearCache'); }
  };

  Object.freeze(app);
  Object.defineProperty(window, 'empanadasApp', { value: app, writable: false, configurable: false });
})();
