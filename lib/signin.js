'use strict';

// Signing in to the app, in the player's own browser.
//
// The app never shows the login page itself. It opens the site's
// /v2/auth/app.php in the default browser with a PKCE challenge (RFC 7636),
// where the player's password manager, passkeys and Google/GitHub/Discord
// sign-ins all just work, and the site hands the finished sign-in back with
// an empanadas-io://signin?code=<code> link. The app then redeems the code at
// /v2/ios/signin.php from its own session, with the verifier only it holds
// (lib/api.js redeemSignIn()). A code that goes astray - another app claiming
// the scheme, the browser's history - signs nobody in without the verifier.
//
// The same arrangement as the iOS app (ios/Empanadas/Auth/AppSignIn.swift);
// the site's half is described above APP_SIGNIN_TTL in its v2/_lib.php.
//
// Plain Node, so it can be tested without Electron.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SITE = 'https://empanadas.io';
const SCHEME = 'empanadas-io:';

// How long the site keeps a sign-in for the app (APP_SIGNIN_TTL).
const SIGNIN_TTL = 15 * 60 * 1000;

const MODES = new Set(['login', 'create']);

// Tickets and codes are random letters and digits; see appAuthToken() in the
// site's v2/_lib.php.
const AUTH_TOKEN = /^[A-Za-z0-9]{32,128}$/;

function base64url(buffer) {
	return Buffer.from(buffer).toString('base64')
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 32 random bytes, base64url: 43 characters.
function makeVerifier(random = crypto.randomBytes) {
	return base64url(random(32));
}

// base64url(SHA-256(verifier)): what the site is told.
function challengeFor(verifier) {
	return base64url(crypto.createHash('sha256').update(String(verifier), 'utf8').digest());
}

function modeOf(value) {
	return MODES.has(value) ? value : 'login';
}

// Where the browser starts: the site's username step, or Pick a Username.
function startUrl(challenge, mode) {
	const url = new URL(SITE + '/v2/auth/app.php');
	url.searchParams.set('challenge', challenge);
	url.searchParams.set('mode', modeOf(mode));
	return url.href;
}

function createRequest(mode, { now = Date.now(), verifier = makeVerifier() } = {}) {
	const challenge = challengeFor(verifier);
	return { mode: modeOf(mode), verifier, challenge, startedAt: now, url: startUrl(challenge, mode) };
}

function isFresh(request, now = Date.now()) {
	if (!request || typeof request.startedAt !== 'number') return false;
	const age = now - request.startedAt;
	return age >= 0 && age < SIGNIN_TTL;
}

function parseLink(link) {
	if (typeof link !== 'string' || link.length > 2048) return null;
	try {
		const url = new URL(link);
		return url.protocol === SCHEME ? url : null;
	} catch (err) {
		return null;
	}
}

// Is this one of the empanadas-io://signin links a sign-in comes back with?
function isSignInLink(link) {
	const url = parseLink(link);
	return !!url && url.hostname.toLowerCase() === 'signin';
}

// The code a sign-in link carries, or null if the link is not one. Anything
// on the machine can open an empanadas-io:// link, so it is checked against
// the shape the site produces (appSigninDeepLink()).
function signInCode(link) {
	if (!isSignInLink(link)) return null;
	const url = parseLink(link);
	if (url.pathname !== '' && url.pathname !== '/') return null;
	const code = url.searchParams.get('code') || '';
	return AUTH_TOKEN.test(code) ? code : null;
}

// The sign-in under way, kept on disk as well as in memory: on Windows the
// link comes back through a second launch of the app, and if the player quit
// meanwhile the verifier would otherwise be gone. Only for SIGNIN_TTL, and
// removed as soon as the sign-in is finished or cancelled.
function createPendingStore(file) {
	let current = null;

	try {
		const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (saved && typeof saved.verifier === 'string' && isFresh(saved)) {
			current = {
				mode: modeOf(saved.mode),
				verifier: saved.verifier,
				challenge: challengeFor(saved.verifier),
				startedAt: saved.startedAt
			};
			current.url = startUrl(current.challenge, current.mode);
		}
	} catch (err) {
		// Nothing pending.
	}

	function write() {
		try {
			if (!current) {
				fs.rmSync(file, { force: true });
				return;
			}
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const temp = file + '.tmp';
			fs.writeFileSync(temp, JSON.stringify({
				mode: current.mode, verifier: current.verifier, startedAt: current.startedAt
			}), { mode: 0o600 });
			fs.renameSync(temp, file);
		} catch (err) {
			// In memory only, then.
		}
	}

	return {
		get(now = Date.now()) {
			if (current && !isFresh(current, now)) {
				current = null;
				write();
			}
			return current;
		},
		start(mode, now = Date.now()) {
			current = createRequest(mode, { now });
			write();
			return current;
		},
		clear() {
			current = null;
			write();
		}
	};
}

module.exports = {
	SIGNIN_TTL, AUTH_TOKEN,
	base64url, makeVerifier, challengeFor, startUrl, createRequest, isFresh,
	isSignInLink, signInCode, createPendingStore
};
