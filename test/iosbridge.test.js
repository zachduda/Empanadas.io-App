'use strict';

// ios/Empanadas/Resources/bridge.js is injected into every page of the iOS
// app's web views. It needs nothing from iOS beyond a message handler, so it
// runs here in a VM with a stand-in for WebKit: what it sends the app is what
// these checks look at. Covers navigator.vibrate() (native haptics for the
// games' existing vibration calls), the page colour it reports and whether
// the page draws its own close button.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ios', 'Empanadas', 'Resources', 'bridge.js'), 'utf8');

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

// A page with the bridge loaded. Timers do not run by themselves: `advance`
// moves the clock and fires what is due, so patterns are checked exactly.
function page(options) {
	const opts = Object.assign({ host: 'empanadas.io', background: 'rgb(47, 49, 63)' }, options);
	const sent = [];
	let now = 0;
	let nextId = 1;
	const timers = new Map();

	class Navigator {}
	const element = (background) => ({
		background,
		setAttribute() {},
		appendChild() {},
		addEventListener() {}
	});
	const sandbox = {
		location: { protocol: 'https:', hostname: opts.host },
		Navigator,
		navigator: new Navigator(),
		document: {
			readyState: 'complete',
			documentElement: element('rgba(0, 0, 0, 0)'),
			body: element(opts.background),
			createElement: () => ({ setAttribute() {} }),
			querySelector: (selector) => (selector === '[data-app-close]' && opts.closeButton ? {} : null),
			addEventListener() {}
		},
		getComputedStyle: (el) => ({ backgroundColor: el.background }),
		MutationObserver: class { observe() {} disconnect() {} },
		addEventListener() {},
		setTimeout(fn, ms, ...args) {
			const id = nextId++;
			timers.set(id, { at: now + (ms || 0), fn, args });
			return id;
		},
		clearTimeout(id) { timers.delete(id); },
		webkit: {
			messageHandlers: {
				empanadas: {
					postMessage(message) {
						sent.push(message);
						return Promise.resolve(true);
					}
				}
			}
		}
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source.replace('__APP_VERSION__', '9.9.9'), sandbox);

	return {
		window: sandbox,
		sent,
		haptics: () => sent.filter((m) => m.cmd === 'haptic').map((m) => m.args.style),
		advance(ms) {
			now += ms;
			for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.fn(...timer.args);
				}
			}
		},
		pending: () => timers.size
	};
}

check('fills in navigator.vibrate, which WebKit on iOS lacks', () => {
	const p = page();
	assert.strictEqual(typeof p.window.navigator.vibrate, 'function');
	assert.strictEqual(p.window.navigator.vibrate(35), true, 'returns true, as the API does');
});

check('one buzz is one tap, firmer the longer it asks for', () => {
	const p = page();
	p.window.navigator.vibrate(5);
	p.window.navigator.vibrate(35);
	p.window.navigator.vibrate(60);
	assert.deepStrictEqual(p.haptics(), ['light', 'medium', 'heavy']);
});

check("Spin's pattern [5, 200, 20]: a tap now, a firmer one after the pause", () => {
	const p = page();
	p.window.navigator.vibrate([5, 200, 20]);
	assert.deepStrictEqual(p.haptics(), ['light']);
	p.advance(204);
	assert.deepStrictEqual(p.haptics(), ['light'], 'not before the pause is over');
	p.advance(1);
	assert.deepStrictEqual(p.haptics(), ['light', 'medium']);
});

check('a new call cancels the pattern still playing', () => {
	const p = page();
	p.window.navigator.vibrate([5, 200, 20]);
	p.window.navigator.vibrate([5, 200, 20]);
	p.advance(1000);
	assert.deepStrictEqual(p.haptics(), ['light', 'light', 'medium'], 'only the last pattern finishes');
});

check('0 and [] only cancel', () => {
	const p = page();
	p.window.navigator.vibrate([5, 200, 20]);
	assert.strictEqual(p.window.navigator.vibrate(0), true);
	assert.strictEqual(p.window.navigator.vibrate([]), true);
	p.advance(1000);
	assert.deepStrictEqual(p.haptics(), ['light']);
	assert.strictEqual(p.pending(), 0);
});

check('nonsense is not a buzz, and a long pattern is cut short', () => {
	const p = page();
	p.window.navigator.vibrate(['soon', -5, null]);
	assert.deepStrictEqual(p.haptics(), []);
	p.window.navigator.vibrate(new Array(100).fill(10));
	p.advance(10000);
	assert.strictEqual(p.haptics().length, 10, '20 steps at most, half of them on');
});

check('does nothing off empanadas.io', () => {
	const p = page({ host: 'example.com' });
	assert.strictEqual(p.window.navigator.vibrate, undefined);
	assert.strictEqual(p.window.empanadasApp, undefined);
	assert.deepStrictEqual(p.sent, []);
});

check("reports the page's background, and nothing see-through", () => {
	assert.deepStrictEqual(page().sent.filter((m) => m.cmd === 'pageColor').map((m) => m.args.color),
		['rgb(47, 49, 63)']);
	assert.deepStrictEqual(page({ background: 'rgba(0, 0, 0, 0)' }).sent.filter((m) => m.cmd === 'pageColor'), [],
		'a transparent body and html say nothing');
});

check('says when the page draws its own close button, and only then', () => {
	assert.deepStrictEqual(page({ closeButton: true }).sent.filter((m) => m.cmd === 'ownCloseButton').length, 1);
	assert.deepStrictEqual(page().sent.filter((m) => m.cmd === 'ownCloseButton'), [],
		'without one the native button stays');
});

check('window.empanadasApp is there, frozen, without the old deep link hook', () => {
	const app = page().window.empanadasApp;
	assert.strictEqual(app.platform, 'ios');
	assert.strictEqual(app.version, '9.9.9');
	assert.strictEqual(typeof app.haptic, 'function');
	assert.strictEqual(app.onDeepLink, undefined);
	assert(Object.isFrozen(app));
});

if (failures.length) {
	console.error('\n' + failures.length + ' failed');
	process.exit(1);
}
