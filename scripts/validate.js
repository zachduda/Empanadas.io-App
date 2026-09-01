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
	// The updater installs by swapping the .app bundle, which needs a zip;
	// a dmg cannot install itself.
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
