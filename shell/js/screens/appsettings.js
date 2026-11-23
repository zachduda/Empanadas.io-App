// App Settings: the app's own settings, apart from the account's. None of it
// needs the site, so it opens offline and when the account can't be loaded:
// updates, the cache, the games kept on this computer, Keep Spinning When
// Closed, notifications, which versions of the app, Electron and Chromium
// this is (for bug reports, as the 1.x account page showed), and how the
// servers are (Server Status, as on iOS).

import { h, replace, button, icon } from '../dom.js';
import { num, ago, bytes, GAMES, GAME_ORDER } from '../format.js';
import { levelOf, statusDot, openStatusSheet } from '../statussheet.js';

// How often the light is asked about while App Settings is showing: the
// main process caches Statuspage's answer for as long.
const STATUS_EVERY = 60 * 1000;

const UPDATE_TEXT = {
	idle: 'Checks by itself every few hours, and asks before downloading and again before installing.',
	checking: 'Checking for updates…',
	'up-to-date': 'You’re up to date.',
	available: 'A new version is available.',
	downloading: 'Downloading the update…',
	verifying: 'Checking the update’s signature…',
	ready: 'The update is ready to install.',
	installing: 'Installing. The app will restart.',
	declined: 'Update postponed.',
	error: 'Couldn’t check for updates.'
};

const WORKING = ['checking', 'downloading', 'verifying', 'installing'];

const PLATFORM = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner narrow' });
	replace(container, inner);

	let info = app.state.info || {};
	let games = app.state.games;
	let bg = { available: false, enabled: false };
	let update = { status: 'idle' };
	let cacheBytes = null;
	let clearing = false;
	let looks = null;
	let prefs = { notifications: true };
	let serverLevel = 'checking';
	const hasStatus = !!(window.native && window.native.status);
	const offs = [];

	function setting(title, desc, control, leadIcon) {
		return h('div', { class: 'setting' },
			leadIcon ? icon(leadIcon, 'lead') : null,
			h('div', { class: 'main' }, h('div', { class: 'title' }, title), desc ? h('div', { class: 'desc' }, desc) : null),
			control ? h('div', { class: 'control' }, control) : null);
	}

	function group(title, rows) {
		return h('section', { class: 'settings-group' }, h('h2', null, title), h('div', { class: 'card' }, rows));
	}

	function toggle(checked, onChange, { disabled = false, label } = {}) {
		const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label, disabled });
		input.checked = !!checked;
		input.addEventListener('change', async () => {
			const want = input.checked;
			input.disabled = true;
			const ok = await onChange(want);
			input.disabled = false;
			if (ok === false) input.checked = !want;
		});
		return input;
	}

	function updateRows() {
		const s = update.status || 'idle';
		let text = UPDATE_TEXT[s] || UPDATE_TEXT.idle;
		if (update.version && ['available', 'declined', 'downloading', 'verifying', 'ready', 'installing'].includes(s)) {
			text = text.replace(/\.$/, '') + ' (' + update.version + ').';
		}
		if (s === 'up-to-date' && info.version) text = 'You’re up to date. ' + info.version + ' is the latest version.';
		if (s === 'error' && update.error) text += ' ' + update.error;
		const rows = [setting('Empanadas.io ' + (info.version || ''), text,
			button(s === 'checking' ? 'Checking…' : 'Check for Updates', async (e) => {
				const btn = e.currentTarget;
				btn.disabled = true;
				const r = await window.native.updater.check();
				// The updater skips a check made within a minute of the last one
				// and hands back where it got to.
				if (r && r.status) update = r;
				if (!r || r.status === 'idle') app.toast('Checked a moment ago. Try again in a minute.', 'info');
				draw();
			}, { kind: 'small primary', icon: 'refresh', disabled: WORKING.includes(s) }), 'download')];
		if (s === 'downloading') {
			const pct = Math.round((Number(update.progress) || 0) * 100);
			rows.push(h('div', { class: 'setting' },
				h('div', { class: 'main' },
					h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
						h('span', { style: { width: pct + '%' } })),
					h('div', { class: 'desc' }, pct + '%'))));
		}
		return rows;
	}

	function storageRows() {
		const s = games || {};
		const busy = !!s.syncing;
		const rows = [
			setting('Cache', (cacheBytes === null ? 'Working it out…' : bytes(cacheBytes) + '.') +
				' Fixes screens or games that look out of date. You stay signed in, and your saves and downloaded games aren’t touched.',
			button(clearing ? 'Clearing…' : 'Clear Cache', async () => {
				clearing = true;
				draw();
				const r = await window.native.cache.clear();
				app.toast(r && r.ok ? 'Cache cleared.' : 'Part of the cache couldn’t be cleared.', r && r.ok ? 'success' : 'error');
				cacheBytes = (await window.native.cache.size()).bytes;
				clearing = false;
				draw();
			}, { kind: 'small', icon: 'trash', disabled: clearing }), 'trash'),
			setting('Game Files',
				(s.files ? num(s.files) + ' files, ' + bytes(s.bytes) : 'Nothing kept yet') +
				(s.syncedAt ? ' · checked ' + ago(s.syncedAt) : '') +
				(busy && s.progress ? ' · updating ' + num(s.progress.done) + ' of ' + num(s.progress.total) : '') +
				(s.lastError ? ' · ' + s.lastError : ''),
				[button('Check Now', async (e) => {
					e.currentTarget.disabled = true;
					games = await window.native.games.update();
					draw();
				}, { kind: 'small', disabled: busy || !navigator.onLine }),
				button('Download Again', async (e) => {
					const btn = e.currentTarget;
					const sure = await app.confirm({ title: 'Download the games again?', message: 'The copy on this computer is deleted and fetched fresh from empanadas.io. Your saves are not touched.', confirm: 'Download Again' });
					if (!sure) return;
					btn.disabled = true;
					games = await window.native.games.clear();
					draw();
				}, { kind: 'small', disabled: busy || !navigator.onLine })], 'download')
		];
		for (const name of GAME_ORDER) {
			const ready = s.games && s.games[name] && s.games[name].ready;
			rows.push(setting(GAMES[name].full,
				ready ? 'Downloaded. Plays without a connection.' : (busy ? 'Downloading…' : 'Not fully downloaded yet.'),
				ready ? h('span', { class: 'badge success' }, icon('check'), 'Ready') : h('span', { class: 'badge' }, busy ? 'Downloading' : 'Online only')));
		}
		return rows;
	}

	// Which copy of the screens this is (lib/resources.js in the app).
	function looksText(r) {
		const checked = r.checkedAt ? ' Checked ' + ago(r.checkedAt) + '.' : '';
		if (r.serving) return 'The latest from empanadas.io, updated ' + ago(r.updatedAt) + '.' + checked;
		return 'Built into this version of the app.' + (r.enabled ? checked : '');
	}

	// Apps from before versions were in native.info() (these screens can
	// reach them over the air) still say them in the user agent.
	function fromUserAgent(name) {
		const m = new RegExp('\\b' + name + '/([0-9.]+)').exec(navigator.userAgent || '');
		return m ? m[1] : null;
	}

	function versionLines() {
		const v = Object.assign({ electron: fromUserAgent('Electron'), chrome: fromUserAgent('Chrome') }, info.versions || {});
		return [
			['Empanadas.io', info.version ? info.version + (info.packaged === false ? ' (from source)' : '') : null],
			['Electron', v.electron],
			['Chromium', v.chrome],
			['Node.js', v.node],
			['V8', v.v8],
			['System', info.os ? info.os + (info.arch ? ' (' + info.arch + ')' : '') : (PLATFORM[info.platform] || info.platform)]
		].filter(([, value]) => value);
	}

	function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).catch(() => copyBySelection(text));
		}
		return copyBySelection(text);
	}

	function copyBySelection(text) {
		const area = h('textarea', { 'aria-hidden': 'true', style: { position: 'fixed', top: '-1000px', opacity: '0' } });
		area.value = text;
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		area.remove();
		return ok ? Promise.resolve() : Promise.reject(new Error('not copied'));
	}

	function aboutRows() {
		const lines = versionLines();
		const rows = lines.map(([label, value]) => h('div', { class: 'setting version-row' },
			h('div', { class: 'main' }, h('div', { class: 'title' }, label)),
			h('div', { class: 'control' }, h('code', { class: 'selectable' }, value))));
		if (looks) rows.push(setting('App Components', looksText(looks), null));
		const ua = info.userAgent || navigator.userAgent;
		if (ua) {
			rows.push(h('div', { class: 'setting' },
				h('div', { class: 'main' },
					h('div', { class: 'title' }, 'User Agent'),
					h('div', { class: 'desc selectable mono-wrap' }, ua))));
		}
		rows.push(setting('Copy Version Info', 'For a bug report or Send Feedback.',
			button('Copy', async () => {
				const text = lines.map(([label, value]) => label + ': ' + value).join('\n') +
					(ua ? '\nUser Agent: ' + ua : '');
				try {
					await copyText(text);
					app.toast('Copied the version info.', 'success');
				} catch (err) {
					app.toast('Couldn’t copy. Select the text instead.', 'error');
				}
			}, { kind: 'small' }), 'info'));
		return rows;
	}

	// The Server Status card from the site's Updates page: a light that says
	// how the servers are, pulsing while it is kept up to date, and the full
	// status page behind it (statussheet.js).
	function statusRows() {
		const online = navigator.onLine;
		const text = online ? levelOf(serverLevel).title : 'You’re Offline';
		const row = h('button', {
			type: 'button', class: 'setting status-row',
			'aria-label': 'Server status: ' + text + '. Opens the full status page.'
		},
		h('span', { class: 'status-light' }, online ? statusDot(serverLevel) : icon('offline')),
		h('div', { class: 'main' },
			h('div', { class: 'title' }, text),
			h('div', { class: 'desc' }, online ? 'View the full status page' : 'The status shows once you’re back online.')),
		icon('chevron', 'trail'));
		row.addEventListener('click', () => openStatusSheet());
		return [row];
	}

	async function checkStatus(force = false) {
		if (!hasStatus || !navigator.onLine) return;
		const r = await window.native.status.get(force).catch(() => null);
		const next = r && r.level ? r.level : 'unknown';
		if (next !== serverLevel) {
			serverLevel = next;
			draw();
		}
	}

	function draw() {
		replace(inner,
			h('div', { class: 'page-head' }, h('h1', null, 'App Settings')),
			group('Updates', updateRows()),
			group('This Computer', [
				setting('Keep Spinning When Closed', bg.available
					? 'Closing the window during Spin keeps your Auto Spinners going from the ' + (info.isMac ? 'menu bar' : 'system tray') + ', until 100,000 Spins.'
					: 'Not available on this computer.',
				toggle(bg.enabled, async (on) => {
					bg = await window.native.background.set(on);
					return bg.enabled === on;
				}, { disabled: !bg.available, label: 'Keep Spinning When Closed' })),
				setting('Friend Request Notifications', 'When the app is in the background.', toggle(prefs.notifications !== false, async (on) => {
					prefs = await window.native.prefs.set({ notifications: on });
					return true;
				}, { label: 'Notifications' }))
			]),
			group('Storage', storageRows()),
			group('About This App', aboutRows()),
			hasStatus ? group('Server Status', statusRows()) : null,
			h('section', { class: 'settings-group' }, h('div', { class: 'card' },
				setting('Account Settings', 'Theme, privacy, email, passkeys and save points.',
					button('Open', () => app.navigate({ screen: 'settings' }), { kind: 'small' }), 'user'))));
	}

	draw();
	Promise.all([
		window.native.info(), window.native.background.status(), window.native.updater.state(),
		window.native.cache.size(), window.native.prefs.get(), window.native.games.status(),
		window.native.resources ? window.native.resources.status().catch(() => null) : null
	].map((p) => Promise.resolve(p).catch(() => null))).then(([i, b, u, c, p, g, r]) => {
		info = i || info;
		bg = b || bg;
		update = u || update;
		cacheBytes = c ? c.bytes : null;
		prefs = p || prefs;
		games = g || games;
		looks = r || null;
		draw();
	});
	offs.push(window.native.updater.onState((s) => { update = s; draw(); }));
	if (hasStatus) {
		checkStatus();
		// Every minute while the row is showing, so the light is live.
		const timer = setInterval(() => checkStatus(), STATUS_EVERY);
		const onOnline = () => { draw(); checkStatus(true); };
		const onOffline = () => draw();
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		offs.push(() => {
			clearInterval(timer);
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		});
	}
	offs.push(app.on('games', (s) => { games = s; draw(); }));
	offs.push(app.on('background', (s) => { bg = s; draw(); }));

	return {
		title: 'App Settings',
		refresh: () => Promise.all([
			window.native.cache.size().then((c) => { cacheBytes = c ? c.bytes : cacheBytes; draw(); }),
			checkStatus(true)
		]),
		destroy() { offs.forEach((off) => off()); }
	};
}
