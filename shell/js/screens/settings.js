// Settings: the account and its settings from /v2/app/account.php, changed
// through account_edit.php; the app's own (Keep Spinning When Closed,
// notifications, the kept games, the cache, updates); sign out and delete.
// Email and username, connections, passkeys, two-factor and the picture are
// the site's own pages, in a window of their own.

import { h, replace, button, icon, avatar } from '../dom.js';
import { num, ago, bytes, GAMES, GAME_ORDER } from '../format.js';
import { load, staleBanner, errorState, skeleton } from '../data.js';

const UPDATE_TEXT = {
	idle: 'You’re on the latest version as far as we know.',
	checking: 'Checking for updates…',
	'up-to-date': 'You’re up to date.',
	available: 'A new version is available.',
	downloading: 'Downloading the update…',
	verifying: 'Checking the update’s signature…',
	ready: 'The update is ready to install.',
	installing: 'Installing…',
	declined: 'Update postponed.',
	error: 'Couldn’t check for updates.'
};

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner narrow' });
	replace(container, inner);

	let last = null;
	let info = app.state.info || {};
	let games = app.state.games;
	let bg = { available: false, enabled: false };
	let update = { status: 'idle' };
	let cacheBytes = null;
	let looks = null;
	let prefs = { notifications: true };
	const offs = [];

	function setting(title, desc, control, leadIcon) {
		return h('div', { class: 'setting' },
			leadIcon ? icon(leadIcon, 'lead') : null,
			h('div', { class: 'main' }, h('div', { class: 'title' }, title), desc ? h('div', { class: 'desc' }, desc) : null),
			h('div', { class: 'control' }, control));
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

	// One account setting, saved as it changes; put back if the site refuses.
	function accountToggle(field, settings, { invert = false } = {}) {
		const value = Number(settings[field]) === 1;
		return toggle(invert ? !value : value, async (on) => {
			const v = (invert ? !on : on) ? 1 : 0;
			const result = await window.native.data.act('updateSetting', { field, value: v });
			if (!result.ok) {
				app.toast(result.error.message, 'error');
				return false;
			}
			settings[field] = v;
			return true;
		}, { disabled: !navigator.onLine, label: field });
	}

	function themeControl(settings) {
		const current = Number(settings.theme) || 0;
		return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme' },
			[['System', 0], ['Light', 1], ['Dark', 2]].map(([label, value]) => h('button', {
				type: 'button',
				'aria-pressed': String(current === value),
				onclick: async () => {
					await window.native.theme.set(value);
					settings.theme = value;
					draw();
					const result = await window.native.data.act('updateSetting', { field: 'theme', value });
					if (!result.ok) app.toast(result.error.message, 'error');
				}
			}, label)));
	}

	function gameRows() {
		const s = games || {};
		const rows = GAME_ORDER.map((name) => {
			const ready = s.games && s.games[name] && s.games[name].ready;
			return setting(GAMES[name].full,
				ready ? 'Downloaded. Plays without a connection.' : (s.syncing ? 'Downloading…' : 'Not fully downloaded yet.'),
				ready ? h('span', { class: 'badge success' }, icon('check'), 'Ready') : h('span', { class: 'badge' }, s.syncing ? 'Downloading' : 'Online only'));
		});
		const busy = !!s.syncing;
		rows.push(setting('Game Files',
			(s.files ? num(s.files) + ' files, ' + bytes(s.bytes) : 'Nothing kept yet') +
			(s.syncedAt ? ' · checked ' + ago(s.syncedAt) : '') +
			(busy && s.progress ? ' · updating ' + num(s.progress.done) + ' of ' + num(s.progress.total) : '') +
			(s.lastError ? ' · ' + s.lastError : ''),
			[button('Check Now', async (e) => {
				const btn = e.currentTarget;
				btn.disabled = true;
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
			}, { kind: 'small', disabled: busy || !navigator.onLine })], 'download'));
		rows.push(setting('Save Points', 'Missing or overwrote your progress? Put an earlier save back.',
			button('Manage', () => app.navigate({ screen: 'savepoints' }), { kind: 'small' }), 'history'));
		return rows;
	}

	function draw() {
		const result = last;
		if (!result) {
			replace(inner, skeleton(6, 30));
			return;
		}
		if (!result.data) {
			replace(inner, errorState(result, refresh));
			return;
		}
		const d = result.data;
		const a = d.account || {};
		const s = d.settings || {};
		const connections = Array.isArray(a.connections) ? a.connections : [];

		const header = h('div', { class: 'card', style: { marginBottom: '22px' } },
			h('div', { class: 'profile-head' },
				avatar(a.pfp, 'lg'),
				h('div', { class: 'who' },
					h('h1', null, a.username || 'You'),
					h('div', { class: 'facts' },
						h('span', { class: 'selectable' }, a.email || ''),
						a.email_verified ? h('span', { class: 'badge success' }, icon('check'), 'Verified') : h('span', { class: 'badge danger' }, 'Not verified'),
						a.pending_email ? h('span', null, 'Changing to ' + a.pending_email) : null)),
				h('div', { class: 'actions' },
					button('View Profile', () => app.navigate({ screen: 'profile' }), { kind: 'small' }),
					button('Change Picture', () => window.native.site.open('picture'), { kind: 'small' }))));

		replace(inner,
			h('div', { class: 'page-head' }, h('h1', null, 'Settings')),
			staleBanner(result, refresh),
			header,
			group('Account', [
				!a.email_verified ? setting('Verify Your Email', 'Unlocks your status, friend requests and more.', button('Verify', () => window.native.site.open('verifyEmail'), { kind: 'small primary' }), 'mail') : null,
				setting('Email, Username and Password', 'Change them on your account page.', button('Open', () => window.native.site.open('account'), { kind: 'small', icon: 'external' }), 'user'),
				setting('Connected Accounts', connections.length ? connections.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(', ') : 'Sign in with Google, GitHub or Discord.', button('Manage', () => window.native.site.open('account'), { kind: 'small', icon: 'external' }), 'link'),
				setting('Passkeys', a.passkeys ? num(a.passkeys) + ' saved' : 'Sign in without a password.', button('Manage', () => window.native.site.open('account'), { kind: 'small', icon: 'external' }), 'shield'),
				setting('Two-Factor Authentication', a.two_factor ? 'On' : 'Off', button(a.two_factor ? 'Manage' : 'Turn On', () => window.native.site.open('twoFactor'), { kind: 'small', icon: 'external' }), 'shield')
			]),
			group('Appearance', [setting('Theme', 'Follows your account everywhere you play.', themeControl(s), 'sun')]),
			group('Privacy', [
				setting('Public Profile', 'Anyone can see your stats. Off: only your friends.', accountToggle('publicaccount', s)),
				d.has_birthday ? setting('Show Star Sign', 'On your profile, for your friends.', accountToggle('starsign', s)) : null,
				setting('Allow Friend Requests', null, accountToggle('allownf', s)),
				setting('Help Improve Empanadas.io', 'Anonymous usage analytics.', accountToggle('analytics', s))
			]),
			group('Email', [
				setting('New Sign-In Alerts', 'An email when your account signs in somewhere new.', accountToggle('newsignins', s)),
				setting('Weekly Recap', null, accountToggle('recapemails', s)),
				setting('News and Promotions', null, accountToggle('promoemails', s)),
				setting('Everything Else', null, accountToggle('otheremails', s))
			]),
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
				}, { label: 'Notifications' })),
				setting('Cache', cacheBytes === null ? 'Working it out…' : bytes(cacheBytes) + '. Clearing it keeps you signed in and keeps your saves and games.',
					button('Clear Cache', async (e) => {
				const btn = e.currentTarget;
						btn.disabled = true;
						const r = await window.native.cache.clear();
						app.toast(r && r.ok ? 'Cache cleared.' : 'Part of the cache couldn’t be cleared.', r && r.ok ? 'success' : 'error');
						cacheBytes = (await window.native.cache.size()).bytes;
						draw();
					}, { kind: 'small' }))
			]),
			group('Games', gameRows()),
			group('About', [
				setting('Empanadas.io ' + (info.version || ''), UPDATE_TEXT[update.status] + (update.status === 'error' && update.error ? ' ' + update.error : '') +
					(update.version && update.status !== 'up-to-date' && update.status !== 'idle' ? ' (' + update.version + ')' : ''),
				button('Check for Updates', async (e) => {
				const btn = e.currentTarget;
					btn.disabled = true;
					await window.native.updater.check();
				}, { kind: 'small', disabled: ['checking', 'downloading', 'verifying', 'installing'].includes(update.status) }), 'download'),
				looks ? setting('App Design', looksText(looks), null) : null,
				setting('Send Feedback', 'Ideas, problems, questions.', button('Write', () => app.navigate({ screen: 'feedback' }), { kind: 'small' }), 'message'),
				setting('Website', null, button('Open', () => window.native.external.open('website'), { kind: 'small', icon: 'external' })),
				setting('Privacy Policy', null, button('Open', () => window.native.external.open('privacy'), { kind: 'small', icon: 'external' })),
				setting('Terms of Service', null, button('Open', () => window.native.external.open('terms'), { kind: 'small', icon: 'external' }))
			]),
			h('section', { class: 'settings-group' }, h('div', { class: 'card' },
				setting('Sign Out', 'Your games stay downloaded on this computer.', button('Sign Out', async (e) => {
				const btn = e.currentTarget;
					const sure = await app.confirm({ title: 'Sign out of Empanadas.io?', confirm: 'Sign Out' });
					if (!sure) return;
					btn.disabled = true;
					await window.native.session.signOut();
				}, { kind: 'small', icon: 'logout' })),
				setting('Delete Account', 'Deletes your account, saves and friends for good.', button('Delete…', async () => {
					const typed = await app.confirm({
						title: 'Delete your account?',
						message: 'This can’t be undone. Type DELETE to confirm.',
						confirm: 'Delete Account',
						danger: true,
						input: { placeholder: 'DELETE', match: 'DELETE' }
					});
					if (typed !== 'DELETE') return;
					const r = await window.native.data.act('deleteAccount', { confirmation: typed });
					if (!r.ok) app.toast(r.error.message, 'error');
				}, { kind: 'small danger' })))));
	}

	// Which copy of the screens this is (lib/resources.js in the app).
	function looksText(r) {
		const checked = r.checkedAt ? ' Checked ' + ago(r.checkedAt) + '.' : '';
		if (r.serving) return 'The latest from empanadas.io, updated ' + ago(r.updatedAt) + '.' + checked;
		if (!r.enabled) return 'Built into this version of the app.';
		return 'Built into this version of the app.' + checked;
	}

	function render(result) {
		if (!result || (!result.data && last && last.data)) return;
		last = result;
		draw();
	}

	function refresh() {
		return load('account', {}, render, { cached: false });
	}

	draw();
	load('account', {}, render);
	Promise.all([
		window.native.info(), window.native.background.status(), window.native.updater.state(),
		window.native.cache.size(), window.native.prefs.get(), window.native.games.status(),
		window.native.resources ? window.native.resources.status().catch(() => null) : null
	]).then(([i, b, u, c, p, g, r]) => {
		looks = r || null;
		info = i || info;
		bg = b || bg;
		update = u || update;
		cacheBytes = c ? c.bytes : null;
		prefs = p || prefs;
		games = g || games;
		draw();
	});
	offs.push(window.native.updater.onState((s) => { update = s; draw(); }));
	offs.push(app.on('games', (s) => { games = s; draw(); }));
	offs.push(app.on('background', (s) => { bg = s; draw(); }));

	return {
		title: 'Settings',
		refresh,
		destroy() { offs.forEach((off) => off()); }
	};
}
