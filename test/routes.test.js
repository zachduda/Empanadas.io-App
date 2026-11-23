'use strict';

// lib/routes.js (where an empanadas-io:// link or a link to the site opens
// in the app) and the picture cache's address check (lib/imagecache.js).

const assert = require('assert');
const { deepLinkRoute, siteRoute, isGameExitUrl, gameOfUrl } = require('../lib/routes');
const { pictureUrl } = require('../lib/imagecache');

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

const ID = 'ab12cd34-0000-1111-2222-333344445555';

check('deep links open the app\'s screens', () => {
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://home'), { screen: 'home' });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://leaderboard'), { screen: 'leaderboard' });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://play/spin'), { play: 'spin' });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://play/Tower'), { play: 'tower' });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://profile'), { screen: 'profile' });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://profile/' + ID.toUpperCase()), { screen: 'profile', id: ID });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://feedback?reason=5'), { screen: 'feedback', reason: 5 });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://updates/abc123'), { screen: 'updates', id: 'abc123' });
	assert.deepStrictEqual(deepLinkRoute('empanadas-io://appsettings'), { screen: 'appsettings' });
});

check('anything else is not a route', () => {
	for (const link of ['empanadas-io://play/doom', 'empanadas-io://profile/../../x', 'empanadas-io://settings/extra',
		'empanadas-io://nowhere', 'https://empanadas.io/spin', 'empanadas-io://feedback?reason=-1&x=1', 'not a url']) {
		const route = deepLinkRoute(link);
		assert.ok(route === null || (route.screen === 'feedback' && route.reason === null), link + ' gave ' + JSON.stringify(route));
	}
});

check('a game\'s own close button closes it', () => {
	for (const url of ['https://empanadas.io/', 'https://empanadas.io/#games', 'https://empanadas.io/index.html',
		'https://empanadas.io/v2/dashboard', 'https://empanadas.io/v2/dashboard.php?x=1']) {
		assert.ok(isGameExitUrl(url), url);
	}
	assert.ok(!isGameExitUrl('https://empanadas.io/spin'));
	assert.ok(!isGameExitUrl('https://evil.com/v2/dashboard'));
	assert.strictEqual(gameOfUrl('https://empanadas.io/spin.html?au=1'), 'spin');
	assert.strictEqual(gameOfUrl('https://empanadas.io.evil.com/spin'), null);
});

check('links to the site open the app\'s own screen where it has one', () => {
	assert.deepStrictEqual(siteRoute('https://empanadas.io/v2/profile/' + ID), { screen: 'profile', id: ID });
	assert.deepStrictEqual(siteRoute('https://empanadas.io/v2/profile?search=1'), { screen: 'friends' });
	assert.deepStrictEqual(siteRoute('https://empanadas.io/v2/feedback?reason=5'), { screen: 'feedback', reason: 5 });
	assert.deepStrictEqual(siteRoute('https://empanadas.io/leaderboard.html'), { screen: 'leaderboard' });
	assert.deepStrictEqual(siteRoute('https://empanadas.io/updates?post=nw2026'), { screen: 'updates', id: 'nw2026' });
	assert.deepStrictEqual(siteRoute('https://empanadas.io/flappy'), { play: 'flappy' });
	assert.strictEqual(siteRoute('https://empanadas.io/v2/account_2fa'), null);
	assert.strictEqual(siteRoute('https://example.com/v2/profile'), null);
});

check('the picture cache only fetches the site\'s pictures, over https', () => {
	assert.strictEqual(pictureUrl('/pfp/lg/a.png'), 'https://empanadas.io/pfp/lg/a.png');
	assert.strictEqual(pictureUrl('https://cdn.empanadas.io/x.png#y'), 'https://cdn.empanadas.io/x.png');
	for (const bad of ['http://empanadas.io/a.png', 'https://evil.com/a.png', 'https://empanadas.io.evil.com/a.png',
		'file:///etc/passwd', 'https://user:pw@empanadas.io/a.png', 'https://empanadas.io:8080/a.png', '', null, 42]) {
		assert.strictEqual(pictureUrl(bad), null, String(bad));
	}
});

if (failures.length) {
	console.error('\n' + failures.length + ' routes test(s) failed');
	process.exit(1);
}
