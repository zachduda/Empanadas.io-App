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
	releaseKeysFile: path.join(__dirname, 'release-keys.json'),

	// --- Windows code signing ----------------------------------------
	requireSignature: true,
	expectedPublisher: 'Empanadas.io',
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
	// How long a response may go without sending anything before it counts as
	// stalled. requestTimeoutMs only covers the wait for it to start.
	stallTimeoutMs: 60 * 1000,
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
let declined = null;
// A download that passed every check and was not installed ("Later"):
// { version, file, macBundle, stagingDir, size, sha512 }. Offered again by
// the next check the player asks for, rather than downloaded again.
let readyUpdate = null;

let windowProvider = () => null;

function setWindowProvider(fn) {
	windowProvider = typeof fn === 'function' ? fn : () => null;
}

function showDialog(options) {
	const parent = windowProvider();
	return parent && !parent.isDestroyed()
		? dialog.showMessageBox(parent, options)
		: dialog.showMessageBox(options);
}

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

// Fails a response that stops sending: without it a connection that goes
// quiet mid-body never ends, and the check it belongs to never finishes.
// Returns { touch, clear }: touch() on every chunk, clear() once it is over.
function watchForStall(res, url, onStall, timeout = CONFIG.stallTimeoutMs) {
	let timer = null;
	const clear = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};
	const touch = () => {
		clear();
		timer = setTimeout(() => {
			timer = null;
			res.destroy();
			onStall(new Error('Stalled waiting for ' + url));
		}, timeout);
	};
	touch();
	return { touch, clear };
}

async function getText(url, headers) {
	const res = await request(url, { headers });
	return new Promise((resolve, reject) => {
		let body = '';
		const stall = watchForStall(res, url, reject);
		res.on('data', (chunk) => {
			stall.touch();
			body += chunk.toString('utf8');
		});
		res.on('end', () => { stall.clear(); resolve(body); });
		res.on('error', (err) => { stall.clear(); reject(err); });
	});
}

async function getBuffer(url, maxBytes = 64 * 1024) {
	const res = await request(url, { headers: { Accept: 'application/octet-stream' } });
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const stall = watchForStall(res, url, reject);
		res.on('data', (chunk) => {
			stall.touch();
			size += chunk.length;
			if (size > maxBytes) {
				stall.clear();
				res.destroy();
				reject(new Error('Response from ' + url + ' is larger than ' + maxBytes + ' bytes'));
				return;
			}
			chunks.push(chunk);
		});
		res.on('end', () => { stall.clear(); resolve(Buffer.concat(chunks)); });
		res.on('error', (err) => { stall.clear(); reject(err); });
	});
}

async function getJson(url) {
	return JSON.parse(await getText(url, {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	}));
}

async function download(url, dest, onProgress, maxBytes = 0, stallTimeout = CONFIG.stallTimeoutMs) {
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
		let stall = null;
		const fail = (err) => {
			if (stall) stall.clear();
			out.destroy();
			reject(err);
		};
		stall = watchForStall(res, url, fail, stallTimeout);

		res.on('data', (chunk) => {
			stall.touch();
			received += chunk.length;
			if (maxBytes && received > maxBytes) {
				res.destroy();
				fail(new Error('Download exceeded the expected size of ' + maxBytes + ' bytes'));
				return;
			}
			sha256.update(chunk);
			sha512.update(chunk);
			if (!out.write(chunk)) {
				// The disk is behind, not the network: no stall while paused.
				res.pause();
				stall.clear();
				out.once('drain', () => {
					stall.touch();
					res.resume();
				});
			}
			if (onProgress && total) onProgress(received / total, received, total);
		});
		res.on('end', () => {
			stall.clear();
			out.end(resolve);
		});
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
			'See "Release signing" in docs/RELEASING.md.');
		return null;
	}

	const sigAsset = findSignatureAsset(release, asset);
	if (!sigAsset) {
		throw new Error('Release ' + release.tag_name + ' has no ' + asset.name +
			'.sig, and this build requires a signed release.');
	}

	const signature = await getBuffer(sigAsset.browser_download_url);
	const result = await pgp.verifyDetachedFileAsync(file, signature, keys);

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

async function verifySignature(file) {
	if (process.platform === 'win32') return verifyAuthenticode(file);
	if (process.platform === 'darwin') return verifyMacSignature(file);
	if (CONFIG.requireSignature) {
		throw new Error('No signature check is implemented for ' + process.platform + '.');
	}
}

function cacheDir() {
	const dir = path.join(app.getPath('userData'), 'updates');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

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
			fs.rmSync(path.join(dir, name), { recursive: true, force: true });
		} catch (err) {
			log('could not remove stale', name + ':', err.message);
		}
	}
}

// The SHA-512 of a file on disk, base64 as download() reports it.
function hashFile(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha512');
		let size = 0;
		fs.createReadStream(file)
			.on('data', (chunk) => { size += chunk.length; hash.update(chunk); })
			.on('end', () => resolve({ size, sha512: hash.digest('base64') }))
			.on('error', reject);
	});
}

// Is the download kept from earlier still the one that was verified? It has
// sat in a folder the user can write to since then, so it is hashed again and
// its code signature checked again before anything offers to run it.
async function readyUpdateStillGood(ready) {
	try {
		const now = await hashFile(ready.file);
		if (now.size !== ready.size || now.sha512 !== ready.sha512) return false;
		if (ready.macBundle) {
			if (!fs.existsSync(ready.macBundle)) return false;
			await verifySignature(ready.macBundle);
		} else {
			await verifySignature(ready.file);
		}
		return true;
	} catch (err) {
		log('the kept download no longer checks out:', err.message);
		return false;
	}
}

function forgetReadyUpdate() {
	const ready = readyUpdate;
	readyUpdate = null;
	if (!ready) return;
	for (const target of [ready.file, ready.stagingDir]) {
		if (!target) continue;
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch (err) {
			log('could not delete', target + ':', err.message);
		}
	}
}

// The last step: ask, then hand over to the installer. `ready` is a download
// that has passed every check. Resolves once the player has answered.
async function offerInstall(ready) {
	const latest = ready.version;
	setState({ status: 'ready', version: latest, progress: 1 });

	const { response } = await showDialog({
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
		readyUpdate = ready;
		declined = { version: latest, status: 'ready' };
		setState({ status: 'ready', version: latest });
		return;
	}

	readyUpdate = null;
	setState({ status: 'installing', version: latest });
	if (ready.macBundle) {
		await installMacUpdate(ready.macBundle, ready.stagingDir);
	} else {
		await runInstaller(ready.file);
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

function currentAppBundle() {
	const exe = app.getPath('exe');
	const bundle = path.resolve(exe, '..', '..', '..');
	if (!bundle.endsWith('.app')) {
		throw new Error('Could not locate the app bundle from ' + exe);
	}
	return bundle;
}

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

async function installMacUpdate(newBundle, staging) {
	const target = currentAppBundle();

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
				await showDialog({
					type: 'info',
					title: 'Empanadas.io',
					message: 'You are up to date!',
					detail: 'Version ' + current + ' is the latest release.',
					buttons: ['OK']
				});
			}
			return state;
		}

		const blocked = !CONFIG.assetPatterns[process.platform]
			? 'There is no automatic update for ' + process.platform + '.'
			: (process.platform === 'darwin' && CONFIG.requireSignature && !CONFIG.macTeamId)
				? 'Automatic updates are not enabled for macOS yet.'
				: null;

		if (blocked) {
			log('update available but not installable here:', blocked);
			setState({ status: 'available', version: latest });
			// Said once a session unasked, or nobody on this platform would
			// ever hear of a new version; and whenever it is asked for.
			const told = declined && declined.version === latest;
			if (!silent || !told) {
				declined = { version: latest, status: 'available' };
				const { response } = await showDialog({
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

		if (silent && declined && declined.version === latest) {
			log('update ' + latest + ' was declined this session; not asking again');
			setState({ status: declined.status, version: latest });
			return state;
		}

		// Downloaded and verified earlier, then put off: straight to the
		// install prompt, without fetching it all again.
		if (readyUpdate && readyUpdate.version !== latest) forgetReadyUpdate();
		if (readyUpdate) {
			const ready = readyUpdate;
			setState({ status: 'verifying', version: latest, progress: 1 });
			if (await readyUpdateStillGood(ready)) {
				await offerInstall(ready);
				return state;
			}
			forgetReadyUpdate();
		}

		const asset = pickAsset(release);
		setState({ status: 'available', version: latest });

		const askDownload = await showDialog({
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
			declined = { version: latest, status: 'declined' };
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

		await verifyReleaseSignature(release, asset, finalPath);

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
		// From here the files are the kept download's, not this attempt's:
		// a failure below must not delete what was verified.
		const ready = {
			version: latest,
			file: finalPath,
			macBundle,
			stagingDir,
			size: actual.size,
			sha512: actual.sha512
		};
		downloadPath = null;
		stagingDir = null;
		await offerInstall(ready);

		return state;
	} catch (err) {
		setProgressBar(-1);
		log('failed:', err.message);
		setState({ status: 'error', error: err.message });
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
			await showDialog({
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
	setWindowProvider,
	checkForUpdates,
	checkFromRenderer,
	getState: () => state,
	// exported for testing
	compareVersions,
	verifyHashes,
	sha512FromManifest,
	safeAssetName,
	isAllowedUrl,
	download,
	hashFile
};
