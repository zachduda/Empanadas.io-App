// Settings: the account and its settings from /v2/app/account.php, changed
// through account_edit.php; sign out and delete. The app's own settings
// (updates, the cache, the kept games, versions) are App Settings
// (appsettings.js), which needs no account and works offline.
// Email and username, connections, passkeys, two-factor and the picture are
// the site's own pages, in a window of their own.

import { h, replace, button, icon, avatar } from '../dom.js';
import { num } from '../format.js';
import { load, staleBanner, errorState, skeleton } from '../data.js';

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner narrow' });
	replace(container, inner);

	let last = null;
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

	function draw() {
		const result = last;
		if (!result) {
			replace(inner, skeleton(6, 30));
			return;
		}
		if (!result.data) {
			// The app's own settings don't need the account.
			replace(inner, errorState(result, refresh),
				h('div', { class: 'row-flex', style: { justifyContent: 'center', marginTop: '12px' } },
					button('App Settings', () => app.navigate({ screen: 'appsettings' }), { kind: 'small', icon: 'sliders' })));
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
			group('App', [
				setting('App Settings', 'Updates, the cache, the games on this computer, and which version this is.',
					button('Open', () => app.navigate({ screen: 'appsettings' }), { kind: 'small' }), 'sliders'),
				setting('Save Points', 'Missing or overwrote your progress? Put an earlier save back.',
					button('Manage', () => app.navigate({ screen: 'savepoints' }), { kind: 'small' }), 'history')
			]),
			group('About', [
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

	return {
		title: 'Settings',
		refresh
	};
}
