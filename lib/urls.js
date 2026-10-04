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

// "Log in with Google/GitHub/Discord" happens in the default browser, not in a
// window of the app's. The site sends the app to /v2/auth/browser?t=<ticket>
// when it wants that, and the app opens it in the browser rather than loading
// it. The browser signs in with the provider - where the visitor is usually
// signed in already - and hands the result back with an empanadas-io://auth
// link, which authRedeemUrl() turns into the page that finishes the sign-in
// in the app. The site's half is described above appAuthIssue() in its
// v2/_lib.php.
const BROWSER_SIGNIN_PATHS = ['/v2/auth/browser', '/v2/auth/browser.php'];

// Tickets and codes are random letters and digits; see appAuthToken() in the
// site's v2/_lib.php.
const AUTH_TOKEN = /^[A-Za-z0-9]{32,128}$/;
const AUTH_SERVICE = /^[a-z]{2,16}$/;

function isBrowserSignInUrl(url) {
	if (!isAppUrl(url)) return false;
	const parsed = new URL(url);
	return BROWSER_SIGNIN_PATHS.includes(parsed.pathname) &&
		AUTH_TOKEN.test(parsed.searchParams.get('t') || '');
}

// Is this one of the empanadas-io://auth links a browser sign-in comes back
// with? Those are the app's to handle, and are never passed on to the page.
function isAuthDeepLink(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'empanadas-io:' && parsed.hostname === 'auth';
	} catch (err) {
		return false;
	}
}

// The page that finishes a browser sign-in, from the link that came back, or
// null if the link is not one. Anything on the machine can open an
// empanadas-io:// link, so every part is checked against the shape the site
// produces rather than passed along as it came.
function authRedeemUrl(url) {
	if (!isAuthDeepLink(url)) return null;
	const parsed = new URL(url);
	if (parsed.pathname !== '' && parsed.pathname !== '/') return null;
	const service = parsed.searchParams.get('service') || '';
	const ticket = parsed.searchParams.get('t') || '';
	const code = parsed.searchParams.get('c') || '';
	if (!AUTH_SERVICE.test(service) || !AUTH_TOKEN.test(ticket) || !AUTH_TOKEN.test(code)) {
		return null;
	}
	const out = new URL('https://' + APP_HOST + '/v2/auth/flow.php');
	out.searchParams.set('service', service);
	out.searchParams.set('app_ticket', ticket);
	out.searchParams.set('app_code', code);
	return out.href;
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
	isBrowserSignInUrl, isAuthDeepLink, authRedeemUrl,
	browserUserAgent
};
