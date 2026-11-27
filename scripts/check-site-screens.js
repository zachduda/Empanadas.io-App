'use strict';

// Whether the site's copy of the screens (Content/Desktop/v<SHELL_API>/, which
// apps of this version load over the air) is this app's shell/. A copy
// published for this same version that differs means apps on it run other
// screens than this release: publish again (scripts/publish-resources.js), or
// bump the version.
//
//   node scripts/check-site-screens.js [path/to/Empanadas-io]
//
// With a checkout of the site (the argument, EMPANADAS_SITE_DIR, or
// ../Empanadas-io) it compares the files there. Without one it asks the live
// site (/v2/app/resources.php), and only notes it when the site can't be
// reached. Exits 1 on a mismatch.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isSafePath, SITE } = require('../lib/resources');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const api = Number((/const SHELL_API = (\d+);/.exec(fs.readFileSync(path.join(root, 'main.js'), 'utf8')) || [])[1]);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function hashes(dir, prefix = '', out = {}) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) hashes(full, rel, out);
		else if (entry.isFile() && isSafePath(rel)) out[rel] = sha256(full);
	}
	return out;
}

// The files that differ between the app's screens and the site's copy.
function differences(mine, theirs) {
	const out = [];
	for (const rel of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
		if (!(rel in theirs)) out.push(rel + ' (not on the site)');
		else if (!(rel in mine)) out.push(rel + ' (only on the site)');
		else if (mine[rel] !== theirs[rel]) out.push(rel);
	}
	return out.sort();
}

function siteCheckout() {
	const given = process.argv[2] || process.env.EMPANADAS_SITE_DIR;
	const candidates = given ? [given] : [path.join(root, '..', 'Empanadas-io')];
	for (const dir of candidates) {
		const base = path.resolve(dir);
		// EMPANADAS_SITE_DIR may name the site's html/ folder (as test/e2e does) or the checkout.
		for (const html of [base, path.join(base, 'html')]) {
			if (fs.existsSync(path.join(html, 'Content', 'Desktop'))) return html;
		}
	}
	return null;
}

async function liveCopy() {
	const res = await fetch(SITE + '/v2/app/resources.php?shell=' + api, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
	const body = await res.json();
	if (!body || body.ok !== true || Number(body.shell) !== api) throw new Error('the site did not list the screens');
	const files = {};
	for (const [rel, entry] of Object.entries(body.files || {})) files[rel] = entry && entry.sha256;
	return { app: String(body.app || ''), files };
}

function verdict(where, app, theirs) {
	if (!Object.keys(theirs).length) {
		console.log('  note  nothing published for v' + api + ' on ' + where + ' yet: apps of ' + version + ' use their own screens');
		return 0;
	}
	if (app !== version) {
		console.log('  note  ' + where + ' has the ' + (app || 'unknown') + ' screens for v' + api + ', not ' + version + "'s: not compared");
		return 0;
	}
	const diff = differences(hashes(path.join(root, 'shell')), theirs);
	if (!diff.length) {
		console.log('  ok    ' + where + "'s v" + api + ' screens are this app\'s');
		return 0;
	}
	console.log('  FAIL  ' + where + "'s v" + api + ' screens, published for ' + version + ', are not this app\'s shell/:');
	for (const rel of diff) console.log('          ' + rel);
	console.log('        Publish them (node scripts/publish-resources.js) or bump the version in package.json.');
	return 1;
}

async function main() {
	const html = siteCheckout();
	if (html) {
		const dir = path.join(html, 'Content', 'Desktop', 'v' + api);
		let app = '';
		try { app = String(JSON.parse(fs.readFileSync(path.join(dir, '_release.json'), 'utf8')).app || ''); } catch (err) { /* none */ }
		return verdict('the site checkout', app, fs.existsSync(dir) ? hashes(dir) : {});
	}
	let copy;
	try {
		copy = await liveCopy();
	} catch (err) {
		console.log('  note  no site checkout, and the live site could not be asked (' + err.message + '): not compared');
		return 0;
	}
	return verdict('the live site', copy.app, copy.files);
}

main().then((code) => process.exit(code), (err) => {
	console.error(err);
	process.exit(1);
});
