'use strict';

// lib/background.js: Keep Spinning When Closed. What a mistake here costs is
// a player's save (a wrong spin count posted over the real one), a computer
// kept busy, or a background that never stops.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bg = require('../lib/background');

const failures = [];
const pending = [];

function check(what, fn) {
	const run = async () => {
		try {
			await fn();
			console.log('  ok    ' + what);
		} catch (err) {
			failures.push(what + ': ' + err.message);
			console.log('  FAIL  ' + what + ' - ' + err.message);
		}
	};
	pending.push(run);
}

function save(extra) {
	return Object.assign({
		Peppers: 40, Spins: 1000, Prestige: 1, Auto_Spinners: 10, Time_Travel: 0,
		Lifetime_Spins: 500, Rank: 2, Game_Version: 'v6.12.0'
	}, extra);
}

// A runner on fake clocks and a fake server.
function harness(opts = {}) {
	const t = { mono: 0, wall: 1_700_000_000_000, timers: [], posts: [], changes: [], stops: [], overloads: 0 };
	t.replies = opts.replies || [];
	t.load = opts.load || (() => ({ cpu: 0.1, freeMemory: null }));
	t.online = true;
	t.runner = bg.createRunner(bg.cleanHandoff({ save: save(opts.save), carry: opts.carry || 0 }), {
		post: async (fields) => {
			t.posts.push(JSON.parse(fields.data));
			const next = t.replies.length ? t.replies.shift() : { status: 200, body: '{"result":true}' };
			return typeof next === 'function' ? next() : next;
		},
		wall: () => t.wall,
		mono: () => t.mono,
		load: () => t.load(),
		online: () => t.online,
		setTimer: (fn, ms) => { const timer = { fn, ms }; t.timers.push(timer); return timer; },
		clearTimer: (timer) => { t.timers = t.timers.filter((x) => x !== timer); },
		onChange: (view) => t.changes.push(view),
		onStop: (why) => t.stops.push(why),
		onOverload: () => { t.overloads++; }
	});
	// Lets a minute go by and runs the tick that comes due.
	t.minute = async (ms = bg.TICK_MS) => {
		t.mono += ms;
		t.wall += ms;
		const timer = t.timers.shift();
		assert(timer, 'no tick was scheduled');
		await timer.fn();
	};
	return t;
}

console.log('background');

check('only Windows and macOS have it', () => {
	assert(bg.supported('win32') && bg.supported('darwin'));
	assert(!bg.supported('linux'));
});

check('the setting is off until it is turned on, and is remembered', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtest-'));
	const file = path.join(dir, 'background.json');
	assert.strictEqual(bg.createSettings(file).enabled(), false);
	bg.createSettings(file).set(true);
	assert.strictEqual(bg.createSettings(file).enabled(), true);
	fs.writeFileSync(file, '{"enabled":"yes"}');
	assert.strictEqual(bg.createSettings(file).enabled(), false, 'only true turns it on');
	fs.writeFileSync(file, 'not json');
	assert.strictEqual(bg.createSettings(file).enabled(), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

check('a handoff is checked before it is used', () => {
	assert.strictEqual(bg.cleanHandoff(null), null);
	assert.strictEqual(bg.cleanHandoff({}), null);
	assert.strictEqual(bg.cleanHandoff({ save: [1, 2] }), null);
	assert.strictEqual(bg.cleanHandoff({ save: save({ Auto_Spinners: 0 }) }), null, 'no Auto Spinners, nothing to do');
	assert.strictEqual(bg.cleanHandoff({ save: save({ Spins: 100000 }) }), null, 'at 100,000 the player has to Prestige');
	const big = save();
	for (let i = 0; i < 300; i++) big['k' + i] = i;
	assert.strictEqual(bg.cleanHandoff({ save: big }), null, 'too many keys');

	const out = bg.cleanHandoff({ save: save({ Spins: '1234.9', Auto_Spinners: 5000, Prestige: -3, Time_Travel: 'x' }), carry: 7 });
	assert.strictEqual(out.save.Spins, 1234);
	assert.strictEqual(out.save.Auto_Spinners, 1000, 'the game caps them at 1,000');
	assert.strictEqual(out.save.Prestige, 1);
	assert.strictEqual(out.save.Time_Travel, 0);
	assert.strictEqual(out.carry, 0, 'a carry is less than one spin');
	assert.strictEqual(out.save.Game_Version, 'v6.12.0', 'the rest of the save goes back as it came');
});

check('Auto Spinners: one spin a second each, times Prestige from 2', () => {
	assert.strictEqual(bg.autoRate({ Auto_Spinners: 10, Prestige: 1 }), 10);
	assert.strictEqual(bg.autoRate({ Auto_Spinners: 10, Prestige: 2 }), 20);
	assert.strictEqual(bg.autoRate({ Auto_Spinners: 3, Prestige: 7 }), 21);
	assert.strictEqual(bg.autoRate({ Auto_Spinners: 0, Prestige: 7 }), 0);
});

check('Time Travel makes the part of a tick it covers four times as quick', () => {
	const now = 1_000_000;
	// Bought 90s ago (always before the tick: it cannot be bought in the
	// tray), so it ended 29s ago, 31s into this 60s tick.
	const s = { Auto_Spinners: 1, Prestige: 1, Time_Travel: now - 90000 };
	assert.strictEqual(bg.autoSpins(s, 60000, now), 60 + 3 * 31);
	// Still going for the whole tick.
	assert.strictEqual(bg.autoSpins({ Auto_Spinners: 1, Prestige: 1, Time_Travel: now - 1000 }, 60000, now), 240);
	// Over before the tick began.
	assert.strictEqual(bg.autoSpins({ Auto_Spinners: 1, Prestige: 1, Time_Travel: now - 200000 }, 60000, now), 60);
});

check('advance() keeps the part of a spin that is not whole yet', () => {
	const state = { save: { Spins: 0, Auto_Spinners: 1, Prestige: 1, Time_Travel: 0 }, carry: 0 };
	bg.advance(state, 1500, 0);
	assert.strictEqual(state.save.Spins, 1);
	bg.advance(state, 1500, 0);
	assert.strictEqual(state.save.Spins, 3);
	assert.strictEqual(state.carry, 0);
});

check('advance() stops at 100,000 and ends Time Travel', () => {
	const now = 10_000_000;
	const state = { save: { Spins: 99990, Auto_Spinners: 1000, Prestige: 1, Time_Travel: now - 70000 }, carry: 0.5 };
	bg.advance(state, 60000, now);
	assert.strictEqual(state.save.Spins, 100000);
	assert.strictEqual(state.carry, 0);
	assert.strictEqual(state.save.Time_Travel, 0);
});

check('advance() credits a slept or hung machine five minutes at most', () => {
	const state = { save: { Spins: 0, Auto_Spinners: 1, Prestige: 1, Time_Travel: 0 }, carry: 0 };
	bg.advance(state, 8 * 60 * 60 * 1000, 0);
	assert.strictEqual(state.save.Spins, bg.MAX_TICK_CREDIT_MS / 1000);
	bg.advance(state, -5000, 0);
	assert.strictEqual(state.save.Spins, bg.MAX_TICK_CREDIT_MS / 1000, 'a clock going back gives nothing');
});

check('the save is posted as the game posts it', () => {
	const fields = bg.saveFields({ Spins: 5 });
	assert.deepStrictEqual(fields, { type: 'spin', data: '{"Spins":5}', inital: 0, scmp: 0, v: 2 });
	assert.strictEqual(bg.formBody({ a: 'x y', b: '{"c":1}' }), 'a=x%20y&b=%7B%22c%22%3A1%7D');
});

check('replies', () => {
	assert.strictEqual(bg.judgeReply({ status: 200, body: '{"result":true}' }).action, 'ok');
	assert.deepStrictEqual(bg.judgeReply({ status: 200, body: '{"result":false,"reason":"out_sync"}' }), { action: 'stop', why: 'elsewhere' });
	assert.deepStrictEqual(bg.judgeReply({ status: 200, body: '{"result":false,"reason":"data_comp"}' }), { action: 'stop', why: 'elsewhere' });
	assert.deepStrictEqual(bg.judgeReply({ status: 200, body: '{"result":false,"reason":"no_session"}' }), { action: 'stop', why: 'signedout' });
	assert.strictEqual(bg.judgeReply({ status: 200, body: '{"result":false,"reason":"stmt_fail"}' }).action, 'refused');
	assert.strictEqual(bg.judgeReply({ status: 502, body: '' }).action, 'retry');
	assert.strictEqual(bg.judgeReply({ status: 200, body: '<html>' }).action, 'retry');
	assert.strictEqual(bg.judgeReply(null).action, 'retry');
});

check('load: CPU busy between two samples, and what counts as heavy', () => {
	const a = bg.cpuTimes([{ times: { user: 100, nice: 0, sys: 50, irq: 0, idle: 850 } }]);
	const b = bg.cpuTimes([{ times: { user: 1000, nice: 0, sys: 50, irq: 0, idle: 950 } }]);
	assert.strictEqual(bg.busyBetween(a, b), 0.9);
	assert.strictEqual(bg.busyBetween(b, a), null, 'counters going back');
	assert.strictEqual(bg.busyBetween(a, a), null, 'no time passed');
	assert(bg.isHeavy({ cpu: 0.95, freeMemory: null }));
	assert(bg.isHeavy({ cpu: 0.2, freeMemory: 0.01 }));
	assert(!bg.isHeavy({ cpu: 0.5, freeMemory: 0.5 }));
	assert(!bg.isHeavy({ cpu: null, freeMemory: null }));
	const meter = bg.createLoadMeter('darwin');
	const sample = meter();
	assert.strictEqual(sample.freeMemory, null, 'macOS free memory is not used');
});

check('labels', () => {
	assert.strictEqual(bg.spinsLabel(1), '1 Spin');
	assert.strictEqual(bg.spinsLabel(12345), '12,345 Spins');
	assert.strictEqual(bg.statusLabel({ status: 'running', perMinute: 1200 }), '+1,200 Spins a minute');
	assert(/Prestige/.test(bg.statusLabel({ status: 'stopped', reason: 'won' })));
	assert(/busy/.test(bg.statusLabel({ status: 'paused' })));
});

check('runner: saves once a minute with what the Auto Spinners made', async () => {
	const t = harness();
	assert.strictEqual(t.timers.length, 1);
	assert.strictEqual(t.timers[0].ms, 60000);
	await t.minute();
	assert.strictEqual(t.posts.length, 1);
	assert.strictEqual(t.posts[0].Spins, 1000 + 600);
	assert.strictEqual(t.posts[0].Lifetime_Spins, 500, 'Lifetime_Spins counts clicks only');
	await t.minute();
	assert.strictEqual(t.posts[1].Spins, 2200);
	assert.strictEqual(t.changes[t.changes.length - 1].spins, 2200);
	assert.strictEqual(t.timers.length, 1);
});

check('runner: stops for good at 100,000', async () => {
	const t = harness({ save: { Spins: 99000, Auto_Spinners: 100 } });
	await t.minute();
	assert.strictEqual(t.posts[0].Spins, 100000);
	assert.deepStrictEqual(t.stops, ['won']);
	assert.strictEqual(t.timers.length, 0, 'nothing is left running');
	assert.strictEqual(await t.runner.flush(), true);
	assert.strictEqual(t.posts.length, 1, 'no more requests');
});

check('runner: at 100,000 keeps trying until that save lands', async () => {
	const t = harness({ save: { Spins: 99000, Auto_Spinners: 100 }, replies: [null] });
	await t.minute();
	assert.deepStrictEqual(t.stops, []);
	await t.minute();
	assert.deepStrictEqual(t.stops, ['won']);
	assert.strictEqual(t.posts[1].Spins, 100000);
});

check('runner: stops when the game is opened somewhere else', async () => {
	const t = harness({ replies: [{ status: 200, body: '{"result":false,"reason":"out_sync"}' }] });
	await t.minute();
	assert.deepStrictEqual(t.stops, ['elsewhere']);
	assert.strictEqual(t.timers.length, 0);
	assert.strictEqual(await t.runner.flush(), false, 'and never saves over it');
	assert.strictEqual(t.posts.length, 1);
});

check('runner: a refused save is tried again, five times', async () => {
	const refuse = { status: 200, body: '{"result":false,"reason":"stmt_fail"}' };
	const t = harness({ replies: [refuse, refuse, refuse, refuse, refuse] });
	for (let i = 0; i < 4; i++) await t.minute();
	assert.deepStrictEqual(t.stops, []);
	await t.minute();
	assert.deepStrictEqual(t.stops, ['refused']);
});

check('runner: offline skips the request and keeps counting', async () => {
	const t = harness();
	t.online = false;
	await t.minute();
	assert.strictEqual(t.posts.length, 0);
	t.online = true;
	await t.minute();
	assert.strictEqual(t.posts[0].Spins, 1000 + 1200);
});

check('runner: heavy load skips the save, and quits if it lasts', async () => {
	let heavy = true;
	const t = harness({ load: () => ({ cpu: heavy ? 0.97 : 0.1, freeMemory: null }) });
	await t.minute();
	assert.strictEqual(t.posts.length, 0);
	assert.strictEqual(t.changes[t.changes.length - 1].status, 'paused');
	heavy = false;
	await t.minute();
	assert.strictEqual(t.posts.length, 1, 'back to saving once the load is gone');
	heavy = true;
	for (let i = 0; i < bg.HEAVY_TICKS_TO_QUIT - 1; i++) await t.minute();
	assert.strictEqual(t.overloads, 0);
	await t.minute();
	assert.strictEqual(t.overloads, 1);
	assert.strictEqual(t.timers.length, 0);
	assert.strictEqual(t.runner.running(), false);
	// main.js then saves one last time and quits.
	assert.strictEqual(await t.runner.flush(), true);
	assert.strictEqual(t.posts[t.posts.length - 1].Spins, 1000 + 7 * 600);
});

check('runner: the time asleep is not credited', async () => {
	const t = harness();
	t.mono += 20000;
	t.runner.pause();
	assert.strictEqual(t.timers.length, 0);
	t.mono += 8 * 60 * 60 * 1000;
	t.runner.resume();
	await t.minute();
	assert.strictEqual(t.posts[0].Spins, 1000 + 200 + 600);
});

check('runner: flush() saves what built up since the last save, and stops', async () => {
	const t = harness();
	t.mono += 30000;
	assert.strictEqual(await t.runner.flush(), true);
	assert.strictEqual(t.posts[0].Spins, 1300);
	assert.strictEqual(t.timers.length, 0);
	assert.strictEqual(t.runner.running(), false);
});

check('runner: flush() waits for a save already on its way', async () => {
	let release;
	const slow = () => new Promise((resolve) => { release = () => resolve({ status: 200, body: '{"result":true}' }); });
	const t = harness({ replies: [slow] });
	const ticking = t.minute();
	await Promise.resolve();
	const flushing = t.runner.flush();
	release();
	await ticking;
	assert.strictEqual(await flushing, true);
	assert.strictEqual(t.posts.length, 2);
	assert.strictEqual(t.timers.length, 0, 'the tick did not schedule another');
});

check('handoff file: taken once, with the save, the user agent and the time since', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtest-'));
	const file = path.join(dir, 'background-handoff.json');
	const now = 1_700_000_000_000;
	bg.writeHandoffFile(file, { save: save(), carry: 0.25 }, 'UA/1', now);
	if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'only the user can read it');
	const taken = bg.takeHandoffFile(file, now + 1500);
	assert.strictEqual(taken.handoff.save.Spins, 1000);
	assert.strictEqual(taken.handoff.carry, 0.25);
	assert.strictEqual(taken.ua, 'UA/1');
	assert.strictEqual(taken.elapsed, 1500);
	assert.strictEqual(fs.existsSync(file), false, 'removed once read');
	assert.strictEqual(bg.takeHandoffFile(file, now), null, 'and not taken twice');
});

check('handoff file: stale, from the future, broken or not a save is refused and removed', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtest-'));
	const file = path.join(dir, 'background-handoff.json');
	const now = 1_700_000_000_000;
	bg.writeHandoffFile(file, { save: save() }, 'UA', now);
	assert.strictEqual(bg.takeHandoffFile(file, now + bg.HANDOFF_FILE_MAX_AGE_MS + 1), null, 'stale');
	assert.strictEqual(fs.existsSync(file), false);
	bg.writeHandoffFile(file, { save: save() }, 'UA', now + 60_000);
	assert.strictEqual(bg.takeHandoffFile(file, now), null, 'written in the future');
	fs.writeFileSync(file, '{not json');
	assert.strictEqual(bg.takeHandoffFile(file, now), null, 'broken');
	assert.strictEqual(fs.existsSync(file), false);
	bg.writeHandoffFile(file, { save: save({ Auto_Spinners: 0 }) }, 'UA', now);
	assert.strictEqual(bg.takeHandoffFile(file, now), null, 'nothing for the background to do');
	bg.writeHandoffFile(file, { save: save() }, 'x'.repeat(5000), now);
	assert.strictEqual(bg.takeHandoffFile(file, now).ua, '', 'an oversized user agent is dropped');
});

check('lean switches: no GPU process, the network service in process', () => {
	const names = bg.LEAN_SWITCHES.map(([name]) => name);
	for (const name of ['disable-gpu', 'in-process-gpu', 'enable-features']) assert.ok(names.includes(name), name);
	assert.ok(bg.LEAN_ARG.startsWith('--'));
});

(async () => {
	for (const run of pending) await run();
	if (failures.length) {
		console.log('\n' + failures.length + ' background test(s) failed');
		process.exit(1);
	}
})();
