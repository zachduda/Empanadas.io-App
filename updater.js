'use strict';

const { app, dialog, net, shell, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CONFIG = {
	owner: 'zachduda',
	repo: 'Empanadas.io-App',
	allowPrerelease: false,
	assetPattern: /setup.*\.exe$/i,
	expectedPublisher: 'Empanadas.io',
	expectedThumbprint: null,
	requireSignature: true,
	requireHash: true,
	installerArgs: ['--updated'],
	firstCheckDelayMs: 8 * 1000,
	recheckIntervalMs: 6 * 60 * 60 * 1000,
	requestTimeoutMs: 30 * 1000,
	manualCheckCooldownMs: 60 * 1000
};

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
	const asset = (release.assets || []).find((a) =>
		a.state === 'uploaded' && CONFIG.assetPattern.test(a.name));
	if (!asset) {
		throw new Error(
			'Release ' + release.tag_name + ' has no asset matching ' +
			CONFIG.assetPattern + ' (found: ' +
			((release.assets || []).map((a) => a.name).join(', ') || 'none') + ')'
		);
	}
	return asset;
}

async function collectExpectedHashes(release, asset) {
	const expected = {};

	if (typeof asset.digest === 'string') {
		const m = /^sha(256|512):([0-9a-f]+)$/i.exec(asset.digest.trim());
		if (m) expected['sha' + m[1]] = m[2].toLowerCase();
	}

	const manifest = (release.assets || []).find((a) => /^latest.*\.yml$/i.test(a.name));
	if (manifest) {
		try {
			const yml = await getText(manifest.browser_download_url);
			// Match the top-level `sha512:` key, i.e. the one for `path`.
			const m = /^sha512:\s*(\S+)\s*$/m.exec(yml);
			if (m) expected.sha512b64 = m[1];
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

async function verifySignature(file) {
	if (process.platform !== 'win32') {
		if (CONFIG.requireSignature) {
			throw new Error('Signature verification is only implemented for Windows.');
		}
		return;
	}

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

	const subject = String(info.subject || '');
	if (CONFIG.expectedPublisher &&
		!subject.toLowerCase().includes(CONFIG.expectedPublisher.toLowerCase())) {
		problem('Installer is signed by an unexpected publisher: ' + subject);
		return;
	}

	if (CONFIG.expectedThumbprint &&
		String(info.thumbprint || '').toUpperCase() !== CONFIG.expectedThumbprint.toUpperCase()) {
		problem('Installer signing certificate does not match the pinned thumbprint.');
		return;
	}

	log('Authenticode OK:', subject);
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
			fs.rmSync(path.join(dir, name), { force: true });
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

		// Only the Windows flow is implemented: the asset pattern matches the
		// NSIS installer and the signature check is Authenticode. On macOS this
		// used to fail on every 6-hourly check with "no asset matching
		// /setup.*.exe/", so point the user at the download page instead of
		// raising an error about a file that was never meant for them.
		if (process.platform !== 'win32') {
			setState({ status: 'available', version: latest });
			const { response } = await dialog.showMessageBox({
				type: 'info',
				title: 'Update available',
				message: 'Empanadas.io ' + latest + ' is available.',
				detail: 'You have ' + current + '. In-app updates are Windows-only ' +
					'for now - open the download page to get the new version.',
				buttons: ['Open download page', 'Not now'],
				defaultId: 0,
				cancelId: 1
			});
			if (response === 0) shell.openExternal('https://empanadas.io/download');
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

		await verifySignature(finalPath);

		// --- install -------------------------------------------------
		setState({ status: 'ready', version: latest, progress: 1 });

		const { response } = await dialog.showMessageBox({
			type: 'info',
			title: 'Update ready',
			message: 'Empanadas.io ' + latest + ' is verified and ready to install.',
			detail: 'The app will close while the installer runs.',
			buttons: ['Install now', 'Later'],
			defaultId: 0,
			cancelId: 1
		});

		if (response === 0) {
			setState({ status: 'installing', version: latest });
			await runInstaller(finalPath);
		}

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
	download
};
