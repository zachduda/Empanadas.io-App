'use strict';

const { app, dialog, net, shell, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const pgp = require('./lib/pgp');

const CONFIG = {
	owner: 'zachduda',
	repo: 'Empanadas.io-App',
	allowPrerelease: false,

	// Which release asset to install, per platform. macOS installs from the zip
	// rather than the dmg: a dmg cannot replace the app it is running from.
	assetPatterns: {
		win32: () => /setup.*\.exe$/i,
		darwin: () => new RegExp('-mac-' + process.arch + '\\.zip$', 'i')
	},

	requireHash: true,

	// --- release signature (all platforms) ---------------------------
	// A detached OpenPGP signature over the asset, uploaded next to it as
	// <asset>.sig. Unlike the hashes, this does not come from GitHub's own
	// metadata, so it still holds if the GitHub account is taken over.
	//
	// Enforced whenever release-keys.json is present, which it is in any real
	// build. Nobody can turn that off remotely: removing the file from a signed
	// app breaks the app's own code signature.
	releaseKeysFile: path.join(__dirname, 'release-keys.json'),

	// --- Windows code signing ----------------------------------------
	requireSignature: true,
	expectedPublisher: 'Empanadas.io',
	// SHA-1 thumbprints of the Authenticode certificates allowed to sign a
	// release. Empty means "any certificate whose subject contains
	// expectedPublisher", which is weaker: a certificate naming Empanadas.io
	// issued to someone else would pass. Keep two entries across a cert
	// rollover so in-flight clients accept both the old and the new one.
	// Print one with: node scripts/thumbprint.js <installer.exe>
	pinnedThumbprints: [],

	// --- macOS code signing ------------------------------------------
	// Gatekeeper checks the signature; these pin *whose* signature it is.
	// Fill in from: node scripts/thumbprint.js <Empanadas.io.app>
	macTeamId: null,
	macBundleId: 'io.empanadas.app',
	// Notarization check. Off only for testing against an un-notarized build.
	macRequireNotarized: true,

	installerArgs: ['--updated'],
	firstCheckDelayMs: 8 * 1000,
	recheckIntervalMs: 6 * 60 * 60 * 1000,
	requestTimeoutMs: 30 * 1000,
	manualCheckCooldownMs: 60 * 1000
};

function assetPattern() {
	const build = CONFIG.assetPatterns[process.platform];
	if (!build) throw new Error('No update assets are published for ' + process.platform);
	return build();
}

const USER_AGENT = 'Empanadas.io-App/' + app.getVersion() + ' (+https://empanadas.io)';

// Every URL the updater touches comes out of a GitHub API response, i.e. off
// the network. Nothing is fetched, followed or opened unless it is https and
// lands on a host GitHub actually serves releases from.
const ALLOWED_HOSTS = [
	'api.github.com',
	'github.com',
	'objects.githubusercontent.com',
	'release-assets.githubusercontent.com',
	'raw.githubusercontent.com'
];

const MAX_REDIRECTS = 5;

function isAllowedUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (err) {
		return false;
	}
	if (parsed.protocol !== 'https:') return false;
	return ALLOWED_HOSTS.some((host) =>
		parsed.hostname === host || parsed.hostname.endsWith('.' + host));
}

function requireAllowedUrl(url) {
	if (!isAllowedUrl(url)) {
		throw new Error('Refusing to fetch untrusted update URL: ' + url);
	}
	return url;
}

let state = { status: 'idle', version: null, progress: 0, error: null };
let busy = false;
let lastManualCheck = 0;
let timer = null;

function log(...args) {
	console.log('[updater]', ...args);
}

function setState(patch) {
	state = Object.assign({}, state, patch);
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed()) w.webContents.send('updater:state', state);
	}
}

function setProgressBar(value) {
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed()) w.setProgressBar(value);
	}
}

function compareVersions(a, b) {
	const parse = (v) => {
		const clean = String(v).trim().replace(/^v/i, '');
		const [core, pre = ''] = clean.split('-', 2);
		const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
		while (nums.length < 3) nums.push(0);
		return { nums, pre };
	};

	const pa = parse(a);
	const pb = parse(b);

	for (let i = 0; i < 3; i++) {
		if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
	}

	// A release always beats a pre-release of the same core version.
	if (!pa.pre && pb.pre) return 1;
	if (pa.pre && !pb.pre) return -1;
	if (pa.pre === pb.pre) return 0;
	return pa.pre > pb.pre ? 1 : -1;
}

function request(url, { headers = {}, timeout = CONFIG.requestTimeoutMs } = {}) {
	requireAllowedUrl(url);

	return new Promise((resolve, reject) => {
		// 'manual' rather than 'follow' so each hop is checked. With 'follow',
		// a redirect to http:// or to an unrelated host would be taken
		// silently, and an update downloaded over plain http is an update an
		// on-path attacker gets to choose.
		const req = net.request({ method: 'GET', url, redirect: 'manual' });
		req.setHeader('User-Agent', USER_AGENT);
		for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);

		let hops = 0;

		const timer = setTimeout(() => {
			req.abort();
			reject(new Error('Timed out requesting ' + url));
		}, timeout);

		req.on('redirect', (statusCode, method, redirectUrl) => {
			if (++hops > MAX_REDIRECTS) {
				clearTimeout(timer);
				req.abort();
				reject(new Error('Too many redirects from ' + url));
				return;
			}
			if (!isAllowedUrl(redirectUrl)) {
				clearTimeout(timer);
				req.abort();
				reject(new Error('Refusing redirect to untrusted URL: ' + redirectUrl));
				return;
			}
			req.followRedirect();
		});

		req.on('response', (res) => {
			clearTimeout(timer);
			if (res.statusCode < 200 || res.statusCode >= 300) {
				res.resume();
				reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
				return;
			}
			resolve(res);
		});
		req.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		req.end();
	});
}

async function getText(url, headers) {
	const res = await request(url, { headers });
	return new Promise((resolve, reject) => {
		let body = '';
		res.on('data', (chunk) => { body += chunk.toString('utf8'); });
		res.on('end', () => resolve(body));
		res.on('error', reject);
	});
}

// For small binaries - signature files, a few hundred bytes. Capped so a
// mislabelled or hostile response cannot be read into memory unbounded.
async function getBuffer(url, maxBytes = 64 * 1024) {
	const res = await request(url, { headers: { Accept: 'application/octet-stream' } });
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		res.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				res.destroy();
				reject(new Error('Response from ' + url + ' is larger than ' + maxBytes + ' bytes'));
				return;
			}
			chunks.push(chunk);
		});
		res.on('end', () => resolve(Buffer.concat(chunks)));
		res.on('error', reject);
	});
}

async function getJson(url) {
	return JSON.parse(await getText(url, {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	}));
}

async function download(url, dest, onProgress, maxBytes = 0) {
	const res = await request(url, { headers: { Accept: 'application/octet-stream' } });
	const total = parseInt(res.headers['content-length'], 10) || 0;

	if (maxBytes && total > maxBytes) {
		throw new Error('Asset is larger than the release says (' + total + ' > ' + maxBytes + ')');
	}

	const sha256 = crypto.createHash('sha256');
	const sha512 = crypto.createHash('sha512');
	let received = 0;

	await new Promise((resolve, reject) => {
		const out = fs.createWriteStream(dest);
		const fail = (err) => {
			out.destroy();
			reject(err);
		};

		res.on('data', (chunk) => {
			received += chunk.length;
			// A server that ignores content-length should not be able to fill
			// the user's disk.
			if (maxBytes && received > maxBytes) {
				res.destroy();
				fail(new Error('Download exceeded the expected size of ' + maxBytes + ' bytes'));
				return;
			}
			sha256.update(chunk);
			sha512.update(chunk);
			// Respect backpressure - the installer is >100 MB and arrives far
			// faster than it lands on disk, so without this it all piles up
			// in memory.
			if (!out.write(chunk)) {
				res.pause();
				out.once('drain', () => res.resume());
			}
			if (onProgress && total) onProgress(received / total, received, total);
		});
		res.on('end', () => out.end(resolve));
		res.on('error', fail);
		out.on('error', fail);
	});

	if (total && received !== total) {
		throw new Error('Download truncated: got ' + received + ' of ' + total + ' bytes');
	}

	return {
		size: received,
		sha256: sha256.digest('hex'),
		sha512: sha512.digest('base64')
	};
}

async function fetchLatestRelease() {
	const base = 'https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/releases';

	if (!CONFIG.allowPrerelease) {
		return getJson(base + '/latest');
	}

	const releases = await getJson(base + '?per_page=20');
	const usable = releases.filter((r) => !r.draft);
	if (!usable.length) throw new Error('No published releases found');

	return usable.reduce((best, r) =>
		compareVersions(r.tag_name, best.tag_name) > 0 ? r : best);
}

function pickAsset(release) {
	const pattern = assetPattern();
	const asset = (release.assets || []).find((a) =>
		a.state === 'uploaded' && pattern.test(a.name));
	if (!asset) {
		throw new Error(
			'Release ' + release.tag_name + ' has no asset matching ' +
			pattern + ' for ' + process.platform + '/' + process.arch + ' (found: ' +
			((release.assets || []).map((a) => a.name).join(', ') || 'none') + ')'
		);
	}
	return asset;
}

// electron-builder names its update manifest per platform.
const MANIFEST_NAME = {
	win32: 'latest.yml',
	darwin: 'latest-mac.yml',
	linux: 'latest-linux.yml'
}[process.platform] || 'latest.yml';

// Pulls the SHA-512 for one specific asset out of an electron-builder manifest.
//
// The manifest lists every artifact of that platform - both architectures, the
// zip and the dmg - so the top-level `sha512:` is only right for whichever one
// `path:` names. Matching on the file name is what makes this correct when a
// release has more than one.
//
// Written as a line scan rather than a YAML parse: the shape is fixed and
// known, and this avoids a YAML dependency inside the verification path.
function sha512FromManifest(yml, assetName) {
	const lines = yml.split(/\r?\n/);
	let inEntry = false;

	for (const line of lines) {
		const url = /^\s*-\s*url:\s*(\S+)\s*$/.exec(line);
		if (url) {
			// Names with spaces arrive percent-encoded.
			inEntry = decodeURIComponent(url[1]) === assetName;
			continue;
		}
		if (!inEntry) continue;

		const sha = /^\s+sha512:\s*(\S+)\s*$/.exec(line);
		if (sha) return sha[1];

		// An unindented line means the files list is over.
		if (/^\S/.test(line)) inEntry = false;
	}

	// Older manifests, and single-artifact ones, only have the top-level pair.
	const named = /^path:\s*(\S+)\s*$/m.exec(yml);
	const top = /^sha512:\s*(\S+)\s*$/m.exec(yml);
	if (named && top && decodeURIComponent(named[1]) === assetName) return top[1];

	return null;
}

async function collectExpectedHashes(release, asset) {
	const expected = {};

	if (typeof asset.digest === 'string') {
		const m = /^sha(256|512):([0-9a-f]+)$/i.exec(asset.digest.trim());
		if (m) expected['sha' + m[1]] = m[2].toLowerCase();
	}

	// A release that ships both platforms carries both latest.yml and
	// latest-mac.yml, so the manifest has to be chosen by platform. Reading the
	// wrong one would compare the mac zip against the Windows installer's hash
	// and refuse every update.
	const manifest = (release.assets || []).find((a) =>
		a.state === 'uploaded' && a.name.toLowerCase() === MANIFEST_NAME);

	if (manifest) {
		try {
			const yml = await getText(manifest.browser_download_url);
			const sha512 = sha512FromManifest(yml, asset.name);
			if (sha512) expected.sha512b64 = sha512;
			else log(manifest.name + ' has no entry for ' + asset.name);
		} catch (err) {
			log('could not read', manifest.name + ':', err.message);
		}
	}

	return expected;
}

function verifyHashes(expected, actual) {
	const checks = [];

	if (expected.sha256) {
		checks.push(['SHA-256', expected.sha256, actual.sha256]);
	}
	if (expected.sha512) {
		checks.push(['SHA-512', expected.sha512, Buffer.from(actual.sha512, 'base64').toString('hex')]);
	}
	if (expected.sha512b64) {
		checks.push(['SHA-512 (latest.yml)', expected.sha512b64, actual.sha512]);
	}

	if (!checks.length) {
		if (CONFIG.requireHash) {
			throw new Error('GitHub published no hash for this asset; refusing to install.');
		}
		log('WARNING: no published hash to check against');
		return;
	}

	for (const [name, want, got] of checks) {
		// Fixed-length values, so a timing-safe compare costs nothing.
		const a = Buffer.from(String(want).toLowerCase());
		const b = Buffer.from(String(got).toLowerCase());
		if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
			throw new Error(name + ' mismatch: expected ' + want + ', got ' + got);
		}
		log(name + ' OK');
	}
}

// --- release signature ------------------------------------------------

// Reads the pinned keys off disk. Missing file means the project has not
// adopted release signing yet and the check is skipped; a file that is present
// but unreadable or malformed is an error, because that is what tampering looks
// like and "corrupt" must never soften into "skip".
function loadReleaseKeys() {
	if (!fs.existsSync(CONFIG.releaseKeysFile)) return null;

	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(CONFIG.releaseKeysFile, 'utf8'));
	} catch (err) {
		throw new Error('release-keys.json could not be read: ' + err.message);
	}

	if (!Array.isArray(parsed) || !parsed.length) {
		throw new Error('release-keys.json contains no keys');
	}
	for (const key of parsed) {
		if (!key || typeof key.fingerprint !== 'string' || typeof key.pem !== 'string') {
			throw new Error('release-keys.json has a malformed entry');
		}
	}
	return parsed;
}

function findSignatureAsset(release, asset) {
	const want = (asset.name + '.sig').toLowerCase();
	const wantAsc = (asset.name + '.asc').toLowerCase();
	return (release.assets || []).find((a) =>
		a.state === 'uploaded' &&
		(a.name.toLowerCase() === want || a.name.toLowerCase() === wantAsc));
}

async function verifyReleaseSignature(release, asset, file) {
	const keys = loadReleaseKeys();
	if (!keys) {
		log('WARNING: no release-keys.json - skipping the OpenPGP check. ' +
			'See "Release signing" in the README.');
		return null;
	}

	const sigAsset = findSignatureAsset(release, asset);
	if (!sigAsset) {
		throw new Error('Release ' + release.tag_name + ' has no ' + asset.name +
			'.sig, and this build requires a signed release.');
	}

	const signature = await getBuffer(sigAsset.browser_download_url);
	const result = pgp.verifyDetachedFile(file, signature, keys);

	log('OpenPGP OK: signed by ' + result.key.fingerprint + ' (' + result.hash + ')');
	return result;
}

const AUTHENTICODE_PS = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath $env:EMPANADAS_UPDATE_FILE
[pscustomobject]@{
	status     = [string]$sig.Status
	message    = [string]$sig.StatusMessage
	subject    = [string]$sig.SignerCertificate.Subject
	thumbprint = [string]$sig.SignerCertificate.Thumbprint
} | ConvertTo-Json -Compress
`;

function authenticodeInfo(file) {
	return new Promise((resolve, reject) => {
		execFile('powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', AUTHENTICODE_PS],
			{
				timeout: 60 * 1000,
				windowsHide: true,
				env: Object.assign({}, process.env, { EMPANADAS_UPDATE_FILE: file })
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error('Could not read the signature: ' + (stderr || err.message).trim()));
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (parseErr) {
					reject(new Error('Unexpected signature output: ' + stdout.trim()));
				}
			});
	});
}

async function verifyAuthenticode(file) {
	let info;
	try {
		info = await authenticodeInfo(file);
	} catch (err) {
		if (CONFIG.requireSignature) throw err;
		log('WARNING: signature check failed to run:', err.message);
		return;
	}

	const problem = (why) => {
		if (CONFIG.requireSignature) throw new Error(why);
		log('WARNING:', why);
	};

	if (info.status !== 'Valid') {
		problem('Installer signature is not valid (' + info.status + ': ' + (info.message || '') + ')');
		return;
	}

	const thumbprint = String(info.thumbprint || '').toUpperCase();
	const subject = String(info.subject || '');

	// A pinned thumbprint identifies one specific certificate, so when there is
	// one it is the whole check - the publisher name is a property of that
	// certificate and adds nothing.
	if (CONFIG.pinnedThumbprints.length) {
		const pinned = CONFIG.pinnedThumbprints.map((t) => String(t).replace(/\s/g, '').toUpperCase());
		if (!pinned.includes(thumbprint)) {
			problem('Installer signing certificate ' + (thumbprint || '(none)') +
				' is not one of the pinned certificates.');
			return;
		}
		log('Authenticode OK: pinned certificate ' + thumbprint);
		return;
	}

	// No pin configured: fall back to the publisher name in the subject. This is
	// weaker - a certificate issued to someone else with "Empanadas.io" in its
	// subject would pass - so it is only the interim position.
	if (CONFIG.expectedPublisher &&
		!subject.toLowerCase().includes(CONFIG.expectedPublisher.toLowerCase())) {
		problem('Installer is signed by an unexpected publisher: ' + subject);
		return;
	}

	log('Authenticode OK (unpinned):', subject, thumbprint);
}

// --- macOS code signing -----------------------------------------------

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		execFile(command, args, Object.assign({ timeout: 5 * 60 * 1000 }, options),
			(err, stdout, stderr) => {
				// codesign and spctl report their findings on stderr even when
				// they succeed, so both streams come back either way.
				if (err) {
					err.stdout = stdout;
					err.stderr = stderr;
					reject(err);
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			});
	});
}

// Reads the identity out of a signed bundle. `codesign -dv` writes its report
// to stderr as key=value lines.
async function codesignInfo(bundle) {
	const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
	const info = {};
	for (const line of stderr.split('\n')) {
		const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
		if (m) info[m[1]] = m[2];
	}
	return info;
}

async function verifyMacSignature(bundle) {
	const problem = (why) => {
		if (CONFIG.requireSignature) throw new Error(why);
		log('WARNING:', why);
	};

	// --deep --strict checks the whole bundle, not just the outer seal: the
	// framework and helper binaries inside an Electron app are separately
	// signed, and an unsigned one swapped in would otherwise go unnoticed.
	try {
		await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
	} catch (err) {
		problem('Code signature check failed: ' + String(err.stderr || err.message).trim());
		return;
	}

	let info;
	try {
		info = await codesignInfo(bundle);
	} catch (err) {
		problem('Could not read the code signature: ' + String(err.stderr || err.message).trim());
		return;
	}

	if (CONFIG.macBundleId && info.Identifier !== CONFIG.macBundleId) {
		problem('Downloaded app identifies itself as ' + info.Identifier +
			', expected ' + CONFIG.macBundleId);
		return;
	}

	// The Team ID is the pin: it says the Apple Developer account that signed
	// this, which a certificate subject string cannot be trusted to convey.
	if (CONFIG.macTeamId) {
		if (info.TeamIdentifier !== CONFIG.macTeamId) {
			problem('Downloaded app was signed by team ' + (info.TeamIdentifier || '(none)') +
				', expected ' + CONFIG.macTeamId);
			return;
		}
	} else if (CONFIG.requireSignature) {
		problem('No macTeamId is pinned, so the signature cannot be attributed. ' +
			'Set CONFIG.macTeamId in updater.js.');
		return;
	}

	// Gatekeeper's own assessment, which is what fails if the build was never
	// notarized or the notarization was revoked.
	if (CONFIG.macRequireNotarized) {
		try {
			await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
		} catch (err) {
			problem('Gatekeeper rejected the download (not notarized?): ' +
				String(err.stderr || err.message).trim());
			return;
		}
	}

	log('codesign OK:', info.Identifier, 'team', info.TeamIdentifier);
}

// Dispatches to whichever signature scheme the platform actually has. This is
// the second, independent check: the OpenPGP signature says the release came
// from the project, this says the binary is one the OS will accept.
async function verifySignature(file) {
	if (process.platform === 'win32') return verifyAuthenticode(file);
	if (process.platform === 'darwin') return verifyMacSignature(file);
	if (CONFIG.requireSignature) {
		throw new Error('No signature check is implemented for ' + process.platform + '.');
	}
}

// userData, not temp: the installer is verified and then launched from here, and
// on a shared machine the system temp directory is somewhere another user can
// write. That would let them swap the file between the hash check and the
// spawn - the app would run their binary having verified ours.
function cacheDir() {
	const dir = path.join(app.getPath('userData'), 'updates');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

// The asset name comes from the release, so it is not automatically a safe path
// component. Keep it to something that can only ever name a file in cacheDir().
function safeAssetName(version, name) {
	const base = path.basename(String(name)).replace(/[^A-Za-z0-9._-]/g, '_');
	const tag = String(version).replace(/[^A-Za-z0-9._-]/g, '_');
	if (!base || base === '.' || base === '..') {
		throw new Error('Release asset has an unusable name: ' + name);
	}
	return (tag + '-' + base).slice(0, 128);
}

function cleanCache(keep) {
	const dir = cacheDir();
	for (const name of fs.readdirSync(dir)) {
		if (name === keep) continue;
		try {
			// recursive: a staging directory from an interrupted macOS install
			// is a tree, not a file.
			fs.rmSync(path.join(dir, name), { recursive: true, force: true });
		} catch (err) {
			log('could not remove stale', name + ':', err.message);
		}
	}
}

function isDisabled() {
	return process.argv.includes('--no-update') || process.env.EMPANADAS_NO_UPDATE === '1';
}

async function runInstaller(file) {
	log('launching installer', file);
	const child = spawn(file, CONFIG.installerArgs, { detached: true, stdio: 'ignore' });
	child.unref();
	// Give the installer a moment
	setTimeout(() => app.quit(), 1000);
}

// --- macOS install ----------------------------------------------------

// The running app bundle, derived from the executable inside it:
//   .../Empanadas.io.app/Contents/MacOS/empanadas.io
function currentAppBundle() {
	const exe = app.getPath('exe');
	const bundle = path.resolve(exe, '..', '..', '..');
	if (!bundle.endsWith('.app')) {
		throw new Error('Could not locate the app bundle from ' + exe);
	}
	return bundle;
}

// Unpacks the release zip. `ditto` rather than `unzip`: it preserves the
// extended attributes and symlinks an app bundle's code signature is computed
// over, and unzip quietly destroys them - the signature check would then fail
// on a perfectly good download.
async function extractZip(zipPath, into) {
	fs.mkdirSync(into, { recursive: true, mode: 0o700 });
	await run('/usr/bin/ditto', ['-x', '-k', zipPath, into]);

	const entries = fs.readdirSync(into).filter((n) => n.endsWith('.app'));
	if (entries.length !== 1) {
		throw new Error('Expected exactly one .app in the archive, found ' +
			(entries.join(', ') || 'none'));
	}
	return path.join(into, entries[0]);
}

// Replaces the running bundle and relaunches.
//
// This cannot be done from inside the process being replaced, so it is handed
// to a small shell script that waits for this app to exit first. The swap moves
// the old bundle aside rather than deleting it, so a failure part-way through
// leaves the user with a working app instead of an empty /Applications entry.
async function installMacUpdate(newBundle, staging) {
	const target = currentAppBundle();

	// Fail here, before anything is moved, if the app lives somewhere this user
	// cannot write - a copy in /Applications installed by another account, say.
	try {
		fs.accessSync(path.dirname(target), fs.constants.W_OK);
	} catch (err) {
		throw new Error('Cannot update ' + target + ': no write access to ' +
			path.dirname(target) + '. Install the new version by hand.');
	}

	const script = path.join(cacheDir(), 'swap.sh');
	const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

	fs.writeFileSync(script, [
		'#!/bin/sh',
		'# Written by the Empanadas.io updater. Safe to delete.',
		'set -u',
		'TARGET=' + q(target),
		'NEW=' + q(newBundle),
		'STAGING=' + q(staging),
		'BACKUP="$TARGET.old-$$"',
		'',
		'# Wait for the app to actually exit before touching its bundle.',
		'i=0',
		'while kill -0 ' + process.pid + ' 2>/dev/null; do',
		'  i=$((i+1))',
		'  [ "$i" -gt 300 ] && exit 1',
		'  sleep 0.2',
		'done',
		'',
		'mv "$TARGET" "$BACKUP" || exit 1',
		'if ditto "$NEW" "$TARGET"; then',
		'  rm -rf "$BACKUP"',
		'else',
		'  # Put the working copy back rather than leaving nothing behind.',
		'  rm -rf "$TARGET"',
		'  mv "$BACKUP" "$TARGET"',
		'fi',
		'rm -rf "$STAGING"',
		'open "$TARGET"',
		'rm -f "$0"',
		''
	].join('\n'), { mode: 0o700 });

	log('handing off to', script);
	const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
	child.unref();
	setTimeout(() => app.quit(), 500);
}

async function checkForUpdates({ silent = true } = {}) {
	if (busy) return state;
	if (isDisabled()) {
		log('updates disabled by flag');
		return state;
	}
	if (!app.isPackaged) {
		log('skipping check: app is not packaged');
		return state;
	}

	busy = true;
	setState({ status: 'checking', error: null, progress: 0 });

	let downloadPath = null;
	let stagingDir = null;

	try {
		const release = await fetchLatestRelease();
		const current = app.getVersion();
		const latest = String(release.tag_name || '').replace(/^v/i, '');

		log('installed ' + current + ', latest published ' + latest);

		if (compareVersions(latest, current) <= 0) {
			setState({ status: 'up-to-date', version: current });
			if (!silent) {
				await dialog.showMessageBox({
					type: 'info',
					title: 'Empanadas.io',
					message: 'You are up to date!',
					detail: 'Version ' + current + ' is the latest release.',
					buttons: ['OK']
				});
			}
			return state;
		}

		// Reasons this platform cannot install an update, checked before
		// anything is downloaded. Finding out after pulling 90 MB that the
		// build was never going to be installable is a waste of the user's
		// bandwidth and ends in an error dialog rather than an explanation.
		const blocked = !CONFIG.assetPatterns[process.platform]
			? 'There is no automatic update for ' + process.platform + '.'
			: (process.platform === 'darwin' && CONFIG.requireSignature && !CONFIG.macTeamId)
				? 'Automatic updates are not enabled for macOS yet.'
				: null;

		if (blocked) {
			log('update available but not installable here:', blocked);
			setState({ status: 'available', version: latest });
			if (!silent) {
				const { response } = await dialog.showMessageBox({
					type: 'info',
					title: 'Update available',
					message: 'Empanadas.io ' + latest + ' is available.',
					detail: 'You have ' + current + '. ' + blocked +
						' Open the download page to get the new version.',
					buttons: ['Open download page', 'Not now'],
					defaultId: 0,
					cancelId: 1
				});
				if (response === 0) shell.openExternal('https://empanadas.io/download');
			}
			return state;
		}

		const asset = pickAsset(release);
		setState({ status: 'available', version: latest });

		const askDownload = await dialog.showMessageBox({
			type: 'question',
			title: 'Update available',
			message: 'Empanadas.io ' + latest + ' is available.',
			detail: 'You have ' + current + '. Download it now? ' +
				'(' + (asset.size / 1048576).toFixed(1) + ' MB)',
			buttons: ['Download', 'Not now', 'View release notes'],
			defaultId: 0,
			cancelId: 1
		});
		if (askDownload.response === 2) {
			// html_url is whatever the API returned; openExternal will happily
			// hand a non-https scheme to the OS handler for it.
			if (isAllowedUrl(release.html_url)) shell.openExternal(release.html_url);
			setState({ status: 'available', version: latest });
			return state;
		}
		if (askDownload.response !== 0) {
			setState({ status: 'declined', version: latest });
			return state;
		}

		// --- download ------------------------------------------------
		const expected = await collectExpectedHashes(release, asset);
		const finalName = safeAssetName(latest, asset.name);
		const finalPath = path.join(cacheDir(), finalName);
		const partPath = finalPath + '.part';

		cleanCache(finalName);

		setState({ status: 'downloading', version: latest, progress: 0 });

		downloadPath = partPath;

		let lastReported = 0;
		const actual = await download(asset.browser_download_url, partPath, (ratio) => {
			setProgressBar(ratio);
			// Throttle IPC chatter to whole percentage points.
			const pct = Math.floor(ratio * 100);
			if (pct !== lastReported) {
				lastReported = pct;
				setState({ status: 'downloading', version: latest, progress: ratio });
			}
		}, asset.size ? asset.size + 1024 * 1024 : 0);
		setProgressBar(-1);

		setState({ status: 'verifying', version: latest, progress: 1 });
		log('downloaded ' + actual.size + ' bytes; verifying');

		verifyHashes(expected, actual);

		fs.renameSync(partPath, finalPath);
		downloadPath = finalPath;

		// Two independent signatures. The OpenPGP one is checked first because
		// it is the one that does not depend on GitHub: if the release itself
		// is not ours, there is no reason to go on and ask the OS about it.
		await verifyReleaseSignature(release, asset, finalPath);

		// Windows verifies the installer directly. macOS has to unpack the zip
		// first, because what gets signed and installed there is the .app
		// inside it, not the archive.
		let macBundle = null;
		if (process.platform === 'darwin') {
			stagingDir = path.join(cacheDir(), 'staging-' + process.pid);
			fs.rmSync(stagingDir, { recursive: true, force: true });
			macBundle = await extractZip(finalPath, stagingDir);
			await verifySignature(macBundle);
		} else {
			await verifySignature(finalPath);
		}

		// --- install -------------------------------------------------
		setState({ status: 'ready', version: latest, progress: 1 });

		const { response } = await dialog.showMessageBox({
			type: 'info',
			title: 'Update ready',
			message: 'Empanadas.io ' + latest + ' is verified and ready to install.',
			detail: process.platform === 'darwin'
				? 'The app will close, update itself, and reopen.'
				: 'The app will close while the installer runs.',
			buttons: ['Install now', 'Later'],
			defaultId: 0,
			cancelId: 1
		});

		if (response !== 0) {
			setState({ status: 'ready', version: latest });
			return state;
		}

		setState({ status: 'installing', version: latest });
		if (macBundle) {
			// installMacUpdate takes ownership of the staging directory: its
			// script removes it after the swap, so the cleanup below must not.
			const handoff = stagingDir;
			stagingDir = null;
			await installMacUpdate(macBundle, handoff);
		} else {
			await runInstaller(finalPath);
		}

		return state;
	} catch (err) {
		setProgressBar(-1);
		log('failed:', err.message);
		setState({ status: 'error', error: err.message });

		// Anything that failed verification is deleted rather than left lying
		// around in a directory the app launches things from.
		if (downloadPath) {
			try {
				fs.rmSync(downloadPath, { force: true });
			} catch (rmErr) {
				log('could not delete', downloadPath + ':', rmErr.message);
			}
		}
		if (stagingDir) {
			try {
				fs.rmSync(stagingDir, { recursive: true, force: true });
			} catch (rmErr) {
				log('could not delete', stagingDir + ':', rmErr.message);
			}
		}

		if (!silent) {
			await dialog.showMessageBox({
				type: 'error',
				title: 'Update failed',
				message: 'Could not update Empanadas.io.',
				detail: err.message,
				buttons: ['OK']
			});
		}
		return state;
	} finally {
		busy = false;
	}
}

function start() {
	if (isDisabled()) {
		log('auto updates disabled');
		return;
	}
	setTimeout(() => checkForUpdates({ silent: true }), CONFIG.firstCheckDelayMs);
	timer = setInterval(() => checkForUpdates({ silent: true }), CONFIG.recheckIntervalMs);
	// Don't hold the process open just for the timer.
	if (timer.unref) timer.unref();
}

function stop() {
	if (timer) clearInterval(timer);
	timer = null;
}

function checkFromRenderer() {
	const now = Date.now();
	if (now - lastManualCheck < CONFIG.manualCheckCooldownMs) return state;
	lastManualCheck = now;
	return checkForUpdates({ silent: false });
}

module.exports = {
	CONFIG,
	start,
	stop,
	checkForUpdates,
	checkFromRenderer,
	getState: () => state,
	// exported for testing
	compareVersions,
	verifyHashes,
	sha512FromManifest,
	safeAssetName,
	isAllowedUrl,
	download
};
