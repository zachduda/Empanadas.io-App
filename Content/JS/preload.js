const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronWindow', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  // Fires with { maximized } whenever that changes, however it changed.
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window-state', listener);
    return () => ipcRenderer.removeListener('window-state', listener);
  },
  // macOS draws its own traffic lights over the page, so the site should hide
  // its in-page window buttons and inset its titlebar when this is 'darwin'.
  platform: process.platform,
  isMac: process.platform === 'darwin',
  onDeepLink: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('deep-link', listener);
    return () => ipcRenderer.removeListener('deep-link', listener);
  },
  // Is empanadas.io reachable? Asked from the main process, which CORS does
  // not apply to - see pingSite() in main.js. Resolves { ok, status, pong }.
  ping: () => ipcRenderer.invoke('app-ping'),
  // Empties the app's cache but keeps cookies and saves - see clearAppCache()
  // in main.js. Resolves { ok }, or null if the page is not empanadas.io.
  clearCache: () => ipcRenderer.invoke('app-clear-cache'),
  // Offline games (lib/offline.js). status() resolves { signedIn, ready,
  // available }; play() opens 'spin' or 'flappy' when available is true.
  offline: {
    status: () => ipcRenderer.invoke('offline-status'),
    play: (game) => ipcRenderer.invoke('offline-play', String(game)),
  },
});

// Read-only view of the updater. Deliberately no "install" here: the page is
// loaded from the network, and nothing served over the wire should be able to
// quit the app or launch an installer.
contextBridge.exposeInMainWorld('empanadasUpdater', {
  check: () => ipcRenderer.invoke('update-check'),
  getState: () => ipcRenderer.invoke('update-state'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updater:state', listener);
    return () => ipcRenderer.removeListener('updater:state', listener);
  },
});
const CHROME_PAGES = ['/spin', '/spin.html'];

function wantsChrome() {
  if (location.protocol === 'file:') return /\/download\.html$/.test(location.pathname);
  if (location.origin !== 'https://empanadas.io') return false;
  return CHROME_PAGES.includes(location.pathname);
}

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h5v-5.5h3V20h5V9.5"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

const CHROME_CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; top: 0; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; display: flex; align-items: stretch; height: 30px;
    background: rgba(18, 18, 72, .62); color: #fff;
    border-radius: 0 0 12px 12px; overflow: hidden;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .18);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    opacity: .55; transition: opacity .15s ease;
    font: 12px/1 system-ui, sans-serif; user-select: none;
  }
  .bar:hover, .bar:focus-within { opacity: 1; }
  .grip {
    -webkit-app-region: drag; width: 58px; display: flex; align-items: center;
    justify-content: center; cursor: grab;
  }
  .grip i { display: block; width: 22px; height: 6px; border-radius: 3px;
    background: repeating-linear-gradient(90deg, rgba(255,255,255,.7) 0 2px, transparent 2px 5px); }
  button {
    -webkit-app-region: no-drag; appearance: none; border: 0; margin: 0; padding: 0;
    width: 38px; background: transparent; color: inherit; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  button:hover { background: rgba(255, 255, 255, .16); }
  button:focus-visible { outline: 2px solid #ffd35c; outline-offset: -2px; }
  button.close:hover { background: #e81123; }
  svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8;
    stroke-linecap: round; stroke-linejoin: round; }
`;

function iconButton(name, label, onClick, extraClass) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = extraClass || '';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Space is Flappy's fly key. A button left focused would take it as
    // another click - maximize, maximize, maximize - instead of the game.
    button.blur();
    onClick(button);
  });
  // The games start a run or a spin on pointerdown anywhere on the page.
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
    button.addEventListener(type, (e) => e.stopPropagation());
  }
  return button;
}

function drawChrome() {
  if (!wantsChrome() || !document.body) return;
  if (document.querySelector('[data-app-titlebar], [data-app-window]')) return;

  const host = document.createElement('div');
  host.setAttribute('data-empanadas-app-chrome', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CHROME_CSS;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Window');

  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = 'Drag to move the window';
  grip.appendChild(document.createElement('i'));
  bar.appendChild(grip);

  if (location.protocol !== 'file:') {
    bar.appendChild(iconButton('home', 'Back to the dashboard', () => ipcRenderer.invoke('app-home')));
  }
  // macOS keeps its traffic lights (titleBarStyle 'hiddenInset'), so only the
  // handle and the way home are needed there.
  if (process.platform !== 'darwin') {
    bar.appendChild(iconButton('minimize', 'Minimize', () => ipcRenderer.invoke('window-minimize')));
    const max = iconButton('maximize', 'Maximize', () => ipcRenderer.invoke('window-maximize').then(show));
    const show = (maximized) => {
      max.title = maximized ? 'Restore' : 'Maximize';
      max.setAttribute('aria-label', max.title);
      max.querySelector('svg').innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    };
    ipcRenderer.invoke('window-is-maximized').then(show);
    ipcRenderer.on('window-state', (_event, state) => show(Boolean(state && state.maximized)));
    bar.appendChild(max);
    bar.appendChild(iconButton('close', 'Close', () => ipcRenderer.invoke('window-close'), 'close'));
  }

  root.appendChild(style);
  root.appendChild(bar);
  document.body.appendChild(host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', drawChrome, { once: true });
} else {
  drawChrome();
}
