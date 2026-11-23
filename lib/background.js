'use strict';

// Keep Spinning When Closed (Windows and macOS, off by default).
//
// With it on, closing the window while the Spin Game is open does not quit the
// app. The game page is closed and unloaded, and the app sits in the system
// tray (the menu bar on a Mac) with the spin count, saving what the player's
// Auto Spinners earn to the account about once a minute, the same save the
// game itself posts to /v2/updatedata.php:
//
//  1. The page hands over its game (window.spinBackgroundHandoff() in the
//     Empanadas-io repo's _spin.js) and stops itself. cleanHandoff() checks
//     what it handed over.
//  2. main.js posts it once at once. Only once that lands is the window closed
//     and the runner below started; a save the server refuses closes the
//     window the ordinary way.
//  3. Each tick adds the Auto Spinners' spins for the time since the last, the
//     way the game's clock does (autoSpins() in _spin.js), and posts the save.
//  4. It stops for good at 100,000 Spins (the player has to Prestige), when
//     the game is opened somewhere else, or when the account signs out. The
//     tray icon stays, with nothing running, until the player opens the game
//     or quits.
//  5. It is the lowest priority on the machine (main.js), and under heavy load
//     it skips its save; if the load lasts, it saves one last time and quits.
//
// Everything here is plain Node so it can be tested without Electron.

const fs = require('fs');
const path = require('path');
const os = require('os');

// The platforms with a tray to go to. Linux builds are not shipped.
const PLATFORMS = Object.freeze(['win32', 'darwin']);

const TICK_MS = 60 * 1000;
// The most a tick credits. The game's own catch-up cap is 90s (CATCHUP_MAX_MS
// in _spin.js) because a hidden tab's timers only run once a minute; here the
// tick is a minute anyway, and a Mac may run a windowless app's timers late
// (App Nap). Longer than this is a machine that slept or hung, and gets this
// much and no more. Sleep itself is not credited at all: main.js calls
// pause() when the machine suspends and resume() when it wakes.
const MAX_TICK_CREDIT_MS = 5 * 60 * 1000;
// _spin.js: Time Travel lasts 61s from its stamp (getTimeTravelTimeLeft()),
// and makes Auto Spinners four times as quick.
const TIME_TRAVEL_MS = 61000;
const MAX_SPINS = 100000;
const MAX_AUTO_SPINNERS = 1000;
const MAX_PRESTIGE = 100;
// What updatedata.php is told the client is (serverdataversion in _core.js).
const SERVER_DATA_VERSION = 2;
// A save is ~700 bytes; GAMEDATA_MAX_BYTES on the server is far above this.
const MAX_SAVE_BYTES = 64 * 1024;
const MAX_SAVE_KEYS = 200;

// Heavy load: the whole machine's CPU busy over the last tick, or (Windows,
// where free memory means memory that is actually available) almost no memory
// left. A heavy tick skips its save; this many heavy ticks in a row save one
// last time and quit.
const HEAVY_CPU = 0.9;
const HEAVY_FREE_MEMORY = 0.05;
const HEAVY_TICKS_TO_QUIT = 5;

// Replies that mean another copy of the game (a tab, another device, the app
// opened again) has the save now, or that there is no account to save to.
// Anything else that is not a success is tried again next tick, until it has
// failed this many times in a row.
const STOP_REASONS = Object.freeze({
	out_sync: 'elsewhere',
	data_comp: 'elsewhere',
	no_session: 'signedout',
	no_account: 'signedout',
	unavailable: 'unavailable'
});
const MAX_REFUSALS = 5;

function supported(platform) {
	return PLATFORMS.includes(platform);
}

// The setting, in its own file under userData. Off unless it says true.
function createSettings(file) {
	let enabled = false;
	try {
		enabled = JSON.parse(fs.readFileSync(file, 'utf8')).enabled === true;
	} catch (err) {
		// Never set, or unreadable: off.
	}
	return {
		enabled: () => enabled,
		set(value) {
			enabled = value === true;
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				const temp = file + '.tmp';
				fs.writeFileSync(temp, JSON.stringify({ enabled }));
				fs.renameSync(temp, file);
			} catch (err) {
				// Kept for this run only.
			}
			return enabled;
		}
	};
}

function count(value, max) {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(Math.floor(n), max);
}

// What the page handed over, or null when the background has nothing to do
// with it. It comes from a page served over the network, so it is checked
// here rather than trusted: a plain object of the size a save is, with Spins
// still to collect and an Auto Spinner to collect them. Everything else in it
// is the game's, and goes back to the server as it came (the server checks
// every field itself).
function cleanHandoff(handoff) {
	if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) return null;
	const data = handoff.save;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	let json;
	try {
		json = JSON.stringify(data);
	} catch (err) {
		return null;
	}
	if (typeof json !== 'string' || json.length > MAX_SAVE_BYTES) return null;
	const save = JSON.parse(json);
	if (Object.keys(save).length > MAX_SAVE_KEYS) return null;

	save.Spins = count(save.Spins, MAX_SPINS);
	save.Auto_Spinners = count(save.Auto_Spinners, MAX_AUTO_SPINNERS);
	save.Prestige = Math.max(1, count(save.Prestige, MAX_PRESTIGE));
	const tt = Number(save.Time_Travel);
	save.Time_Travel = Number.isFinite(tt) && tt > 0 ? tt : 0;
	if (save.Spins >= MAX_SPINS || autoRate(save) <= 0) return null;

	const carry = Number(handoff.carry);
	return { save, carry: Number.isFinite(carry) && carry >= 0 && carry < 1 ? carry : 0 };
}

// Auto Spinner spins a second, before Time Travel (autoRate() in _spin.js).
function autoRate(save) {
	const n = save.Auto_Spinners;
	if (!(n > 0)) return 0;
	return n * (save.Prestige >= 2 ? save.Prestige : 1);
}

// Auto Spinner spins in the dt ms up to wall-clock time now, Time Travel's
// part of it four times as quick (autoSpins() in _spin.js).
function autoSpins(save, dt, now) {
	let quick = 0;
	if (save.Time_Travel !== 0) {
		const ends = save.Time_Travel + TIME_TRAVEL_MS;
		quick = Math.max(0, Math.min(dt, ends - (now - dt)));
	}
	return autoRate(save) * (dt + 3 * quick) / 1000;
}

// Moves the game on by dt ms, ending at wall-clock time now: the spins, the
// part of a spin that is not whole yet, and Time Travel once it is over.
// Returns how many whole spins it added.
function advance(state, dt, now) {
	const save = state.save;
	const credit = Math.max(0, Math.min(dt, MAX_TICK_CREDIT_MS));
	state.carry += autoSpins(save, credit, now);
	const whole = Math.floor(state.carry);
	state.carry -= whole;
	const before = save.Spins;
	save.Spins = Math.min(MAX_SPINS, save.Spins + whole);
	if (save.Spins >= MAX_SPINS) state.carry = 0;
	if (save.Time_Travel !== 0 && now >= save.Time_Travel + TIME_TRAVEL_MS) {
		save.Time_Travel = 0;
	}
	return save.Spins - before;
}

// The body updatedata.php takes from saveToServer() in _core.js. No pepper
// batch: the background earns no peppers, and one the page still had waiting
// stays in that browser's storage and goes with the game's next save.
function saveFields(save) {
	return {
		type: 'spin',
		data: JSON.stringify(save),
		inital: 0,
		scmp: 0,
		v: SERVER_DATA_VERSION
	};
}

function formBody(fields) {
	return Object.keys(fields)
		.map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(fields[key])))
		.join('&');
}

// What to do after a save: 'ok', 'retry' (the next tick tries again), or
// 'stop' with why. reply is { status, body } (body is the reply's text), or
// null for no answer at all.
function judgeReply(reply) {
	if (!reply || !reply.status) return { action: 'retry', why: 'offline' };
	if (reply.status !== 200) return { action: 'retry', why: 'http ' + reply.status };
	let parsed;
	try {
		parsed = JSON.parse(reply.body);
	} catch (err) {
		return { action: 'retry', why: 'bad reply' };
	}
	if (parsed && parsed.result === true) return { action: 'ok' };
	const reason = parsed && typeof parsed.reason === 'string' ? parsed.reason : '';
	if (Object.prototype.hasOwnProperty.call(STOP_REASONS, reason)) {
		return { action: 'stop', why: STOP_REASONS[reason] };
	}
	return { action: 'refused', why: reason || 'refused' };
}

// The whole machine's CPU time so far, from os.cpus(): { busy, total } in ms.
function cpuTimes(cpus) {
	let busy = 0;
	let total = 0;
	for (const cpu of cpus || []) {
		const t = cpu && cpu.times;
		if (!t) continue;
		const b = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0);
		busy += b;
		total += b + (t.idle || 0);
	}
	return { busy, total };
}

// How busy the CPUs were between two cpuTimes(), 0 to 1, or null when that
// cannot be told (no time passed, or a counter went backwards).
function busyBetween(before, after) {
	if (!before || !after) return null;
	const total = after.total - before.total;
	const busy = after.busy - before.busy;
	if (!(total > 0) || busy < 0) return null;
	return Math.min(1, busy / total);
}

// Is the machine under heavy load? load is { cpu, freeMemory } (fractions,
// either may be null for unknown).
function isHeavy(load) {
	if (!load) return false;
	if (load.cpu !== null && load.cpu !== undefined && load.cpu >= HEAVY_CPU) return true;
	if (load.freeMemory !== null && load.freeMemory !== undefined && load.freeMemory < HEAVY_FREE_MEMORY) return true;
	return false;
}

// The machine's load as the runner reads it. Free memory only on Windows:
// macOS counts the file cache as used, so its free memory is near nothing on a
// healthy machine.
function createLoadMeter(platform) {
	let last = cpuTimes(os.cpus());
	return () => {
		const now = cpuTimes(os.cpus());
		const cpu = busyBetween(last, now);
		last = now;
		const total = os.totalmem();
		const freeMemory = platform === 'win32' && total > 0 ? os.freemem() / total : null;
		return { cpu, freeMemory };
	};
}

function addCommas(n) {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// "1 Spin", "12,345 Spins".
function spinsLabel(n) {
	return addCommas(n) + (n === 1 ? ' Spin' : ' Spins');
}

// Spins a minute, for the tray menu.
function perMinute(save) {
	return Math.floor(autoRate(save) * 60);
}

// The tray menu's second line, for a runner's view().
function statusLabel(view) {
	if (view.status === 'stopped') {
		switch (view.reason) {
			case 'won': return '100,000 Spins! Open the game to Prestige';
			case 'elsewhere': return 'Stopped: the game was opened somewhere else';
			case 'signedout': return 'Stopped: signed out of Empanadas.io';
			case 'unavailable': return 'Stopped: saving is unavailable right now';
			default: return 'Stopped: the game could not be saved';
		}
	}
	if (view.status === 'paused') return 'Paused while your computer is busy';
	if (view.status === 'offline') return 'Offline: saves when the connection is back';
	return '+' + addCommas(view.perMinute) + ' Spins a minute';
}

// The background itself. deps:
//   post(fields)    resolves { status, body } or null (see judgeReply()).
//   wall()          Date.now().
//   mono()          a monotonic clock in ms.
//   load()          { cpu, freeMemory }, see createLoadMeter().
//   online()        false skips the save (default: always online).
//   setTimer(fn, ms), clearTimer(t)   default setTimeout/clearTimeout.
//   onChange(view)  every time the spin count or the status changes.
//   onStop(why)     stopped for good: 'won', 'elsewhere', 'signedout',
//                   'unavailable', 'refused'.
//   onOverload()    heavy load went on too long: main.js saves (flush()) and quits.
function createRunner(handoff, deps) {
	const state = { save: handoff.save, carry: handoff.carry || 0 };
	const setTimer = deps.setTimer || setTimeout;
	const clearTimer = deps.clearTimer || clearTimeout;
	const online = deps.online || (() => true);
	let timer = null;
	let last = deps.mono();
	let running = true;
	let posting = null;
	let heavyTicks = 0;
	let refusals = 0;
	let status = 'running';
	let stopReason = null;

	const view = () => ({
		spins: state.save.Spins,
		perMinute: perMinute(state.save),
		status,
		reason: stopReason
	});
	const changed = () => { if (deps.onChange) deps.onChange(view()); };

	function settle() {
		const now = deps.mono();
		const dt = now - last;
		last = now;
		return advance(state, dt, deps.wall());
	}

	function schedule() {
		if (!running) return;
		timer = setTimer(tick, TICK_MS);
		if (timer && timer.unref) timer.unref();
	}

	function finish(why) {
		running = false;
		status = 'stopped';
		stopReason = why;
		if (timer) clearTimer(timer);
		timer = null;
		changed();
		if (deps.onStop) deps.onStop(why);
	}

	async function post() {
		posting = Promise.resolve()
			.then(() => deps.post(saveFields(state.save)))
			.catch(() => null);
		const reply = await posting;
		posting = null;
		return judgeReply(reply);
	}

	async function tick() {
		timer = null;
		if (!running) return;
		settle();
		const won = state.save.Spins >= MAX_SPINS;

		if (!won && isHeavy(deps.load())) {
			heavyTicks++;
			status = 'paused';
			changed();
			if (heavyTicks >= HEAVY_TICKS_TO_QUIT) {
				running = false;
				if (deps.onOverload) deps.onOverload();
				return;
			}
			schedule();
			return;
		}
		heavyTicks = 0;

		if (!online()) {
			status = 'offline';
			changed();
			schedule();
			return;
		}

		const result = await post();
		if (!running) return;
		if (result.action === 'stop') {
			finish(result.why);
			return;
		}
		if (result.action === 'refused') {
			refusals++;
			if (refusals >= MAX_REFUSALS) {
				finish('refused');
				return;
			}
		} else if (result.action === 'ok') {
			refusals = 0;
		}
		status = result.action === 'ok' || result.action === 'refused' ? 'running' : 'offline';
		if (won && result.action === 'ok') {
			finish('won');
			return;
		}
		changed();
		schedule();
	}

	schedule();
	changed();

	return {
		view,
		running: () => running,
		// The machine is going to sleep: credit up to now and no further.
		pause() {
			if (!running) return;
			settle();
			if (timer) clearTimer(timer);
			timer = null;
		},
		// Awake again. The time asleep is not credited.
		resume() {
			if (!running || timer) return;
			last = deps.mono();
			schedule();
		},
		// Stops the ticks and posts what has built up since the last save, once,
		// for leaving the background (opening the game, quitting). Resolves true
		// when that save landed. A save already in flight is waited for first.
		async flush() {
			const wasRunning = running;
			running = false;
			if (timer) clearTimer(timer);
			timer = null;
			if (posting) await posting;
			// Stopped for good already: at 100,000 that save has landed, and
			// otherwise the save is someone else's now.
			if (stopReason) return stopReason === 'won';
			if (wasRunning) settle();
			if (!online()) return false;
			const result = await post();
			return result.action === 'ok';
		},
		stop() {
			running = false;
			if (timer) clearTimer(timer);
			timer = null;
		},
		// For tests.
		_tick: tick,
		_state: state
	};
}

// --- The tray-only process ---------------------------------------------------
// Chromium's GPU and network processes outlive the window, and the switches
// that do without them only take effect at launch. So once the first save has
// landed, main.js writes what the runner needs to a file and starts the app
// again with LEAN_ARG: a process with no window, no GPU process and the
// network service in the main process, that only runs the tray and the saves.
// Leaving it (Open Spin Game, a link, the app opened again) starts the app
// once more as it always starts.

const LEAN_ARG = '--background-spin';
// The switches the tray-only process is started with (app.commandLine).
const LEAN_SWITCHES = Object.freeze([
	['disable-gpu'],
	['disable-software-rasterizer'],
	['in-process-gpu'],
	['enable-features', 'NetworkServiceInProcess2']
]);
// A hand-over older than this was not the one just written: the relaunch
// failed, or the file was left behind. The app then starts as usual.
const HANDOFF_FILE_MAX_AGE_MS = 2 * 60 * 1000;
const MAX_UA_LENGTH = 1024;

function writeHandoffFile(file, handoff, ua, now) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = file + '.tmp';
	const body = JSON.stringify({ at: now, save: handoff.save, carry: handoff.carry || 0, ua: typeof ua === 'string' ? ua : '' });
	fs.writeFileSync(temp, body, { mode: 0o600 });
	fs.renameSync(temp, file);
}

// Reads the hand-over once and removes it, whatever it held. Null when there
// is none, it is stale, or it is not a save the runner can take. elapsed is
// the time since it was written, for advance() to credit the relaunch.
function takeHandoffFile(file, now) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (err) {
		return null;
	}
	try {
		fs.unlinkSync(file);
	} catch (err) {
		// Read once all the same.
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch (err) {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const age = now - Number(data.at);
	if (!Number.isFinite(age) || age < -5000 || age > HANDOFF_FILE_MAX_AGE_MS) return null;
	const handoff = cleanHandoff({ save: data.save, carry: data.carry });
	if (!handoff) return null;
	const ua = typeof data.ua === 'string' && data.ua.length <= MAX_UA_LENGTH ? data.ua : '';
	return { handoff, ua, elapsed: Math.max(0, age) };
}

module.exports = {
	PLATFORMS,
	TICK_MS,
	MAX_TICK_CREDIT_MS,
	TIME_TRAVEL_MS,
	MAX_SPINS,
	HEAVY_CPU,
	HEAVY_FREE_MEMORY,
	HEAVY_TICKS_TO_QUIT,
	MAX_REFUSALS,
	supported,
	createSettings,
	cleanHandoff,
	autoRate,
	autoSpins,
	advance,
	saveFields,
	formBody,
	judgeReply,
	cpuTimes,
	busyBetween,
	isHeavy,
	createLoadMeter,
	addCommas,
	spinsLabel,
	statusLabel,
	perMinute,
	createRunner,
	LEAN_ARG,
	LEAN_SWITCHES,
	HANDOFF_FILE_MAX_AGE_MS,
	writeHandoffFile,
	takeHandoffFile
};
