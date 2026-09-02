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
	'discordapp.com'
]);

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

module.exports = { APP_HOST, AUTH_HOSTS, isAppUrl, isAuthUrl, browserUserAgent };
