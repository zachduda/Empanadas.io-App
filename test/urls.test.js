'use strict';

// lib/urls.js decides where the shell will navigate and which pages may open a
// window of their own. It requires nothing from Electron, so it tests directly.

const assert = require('assert');
const {
	isAppUrl, isAuthUrl, isSsoUrl, isPopupUrl, isHandoffUrl, browserUserAgent
} = require('../lib/urls');

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

check('the popup may follow the post-sign-in roundabout', () => {
	// js.php sends the browser round the sibling sites so each sees the new
	// session. Blocking them left the popup stuck on "Please Wait...".
	assert(isSsoUrl('https://zachduda.com/v2/roundabout'), 'zachduda.com');
	assert(isSsoUrl('https://www.he1ium.com/'), 'he1ium.com');
	assert(isPopupUrl('https://zachduda.com/v2/roundabout'), 'the popup may go there');
	assert(isPopupUrl('https://empanadas.io/v2/auth/flow.php?service=github'), 'the site');
	assert(isPopupUrl('https://github.com/login/oauth/authorize'), 'a provider');
	assert(!isSsoUrl('https://zachduda.com.evil.test/'), 'a lookalike');
	assert(!isSsoUrl('http://zachduda.com/'), 'plain http');
	assert(!isPopupUrl('https://example.com/'), 'anywhere else');
	assert(!isAppUrl('https://zachduda.com/'), 'a sibling site is not the app');
});

check('a popup hands ordinary pages back to the main window', () => {
	assert(isHandoffUrl('https://empanadas.io/v2/account?linked=github'), 'the account page');
	assert(isHandoffUrl('https://empanadas.io/v2/account/'), 'with a trailing slash');
	assert(isHandoffUrl('https://empanadas.io/v2/dashboard'), 'the dashboard');
	assert(isHandoffUrl('https://empanadas.io/v2/login?error=oauth_err'), 'a provider error');
});

check('a popup keeps the pages that are still mid-sign-in', () => {
	assert(!isHandoffUrl('https://empanadas.io/v2/auth/flow.php?code=x'), 'the OAuth callback');
	assert(!isHandoffUrl('https://empanadas.io/v2/auth/js.php?r=v2/dashboard'), 'the hand-off page');
	assert(!isHandoffUrl('https://empanadas.io/v2/auth/2fa.php'), 'the 2FA prompt');
	assert(!isHandoffUrl('https://empanadas.io/authcancel.html'), 'the page that closes itself');
	assert(!isHandoffUrl('https://empanadas.io/v2/account_edit.php?403=1'), 'the captcha check');
	assert(!isHandoffUrl('https://empanadas.io/v2/accounts'), 'a path that only starts the same');
	assert(!isHandoffUrl('https://github.com/v2/account'), 'another host');
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
