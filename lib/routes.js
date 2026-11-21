'use strict';

// Where a link goes in the app.
//
//  - deepLinkRoute(): the empanadas-io:// links anything on the computer can
//    open (a browser, the jump list, the Dock menu). The same links as the
//    iOS app (ios/Empanadas/Core/Routes.swift): ://home, ://games,
//    ://leaderboard, ://settings, ://play/<game>, ://profile, ://profile/<id>,
//    ://friends, ://feedback (?reason=<subject>), ://updates (/<id>).
//    ://signin and ://auth finish sign-ins and are handled before this.
//  - siteRoute(): a link to the site from a game or a site page, which opens
//    the app's own screen when it has one rather than the site's page.
//
// A route is { screen, ...params } or { play: <game> }; null for "not ours".

const { isAppUrl } = require('./urls');

const GAMES = ['spin', 'flappy', 'tower'];
const SCREENS = new Set(['home', 'games', 'leaderboard', 'settings', 'friends', 'updates', 'feedback']);

const PLAYER_ID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const POST_ID = /^[A-Za-z0-9_-]{1,32}$/;

function reasonOf(url) {
	const reason = Number(url.searchParams.get('reason'));
	return Number.isInteger(reason) && reason >= 0 && reason < 100 ? reason : null;
}

function deepLinkRoute(link) {
	let url;
	try {
		url = new URL(link);
	} catch (err) {
		return null;
	}
	if (url.protocol !== 'empanadas-io:') return null;
	const host = url.hostname.toLowerCase();
	const parts = url.pathname.split('/').filter(Boolean);

	if (host === 'play' && parts.length === 1 && GAMES.includes(parts[0].toLowerCase())) {
		return { play: parts[0].toLowerCase() };
	}
	if (host === 'profile') {
		if (parts.length === 0) return { screen: 'profile' };
		if (parts.length === 1 && PLAYER_ID.test(parts[0])) return { screen: 'profile', id: parts[0].toLowerCase() };
		return null;
	}
	if (host === 'updates' && parts.length === 1 && POST_ID.test(parts[0])) return { screen: 'updates', id: parts[0] };
	if (parts.length) return null;
	if (host === 'feedback') return { screen: 'feedback', reason: reasonOf(url) };
	if (SCREENS.has(host)) return { screen: host };
	return null;
}

function normalizedPath(url) {
	return url.pathname.replace(/\.(html|php)$/, '').replace(/\/+$/, '') || '/';
}

// Where a game sends the player when they leave it: its own close button
// replaces the page with the homepage (/#games) or the dashboard. In the
// app's player that means "close the game".
function isGameExitUrl(link) {
	if (!isAppUrl(link)) return false;
	const p = normalizedPath(new URL(link));
	return p === '/' || p === '/index' || p === '/v2/dashboard';
}

function gameOfUrl(link) {
	if (!isAppUrl(link)) return null;
	const p = normalizedPath(new URL(link));
	const name = p.slice(1);
	return GAMES.includes(name) ? name : null;
}

function siteRoute(link) {
	if (!isAppUrl(link)) return null;
	const url = new URL(link);
	const p = normalizedPath(url);
	const game = gameOfUrl(link);
	if (game) return { play: game };
	if (p === '/' || p === '/index' || p === '/v2/dashboard') return { screen: 'home' };
	if (p === '/leaderboard' || p === '/v2/beta/leader') return { screen: 'leaderboard' };
	if (p === '/updates') {
		const post = url.searchParams.get('post');
		return post && POST_ID.test(post) ? { screen: 'updates', id: post } : { screen: 'updates' };
	}
	if (p === '/v2/feedback') return { screen: 'feedback', reason: reasonOf(url) };
	if (p === '/v2/profile') {
		return url.searchParams.get('search') ? { screen: 'friends' } : { screen: 'profile' };
	}
	const profile = /^\/v2\/profile\/([^/]+)$/.exec(p);
	if (profile && PLAYER_ID.test(profile[1])) return { screen: 'profile', id: profile[1].toLowerCase() };
	if (p === '/v2/account') return { screen: 'settings' };
	return null;
}

module.exports = { GAMES, deepLinkRoute, siteRoute, isGameExitUrl, gameOfUrl };
