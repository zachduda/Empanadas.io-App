'use strict';

// lib/serverstatus.js: the server status light in App Settings, from
// Statuspage's public API, as the site and the iOS app read it.

const assert = require('assert');
const { createServerStatus, levelOf, API } = require('../lib/serverstatus');

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

const reply = (body, status = 200) => ({ status, json: async () => body });

(async () => {
	await check('Statuspage\'s indicator, in the screens\' words', () => {
		assert.strictEqual(levelOf({ status: { indicator: 'none' } }), 'operational');
		assert.strictEqual(levelOf({ status: { indicator: 'minor' } }), 'minor');
		assert.strictEqual(levelOf({ status: { indicator: 'major' } }), 'major');
		assert.strictEqual(levelOf({ status: { indicator: 'critical' } }), 'critical');
		for (const odd of [null, 42, 'x', {}, { status: null }, { status: { indicator: 'maintenance' } },
			{ status: { indicator: '__proto__' } }, { status: { indicator: 'toString' } }]) {
			assert.strictEqual(levelOf(odd), 'unknown', JSON.stringify(odd));
		}
	});

	await check('asks the endpoint the site reads, and keeps the answer for a minute', async () => {
		let t = 1000;
		const asked = [];
		const s = createServerStatus({ now: () => t, fetch: async (url) => { asked.push(url); return reply({ status: { indicator: 'minor' } }); } });
		assert.strictEqual(s.current().level, 'checking');
		assert.strictEqual((await s.get()).level, 'minor');
		t += 30 * 1000;
		assert.strictEqual((await s.get()).level, 'minor');
		assert.deepStrictEqual(asked, [API]);
		t += 31 * 1000;
		await s.get();
		assert.strictEqual(asked.length, 2);
		await s.get(true);
		assert.strictEqual(asked.length, 3, 'forced');
	});

	await check('one question at a time', async () => {
		let calls = 0;
		const s = createServerStatus({ fetch: async () => { calls++; return reply({ status: { indicator: 'none' } }); } });
		const [a, b] = await Promise.all([s.get(), s.get(true)]);
		assert.strictEqual(calls, 1);
		assert.strictEqual(a.level, 'operational');
		assert.strictEqual(b.level, 'operational');
	});

	await check('no answer is unknown, and is asked again next time', async () => {
		let mode = 'throw';
		let calls = 0;
		const s = createServerStatus({ fetch: async () => {
			calls++;
			if (mode === 'throw') throw new Error('offline');
			if (mode === '500') return reply(null, 500);
			if (mode === 'junk') return { status: 200, json: async () => { throw new SyntaxError('bad'); } };
			return reply({ status: { indicator: 'none' } });
		} });
		assert.strictEqual((await s.get()).level, 'unknown');
		mode = '500';
		assert.strictEqual((await s.get()).level, 'unknown');
		mode = 'junk';
		assert.strictEqual((await s.get()).level, 'unknown');
		mode = 'ok';
		assert.strictEqual((await s.get()).level, 'operational');
		assert.strictEqual(calls, 4);
	});

	if (failures.length) {
		console.error('\n' + failures.length + ' server status test(s) failed');
		process.exit(1);
	}
})();
