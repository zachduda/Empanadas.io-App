'use strict';

// lib/urls.js decides where the shell will navigate and which pages may open a
// window of their own. It requires nothing from Electron, so it tests directly.

const assert = require('assert');
const { isAppUrl, isAuthUrl, browserUserAgent } = require('../lib/urls');

const failures = [];

function check(what, fn) {
	try {
		fn();
		console.log('  ok    ' + what);
	} catch (err) {
		failures.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	}
}

check('recognises the site and its subdomains', () => {
	assert(isAppUrl('https://empanadas.io/'), 'the apex host');
	assert(isAppUrl('https://www.empanadas.io/play'), 'a subdomain');
});

check('rejects lookalikes and downgrades', () => {
	assert(!isAppUrl('https://empanadas.io.example.com/'), 'a suffixed lookalike');
	assert(!isAppUrl('https://empanadas.io@example.com/'), 'a userinfo trick');
	assert(!isAppUrl('https://notempanadas.io/'), 'an unrelated host');
	assert(!isAppUrl('http://empanadas.io/'), 'plain http');
	assert(!isAppUrl('not a url'), 'an unparseable string');
});

check('recognises the sign-in providers', () => {
	assert(isAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), 'Google');
	assert(isAuthUrl('https://github.com/login/oauth/authorize?client_id=x'), 'GitHub');
	assert(isAuthUrl('https://discord.com/oauth2/authorize?client_id=x'), 'Discord');
});

check('does not treat the whole provider domain as a sign-in host', () => {
	// The allowlist is exact hosts: a popup that can go anywhere on google.com
	// is not the narrow exception this is meant to be.
	assert(!isAuthUrl('https://drive.google.com/'), 'another Google property');
	assert(!isAuthUrl('https://gist.github.com/'), 'another GitHub property');
	assert(!isAuthUrl('https://accounts.google.com.evil.test/'), 'a lookalike');
	assert(!isAuthUrl('http://accounts.google.com/'), 'plain http');
});

check('the site is not an auth host, and vice versa', () => {
	assert(!isAuthUrl('https://empanadas.io/'), 'the site is not a provider');
	assert(!isAppUrl('https://accounts.google.com/'), 'a provider is not the site');
});

check('the auth user agent names neither Electron nor the app', () => {
	const real = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
		'(KHTML, like Gecko) Empanadas.io/1.11.0 Chrome/140.0.0.0 ' +
		'Electron/44.1.1 Safari/537.36';
	// app.getName() returns package.json's name, which is cased differently
	// from the token in the user agent.
	const clean = browserUserAgent(real, 'empanadas.io');
	assert(!/Electron/.test(clean), 'still names Electron: ' + clean);
	assert(!/Empanadas\.io/.test(clean), 'still names the app: ' + clean);
	// What is left has to still look like Chrome, or the providers serve a
	// "browser not supported" page instead.
	assert(/Chrome\/\d/.test(clean), 'lost the Chrome token: ' + clean);
	assert(/Safari\/537\.36$/.test(clean), 'lost the Safari suffix: ' + clean);
	assert(!/ {2}/.test(clean), 'left a double space: ' + clean);
});

module.exports = { failures };

if (require.main === module) {
	if (failures.length) {
		console.error(failures.length + ' check(s) failed');
		process.exit(1);
	}
}
