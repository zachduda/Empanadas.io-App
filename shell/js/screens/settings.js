// Settings: one screen for the account's settings and the app's. The account
// and its settings come from /v2/app/account.php, changed through
// account_edit.php. The app's own settings (updates, the cache, the kept
// games, versions, Server Status: appsettings.js) are drawn below them and
// need no account, so they show offline and when the account can't load.
// Sign out and delete at the end. Email and username, connections, passkeys,
// two-factor and the picture are the site's own pages, in a window of their
// own.

import { h, replace, button, icon, avatar } from '../dom.js';
import { num } from '../format.js';
import { load, staleBanner, errorState, skeleton } from '../data.js';
import { setting, settingsGroup as group, settingSwitch as toggle } from '../components.js';
import { mountAppPart } from './appsettings.js';

// `params.section` 'app' starts at the app's part: empanadas-io://appsettings,
// from when App Settings was a screen of its own.
export function mount(container, { app, params = {} }) {
	const inner = h('div', { class: 'content-inner narrow' });
	const accountPart = h('div', { class: 'settings-part' });
	const appPart = h('div', { class: 'settings-part settings-app' });
	replace(container, inner);
	replace(inner, h('div', { class: 'page-head' }, h('h1', null, 'Settings')), accountPart, appPart, endPart());

	let last = null;
	// Once the account's part has its height, so the app's stays in place.
	let scrollToApp = params.section === 'app';
	function scrollIfAsked() {
		if (!scrollToApp) return;
		scrollToApp = false;
		requestAnimationFrame(() => appPart.scrollIntoView({ block: 'start' }));
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
			replace(accountPart, skeleton(6, 30));
			return;
		}
		if (!result.data) {
			// The app's own settings, below, don't need the account.
			replace(accountPart, errorState(result, refresh));
			scrollIfAsked();
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

		replace(accountPart,
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
			group('Game Data', [
				setting('Save Points', 'Missing or overwrote your progress? Put an earlier save back.',
					button('Manage', () => app.navigate({ screen: 'savepoints' }), { kind: 'small' }), 'history')
			]));
		scrollIfAsked();
	}

	// The end of the screen, account or not: the site's pages, sign out and
	// delete.
	function endPart() {
		return h('div', { class: 'settings-part' },
			group('Empanadas.io', [
				setting('Send Feedback', 'Ideas, problems, questions.', button('Write', () => app.navigate({ screen: 'feedback' }), { kind: 'small' }), 'message'),
				setting('Website', null, button('Open', () => window.native.external.open('website'), { kind: 'small', icon: 'external' })),
				setting('Privacy Policy', null, button('Open', () => window.native.external.open('privacy'), { kind: 'small', icon: 'external' })),
				setting('Terms of Service', null, button('Open', () => window.native.external.open('terms'), { kind: 'small', icon: 'external' }))
			]),
			group(null, [
				setting('Sign Out', 'Your games stay downloaded on this computer.', button('Sign Out', async (e) => {
					const btn = e.currentTarget;
					if (await app.signOut()) btn.disabled = true;
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
				}, { kind: 'small danger' }))
			]));
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
	const appSettings = mountAppPart(appPart, { app });

	return {
		title: 'Settings',
		refresh: () => Promise.all([refresh(), appSettings.refresh()]),
		destroy: () => appSettings.destroy()
	};
}
