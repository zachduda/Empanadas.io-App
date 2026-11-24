'use strict';

// shell/js/format.js: the desktop screens' numbers and dates. It is an ES
// module for the app's page, so it is loaded here as one, from its source.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const failures = [];

async function check(what, fn) {
	try {
		await fn();
		console.log('  ok    ' + what);
	} catch (err) {
		failures.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	}
}

(async () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'shell', 'js', 'format.js'), 'utf8');
	const format = await import('data:text/javascript,' + encodeURIComponent(src));

	await check('pumpkins only in September and October, by the clock in New York', () => {
		const { pumpkinSeason } = format;
		assert.strictEqual(pumpkinSeason(new Date('2026-09-01T04:00:00Z')), true, 'midnight on 1 September in New York');
		assert.strictEqual(pumpkinSeason(new Date('2026-09-01T03:59:00Z')), false, 'still 31 August in New York');
		assert.strictEqual(pumpkinSeason(new Date('2026-10-15T12:00:00Z')), true);
		assert.strictEqual(pumpkinSeason(new Date('2026-11-01T03:30:00Z')), true, 'November in UTC, still October in New York');
		assert.strictEqual(pumpkinSeason(new Date('2026-11-01T04:30:00Z')), false, 'November in New York');
		assert.strictEqual(pumpkinSeason(new Date('2026-11-24T12:00:00Z')), false);
		assert.strictEqual(pumpkinSeason(new Date('2027-03-01T12:00:00Z')), false);
	});

	await check('the screens ask the clock, not the answer, for pumpkins', () => {
		for (const screen of ['home.js', 'profile.js']) {
			const code = fs.readFileSync(path.join(__dirname, '..', 'shell', 'js', 'screens', screen), 'utf8');
			assert(/pumpkinSeason\(\)/.test(code), screen + ' no longer asks pumpkinSeason()');
			assert(!/pumpkin_season|\|\|\s*(d|stats)\.pumpkins\)/.test(code), screen + ' shows pumpkins out of season again');
		}
	});

	if (failures.length) {
		console.error('\n' + failures.length + ' format test(s) failed');
		process.exit(1);
	}
})();
