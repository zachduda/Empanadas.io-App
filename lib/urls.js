'use strict';

// Which URLs the shell will load, and where. Kept out of main.js so it can be
// tested without a running Electron - a mistake in here is either a hole in the
// navigation filter or a sign-in flow that silently stops working.

// The one place that decides what counts as "our site". A startsWith() check on
// the URL string is not good enough: 'https://empanadas.io.example.com' and
// 'https://empanadas.io@example.com' both pass a prefix test while pointing
// somewhere else entirely. Parse it and compare the host.
const APP_HOST = 'empanadas.io';

// Hosts that sign a user in. These are the only off-site pages allowed to open
// in a window of their own, and only in the popup the site asks for - never in
// the main window, which is where the preload and the updater bridge live.
//
// Exact hosts, no suffix matching: '*.google.com' would cover every Google
// property, and this list exists to be small.
const AUTH_HOSTS = new Set([
	// Google
	'accounts.google.com',
	// GitHub (login, 2FA and the consent screen all sit on the apex host)
	'github.com',
	'www.github.com',
	// Discord, including the release channels people actually browse on
	'discord.com',
	'canary.discord.com',
	'ptb.discord.com',
	'discordapp.com',
	// Sign in with Apple. The site has the button, hidden for now; listing the
	// host means turning it on does not also need an app release.
	'appleid.apple.com',
	// Google hops through here to set its YouTube cookie on a fresh sign-in,
	// and a popup that cannot follow the hop sits on a blank page.
	'accounts.youtube.com'
]);

// The sites that share an account with empanadas.io. After a sign-in the site
// sends the browser round these ("the roundabout") so each one sees the new
// session. The non-empanadas.io entries of siteHosts() in the site's
// v2/_lib.php.
//
// Only the sign-in popup may visit them: they are not the app, and the main
// window is where the preload lives.
const SSO_HOSTS = new Set([
	'zachduda.com',
	'www.zachduda.com',
	'he1ium.com',
	'www.he1ium.com',
	'mountaineermetrics.com',
	'www.mountaineermetrics.com'
]);

// Pages a sign-in finishes on. When the popup is sent to one of these the
// flow is over, and the page belongs in the main window rather than in a
// 520px popup: the account page after linking GitHub, the dashboard after a
// sign-in that did not close itself, the login page showing a provider error.
//
// Everything else on the site stays in the popup - /v2/auth/*, the 2FA prompt,
// the captcha and "notify" pages - because those are still mid-flow and close
// themselves when they are done.
const HANDOFF_PATHS = [
	/^\/v2\/dashboard(\.php)?$/,
	/^\/v2\/account(\/|\/index\.php)?$/,
	/^\/v2\/login(\.php)?$/,
	/^\/v2\/profile(\.php)?$/
];

function hostOf(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (err) {
		return null;
	}
	// Everything here is https-only: an http hop is a downgrade, and for an
	// auth flow it is a downgrade carrying a token.
	if (parsed.protocol !== 'https:') return null;
	return parsed.hostname;
}

function isAppUrl(url) {
	const host = hostOf(url);
	if (!host) return false;
	return host === APP_HOST || host.endsWith('.' + APP_HOST);
}

function isAuthUrl(url) {
	const host = hostOf(url);
	return host !== null && AUTH_HOSTS.has(host);
}

function isSsoUrl(url) {
	const host = hostOf(url);
	return host !== null && SSO_HOSTS.has(host);
}

// Where a sign-in popup is allowed to go: the site, the providers, and the
// sibling sites the post-sign-in roundabout passes through.
function isPopupUrl(url) {
	return isAppUrl(url) || isAuthUrl(url) || isSsoUrl(url);
}

function isHandoffUrl(url) {
	if (!isAppUrl(url)) return false;
	const pathname = new URL(url).pathname.replace(/\/+$/, '') || '/';
	return HANDOFF_PATHS.some((re) => re.test(pathname));
}

// Google refuses OAuth from a user agent it recognises as an embedded browser
// ("disallowed_useragent"), and the default string names both this app and
// Electron. Strip those tokens for auth requests only: the rest of the app
// keeps identifying itself honestly to empanadas.io.
function browserUserAgent(userAgent, appName) {
	const drop = ['Electron'];
	if (appName) drop.push(appName);
	let out = userAgent;
	for (const token of drop) {
		const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// Case-insensitively: the app names itself 'empanadas.io' in
		// package.json and 'Empanadas.io' in the user agent.
		out = out.replace(new RegExp('\\s*\\b' + escaped + '\\/\\S+', 'gi'), '');
	}
	return out.replace(/\s{2,}/g, ' ').trim();
}

module.exports = {
	APP_HOST, AUTH_HOSTS, SSO_HOSTS,
	isAppUrl, isAuthUrl, isSsoUrl, isPopupUrl, isHandoffUrl,
	browserUserAgent
};
