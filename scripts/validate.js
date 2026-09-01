'use strict';

// What `npm test` runs. There is no runtime test suite here - the app is a
// thin Electron wrapper around empanadas.io, and almost everything worth
// asserting needs a running Electron. What this does catch is the class of
// mistake that actually breaks releases: a syntax error in a main-process
// file (which only shows up when a user launches the app) and a packaging
// config that produces broken or unverifiable artifacts.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
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

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// --- syntax -----------------------------------------------------------
// These are all loaded by Electron, not by npm, so nothing else in CI would
// ever parse them.
console.log('syntax');

const sources = ['main.js', 'updater.js', 'Content/JS/preload.js', 'scripts/validate.js'];

for (const file of sources) {
	check(file, () => {
		execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
	});
}

// --- hardening --------------------------------------------------------
// These are one-line settings that silently make the app less safe when they
// regress, and nothing else would notice.
console.log('hardening');

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'download.html'), 'utf8');

check('no invisible characters in main.js', () => {
	// A zero-width space once hid inside an appendSwitch() name here, which
	// left the switch silently doing nothing for years.
	// Zero-width and bidi-control ranges, written as escapes so this file does
	// not contain the very thing it is looking for.
	const bad = new RegExp("[\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]").exec(mainSrc);
	assert(!bad, 'found U+' + (bad && bad[0].codePointAt(0).toString(16).toUpperCase()) +
		' at offset ' + (bad && bad.index));
});

for (const [what, needle] of [
	['context isolation is on', /contextIsolation:\s*true/],
	['node integration is off', /nodeIntegration:\s*false/],
	['the renderer is sandboxed', /sandbox:\s*true/],
	['the webview tag is disabled', /webviewTag:\s*false/],
	['navigation is filtered by host, not by string prefix', /function isAppUrl/],
	['redirects are filtered too', /'will-redirect'/],
	['new windows are denied', /setWindowOpenHandler/],
	['permissions are denied by default', /setPermissionRequestHandler/]
]) {
	check(what, () => assert(needle.test(mainSrc), 'main.js no longer matches ' + needle));
}

check('download.html sets a Content-Security-Policy', () => {
	assert(/http-equiv=["']Content-Security-Policy["']/i.test(htmlSrc), 'no CSP meta tag');
	assert(/default-src\s+'none'/.test(htmlSrc), "CSP does not start from default-src 'none'");
});

const updaterSrc = fs.readFileSync(path.join(root, 'updater.js'), 'utf8');

check('the updater only follows checked URLs', () => {
	assert(/redirect:\s*'manual'/.test(updaterSrc), "net.request no longer uses redirect: 'manual'");
	assert(/requireAllowedUrl/.test(updaterSrc), 'no URL allowlist check before requesting');
});

check('the updater still requires a hash and a signature', () => {
	assert(/requireHash:\s*true/.test(updaterSrc), 'requireHash is not true');
	assert(/requireSignature:\s*true/.test(updaterSrc), 'requireSignature is not true');
});

// --- packaging config -------------------------------------------------
console.log('packaging config');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const build = pkg.build || {};

check('appId is a structurally valid CFBundleIdentifier', () => {
	// Only checks shape - that it reads as reverse-DNS rather than forward
	// (io.empanadas.app, not empanadas.io) is a convention no regex can tell
	// apart, so that part stays a review question.
	assert(typeof build.appId === 'string', 'build.appId is not set');
	assert(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(build.appId),
		'"' + build.appId + '" is not a usable CFBundleIdentifier');
});

check('artifact names have no spaces', () => {
	// GitHub rewrites spaces in uploaded asset names to dots, which breaks
	// any tool expecting the filename it built.
	const names = [build.artifactName, build.mac && build.mac.artifactName, build.dmg && build.dmg.artifactName];
	for (const name of names.filter(Boolean)) {
		assert(!/\s/.test(name), '"' + name + '" contains a space');
	}
});

check('mac category is a valid LSApplicationCategoryType', () => {
	const category = build.mac && build.mac.category;
	assert(category, 'build.mac.category is not set');
	assert(/^public\.app-category\.[a-z-]+$/.test(category),
		'"' + category + '" is not a public.app-category.* value');
});

check('mac entitlements file exists', () => {
	const entitlements = build.mac && build.mac.entitlements;
	assert(entitlements, 'build.mac.entitlements is not set');
	assert(fs.existsSync(path.join(root, entitlements)), entitlements + ' is missing');
});

check('mac hardened runtime is on', () => {
	// Notarization rejects anything built without it.
	assert(build.mac && build.mac.hardenedRuntime === true,
		'build.mac.hardenedRuntime must be true for notarization');
});

check('mac ships a zip target', () => {
	// Kept so a future macOS updater has something to install from: swapping
	// the .app bundle needs a zip, and a dmg cannot install itself. The
	// updater is Windows-only today and does not consume this yet.
	const targets = (build.mac && build.mac.target) || [];
	const names = targets.map((t) => typeof t === 'string' ? t : t.target);
	assert(names.includes('zip'), 'no zip target: found ' + (names.join(', ') || 'none'));
});

check('version matches the updater asset pattern', () => {
	assert(/^\d+\.\d+\.\d+/.test(pkg.version), '"' + pkg.version + '" is not a semver core version');
});

check('main entry point exists', () => {
	assert(fs.existsSync(path.join(root, pkg.main)), pkg.main + ' is missing');
});

check('icon exists and is large enough for icns', () => {
	const icon = path.join(root, (build.mac && build.mac.icon) || 'icon.png');
	assert(fs.existsSync(icon), icon + ' is missing');
	// Minimal PNG header read: width and height are big-endian u32 at byte 16.
	const header = Buffer.alloc(24);
	const fd = fs.openSync(icon, 'r');
	fs.readSync(fd, header, 0, 24, 0);
	fs.closeSync(fd);
	const width = header.readUInt32BE(16);
	const height = header.readUInt32BE(20);
	assert(width >= 512 && height >= 512,
		'icon is ' + width + 'x' + height + ', electron-builder needs at least 512x512');
});

// --- result -----------------------------------------------------------
console.log('');

if (failures.length) {
	console.error(failures.length + ' check(s) failed:');
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}

console.log('All checks passed.');
