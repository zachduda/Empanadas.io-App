'use strict';

// The parts of updater.js that can be tested without Electron: version
// comparison, URL filtering, filename handling and manifest parsing.
//
// updater.js requires 'electron' at the top, which is not resolvable outside a
// running Electron, so a stub stands in. That is enough for these functions -
// none of them touch it.

const path = require('path');
const Module = require('module');

const noop = () => {};
const electronStub = {
	app: { getVersion: () => '1.0.0', getPath: () => '/tmp', isPackaged: false },
	dialog: {}, net: {}, shell: {},
	BrowserWindow: { getAllWindows: () => [] }
};

const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'electron' ? electronStub : load.call(this, request, ...rest);
};

const updater = require('../updater');

Module._load = load;

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

function equal(got, want, what) {
	assert(JSON.stringify(got) === JSON.stringify(want),
		(what || '') + ' got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

// --- version comparison -----------------------------------------------

check('compares versions numerically, not as strings', () => {
	const cmp = updater.compareVersions;
	assert(cmp('1.10.0', '1.9.0') > 0, '1.10.0 should beat 1.9.0');
	assert(cmp('1.10.8', '1.10.8') === 0, 'equal versions');
	assert(cmp('v1.11.0', '1.10.9') > 0, 'a v prefix should not matter');
	assert(cmp('2.0.0', '1.99.99') > 0, 'major version wins');
	assert(cmp('1.0', '1.0.0') === 0, 'a missing patch is zero');
});

check('treats a pre-release as older than the release', () => {
	const cmp = updater.compareVersions;
	assert(cmp('1.11.0', '1.11.0-beta.1') > 0, 'release should beat pre-release');
	assert(cmp('1.11.0-beta.1', '1.11.0') < 0, 'and the reverse');
});

// --- URL filtering ----------------------------------------------------

check('only trusts https GitHub hosts for downloads', () => {
	const ok = updater.isAllowedUrl;
	assert(ok('https://api.github.com/repos/a/b/releases/latest'), 'api.github.com');
	assert(ok('https://objects.githubusercontent.com/x'), 'the asset CDN');
	assert(!ok('http://github.com/x'), 'plain http must be refused');
	assert(!ok('https://github.com.attacker.net/x'), 'a lookalike host');
	assert(!ok('https://notgithub.com/x'), 'an unrelated host');
	assert(!ok('file:///etc/passwd'), 'a local file');
	assert(!ok('javascript:alert(1)'), 'a script url');
	assert(!ok('not a url at all'), 'unparseable input');
});

// --- asset filenames --------------------------------------------------

check('reduces a release asset name to one safe path component', () => {
	const safe = updater.safeAssetName;
	equal(safe('1.10.9', 'empanadas.io-Setup-1.10.9.exe'),
		'1.10.9-empanadas.io-Setup-1.10.9.exe', 'the ordinary case');
	// A release is remote data; these are what a hostile one could try.
	assert(!safe('1.0.0', '../../../evil.exe').includes('..'), 'traversal in the name');
	assert(!safe('../../x', 'a.exe').includes('/'), 'traversal in the tag');
	assert(!safe('1.0.0', '/etc/passwd').includes('/'), 'an absolute path');
	assert(!safe('1.0.0', 'a\\..\\b.exe').includes('\\'), 'a windows separator');
	assert(safe('1.0.0', 'x'.repeat(500)).length <= 128, 'an overlong name');
});

// --- update manifests -------------------------------------------------

// Exactly the shape electron-builder writes, taken from dist/latest.yml.
const WINDOWS_YML = [
	'version: 1.10.8',
	'files:',
	'  - url: empanadas.io-Setup-1.10.8.exe',
	'    sha512: WINDOWS_HASH_HERE==',
	'    size: 97707064',
	'path: empanadas.io-Setup-1.10.8.exe',
	'sha512: WINDOWS_HASH_HERE==',
	"releaseDate: '2026-09-01T18:11:32.382Z'",
	''
].join('\n');

// A macOS manifest lists both architectures and both artifact types, which is
// the case the old top-level-sha512 read got wrong.
const MAC_YML = [
	'version: 1.10.9',
	'files:',
	'  - url: empanadas.io-1.10.9-mac-arm64.zip',
	'    sha512: ARM64_ZIP_HASH==',
	'    size: 91000000',
	'  - url: empanadas.io-1.10.9-mac-arm64.dmg',
	'    sha512: ARM64_DMG_HASH==',
	'    size: 94000000',
	'  - url: empanadas.io-1.10.9-mac-x64.zip',
	'    sha512: X64_ZIP_HASH==',
	'    size: 95000000',
	'path: empanadas.io-1.10.9-mac-arm64.zip',
	'sha512: ARM64_ZIP_HASH==',
	"releaseDate: '2026-09-02T10:00:00.000Z'",
	''
].join('\n');

check('reads the hash for a single-artifact manifest', () => {
	equal(updater.sha512FromManifest(WINDOWS_YML, 'empanadas.io-Setup-1.10.8.exe'),
		'WINDOWS_HASH_HERE==');
});

check('picks the right hash when the manifest lists several artifacts', () => {
	// This is the bug the per-asset lookup exists to prevent: taking the
	// top-level sha512 would return the arm64 zip's hash for every one of these.
	const get = (name) => updater.sha512FromManifest(MAC_YML, name);
	equal(get('empanadas.io-1.10.9-mac-arm64.zip'), 'ARM64_ZIP_HASH==', 'arm64 zip');
	equal(get('empanadas.io-1.10.9-mac-x64.zip'), 'X64_ZIP_HASH==', 'x64 zip');
	equal(get('empanadas.io-1.10.9-mac-arm64.dmg'), 'ARM64_DMG_HASH==', 'arm64 dmg');
});

check('returns nothing for an asset the manifest does not list', () => {
	// Must be null, not the top-level hash - a wrong hash here either blocks a
	// good update or, worse, is quietly ignored.
	equal(updater.sha512FromManifest(MAC_YML, 'empanadas.io-1.10.9-mac-universal.zip'), null);
	equal(updater.sha512FromManifest(WINDOWS_YML, 'something-else.exe'), null);
});

check('handles percent-encoded names in a manifest', () => {
	const yml = [
		'version: 1.0.0',
		'files:',
		'  - url: empanadas.io%20Setup%201.0.0.exe',
		'    sha512: SPACED==',
		'    size: 1',
		''
	].join('\n');
	equal(updater.sha512FromManifest(yml, 'empanadas.io Setup 1.0.0.exe'), 'SPACED==');
});

check('does not read past the end of the files list', () => {
	// `sha512` appears again as a top-level key. An entry that does not match
	// must not pick that up by falling through.
	const yml = [
		'version: 1.0.0',
		'files:',
		'  - url: other.exe',
		'    size: 1',
		'path: real.exe',
		'sha512: TOP_LEVEL==',
		''
	].join('\n');
	equal(updater.sha512FromManifest(yml, 'other.exe'), null);
	equal(updater.sha512FromManifest(yml, 'real.exe'), 'TOP_LEVEL==');
});

// --- hash checking ----------------------------------------------------

check('accepts hashes that match', () => {
	updater.verifyHashes(
		{ sha256: 'ABCDEF', sha512b64: 'zzz==' },
		{ sha256: 'abcdef', sha512: 'zzz==' });
});

check('rejects a mismatched hash', () => {
	let threw = null;
	try {
		updater.verifyHashes({ sha256: 'abcdef' }, { sha256: 'abcdee' });
	} catch (err) {
		threw = err;
	}
	assert(threw && /mismatch/.test(threw.message), 'expected a mismatch error');
});

check('refuses to install when no hash was published', () => {
	let threw = null;
	try {
		updater.verifyHashes({}, { sha256: 'abcdef', sha512: 'zz' });
	} catch (err) {
		threw = err;
	}
	assert(threw && /no hash/i.test(threw.message),
		'an unhashed asset must be refused while requireHash is on');
});

check('rejects a hash of the wrong length without throwing on the compare', () => {
	// timingSafeEqual throws on unequal lengths; that must surface as a
	// mismatch, not as an unhandled error.
	let threw = null;
	try {
		updater.verifyHashes({ sha256: 'abc' }, { sha256: 'abcdef' });
	} catch (err) {
		threw = err;
	}
	assert(threw && /mismatch/.test(threw.message),
		'got: ' + (threw && threw.message));
});

module.exports = { failures };

if (require.main === module) {
	if (failures.length) {
		console.error('\n' + failures.length + ' failed');
		process.exit(1);
	}
	console.log('\nAll updater tests passed.');
}
