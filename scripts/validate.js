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

const sources = ['main.js', 'updater.js', 'lib/pgp.js', 'lib/urls.js',
	'Content/JS/preload.js', 'Content/JS/auth-preload.js',
	'scripts/validate.js', 'scripts/import-release-key.js', 'scripts/thumbprint.js'];

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
	['navigation is filtered by host, not by string prefix', /require\('\.\/lib\/urls'\)/],
	['redirects are filtered too', /'will-redirect'/],
	['new windows go through setWindowOpenHandler', /setWindowOpenHandler/],
	['permissions are denied by default', /setPermissionRequestHandler/]
]) {
	check(what, () => assert(needle.test(mainSrc), 'main.js no longer matches ' + needle));
}

const urlsSrc = fs.readFileSync(path.join(root, 'lib', 'urls.js'), 'utf8');

check('the app host is matched by parsed hostname', () => {
	assert(/function isAppUrl/.test(urlsSrc), 'lib/urls.js no longer defines isAppUrl');
	assert(/new URL\(url\)/.test(urlsSrc), 'lib/urls.js no longer parses the URL');
});

// The sign-in popup is the one window the site is allowed to raise, so the
// terms it is allowed on are worth pinning down.
check('the sign-in popup is the only window the page can open', () => {
	assert(/isAuthUrl\(url\) && isAppUrl\(contents\.getURL\(\)\)/.test(mainSrc),
		'main.js no longer restricts window.open to auth URLs raised by the site');
	assert(/action:\s*'deny'/.test(mainSrc), 'main.js no longer denies other windows');
});

check('the sign-in popup does not inherit the preload', () => {
	assert(/preload:\s*AUTH_PRELOAD/.test(mainSrc),
		'the auth window does not name its own preload, so it inherits the app bridge');
	const authPreload = fs.readFileSync(
		path.join(root, 'Content', 'JS', 'auth-preload.js'), 'utf8');
	assert(!/contextBridge|ipcRenderer/.test(authPreload),
		'Content/JS/auth-preload.js must expose nothing');
});

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

check('the updater verifies a release signature before installing', () => {
	assert(/verifyReleaseSignature\(/.test(updaterSrc), 'no OpenPGP verification call');
	const order = updaterSrc.indexOf('await verifyReleaseSignature');
	const install = updaterSrc.indexOf('setState({ status: \'installing\'');
	assert(order > 0 && install > order,
		'the signature check does not run before the install step');
});

// --- release signing status -------------------------------------------
// Not failures: the app works without these, just with a weaker trust story.
// They print so the gap stays visible instead of being quietly forgotten.
const keysFile = path.join(root, 'release-keys.json');
const notes = [];

if (!fs.existsSync(keysFile)) {
	notes.push('release-keys.json is missing, so the OpenPGP check is skipped at ' +
		'runtime. Add it with: node scripts/import-release-key.js <key.asc>');
} else {
	check('release-keys.json is well formed', () => {
		const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
		assert(Array.isArray(keys) && keys.length, 'no keys in the file');
		for (const key of keys) {
			assert(/^[0-9A-F]{40}$/.test(key.fingerprint || ''),
				'bad fingerprint: ' + key.fingerprint);
			assert(/^-----BEGIN PUBLIC KEY-----/.test(key.pem || ''), 'bad PEM');
			assert(!/PRIVATE/.test(key.pem), 'that is a PRIVATE key - do not commit it');
		}
	});
}

if (!/pinnedThumbprints:\s*\[\s*'/.test(updaterSrc)) {
	notes.push('no Authenticode thumbprint is pinned, so any certificate naming ' +
		'"Empanadas.io" is accepted. Pin one with: node scripts/thumbprint.js <installer.exe>');
}
if (/macTeamId:\s*null/.test(updaterSrc)) {
	notes.push('no macOS Team ID is pinned, so macOS updates will refuse to ' +
		'install. Pin one with: node scripts/thumbprint.js <Empanadas.io.app>');
}

// --- packaging config -------------------------------------------------
console.log('packaging config');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const build = pkg.build || {};

check('appId is a structurally valid CFBundleIdentifier', () => {
	assert(typeof build.appId === 'string', 'build.appId is not set');
	assert(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(build.appId),
		'"' + build.appId + '" is not a usable CFBundleIdentifier');
});

check('appId is the reverse-DNS form of the homepage domain', () => {
	// Changing an appId after release breaks update continuity on macOS and
	// orphans the app's stored data, so this is worth pinning down rather than
	// leaving as a thing to notice later. io.empanadas.app is correct for
	// empanadas.io: the domain reversed, plus a leaf.
	const host = new URL(pkg.homepage).hostname.replace(/^www\./, '');
	const expectedPrefix = host.split('.').reverse().join('.');
	assert(build.appId === expectedPrefix || build.appId.startsWith(expectedPrefix + '.'),
		'"' + build.appId + '" does not start with "' + expectedPrefix +
		'" (reverse-DNS of ' + host + ')');
});

check('the macOS bundle id the updater pins matches the one being built', () => {
	// The updater refuses an update whose bundle identifier is not this, so the
	// two drifting apart would break macOS updates with a confusing message.
	const pinned = /macBundleId:\s*'([^']+)'/.exec(updaterSrc);
	assert(pinned, 'updater.js no longer sets macBundleId');
	assert(pinned[1] === build.appId,
		'updater pins ' + pinned[1] + ' but the build produces ' + build.appId);
});

check('uninstall behaviour is stated explicitly', () => {
	// Not a correctness check - either value is defensible. It has to be a
	// decision on the record, though, because the default silently leaves a
	// per-install identifier behind after the user uninstalls.
	assert(build.nsis && typeof build.nsis.deleteAppDataOnUninstall === 'boolean',
		'build.nsis.deleteAppDataOnUninstall must be set explicitly, see README');
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

check('the packaged app includes what it needs at runtime and nothing else', () => {
	const files = build.files || ['**/*'];
	const excluded = files.filter((f) => f.startsWith('!')).map((f) => f.slice(1));
	// lib/ holds the signature verifier; leaving it out would break the updater
	// only at the moment it matters. test/ ships a public key that is NOT the
	// release key, which would be confusing to find inside a shipped app.
	for (const needed of ['lib', 'release-keys.json', 'Content', 'download.html']) {
		assert(!excluded.some((e) => needed === e || needed.startsWith(e + '/')),
			needed + ' is excluded from the package but is needed at runtime');
	}
	for (const unwanted of ['test', 'scripts']) {
		assert(excluded.includes(unwanted), unwanted + '/ should not ship inside the app');
	}
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

// --- signature verification -------------------------------------------
// lib/pgp.js is the one piece of cryptography in the app, so its tests run as
// part of `npm test` rather than living somewhere separate that nobody runs.
console.log('signature verification');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'pgp.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/pgp.js test suite failed');
}

// --- navigation and sign-in policy ------------------------------------
console.log('url policy');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'urls.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/urls.js test suite failed');
}

// --- updater logic ----------------------------------------------------
console.log('updater logic');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'updater.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('updater.js test suite failed');
}

// --- splash page ------------------------------------------------------
// Needs a browser, and skips itself when there isn't one (see the file).
console.log('splash page');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'splash.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('download.html browser test suite failed');
}

// --- result -----------------------------------------------------------
console.log('');

for (const note of notes) {
	console.log('note: ' + note + '\n');
}

if (failures.length) {
	console.error(failures.length + ' check(s) failed:');
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}

console.log('All checks passed.');
