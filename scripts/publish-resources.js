'use strict';

// Copies the app's screens (shell/) into a checkout of the site, where the
// app fetches them over the air (lib/resources.js):
//
//   node scripts/publish-resources.js [path/to/Empanadas-io]
//
// (default ../Empanadas-io). They go to html/Content/Desktop/v<SHELL_API>/,
// the folder for the screens' contract this version of the app speaks
// (SHELL_API in main.js), replacing what was there, with _release.json
// saying which version of the app they came from. Commit and deploy the site
// as usual; apps on this version or older (with the same SHELL_API) pick the
// screens up at their next launch.
//
// Edit the files on the site directly afterwards as much as you like: the
// site lists them by hash (v2/app/resources.php), so any change is fetched.
// Run this again after every app release, or the released app keeps using
// its own, newer, screens rather than the site's older ones. A set published
// under the same version from other screens is only used by the build those
// screens came from (its "from"), so a rebuild with changed screens never
// loses them to an older set.
//
// --with-content also copies Content/Images and Content/Fonts as images/ and
// fonts/, so the pictures and fonts can be changed from the site too.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const withContent = args.includes('--with-content');
const siteRoot = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(root, '..', 'Empanadas-io'));

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const api = Number((/const SHELL_API = (\d+);/.exec(mainSrc) || [])[1]);
if (!api) throw new Error('could not find SHELL_API in main.js');
const version = require(path.join(root, 'package.json')).version;

if (!fs.existsSync(path.join(siteRoot, 'html', 'Content'))) {
	console.error('No site checkout at ' + siteRoot + ' (expected html/Content/ in it).');
	process.exit(1);
}

const target = path.join(siteRoot, 'html', 'Content', 'Desktop', 'v' + api);
const { isSafePath, revisionOfDir } = require('../lib/resources');

function copyTree(from, to, prefix, copied) {
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		const src = path.join(from, entry.name);
		if (entry.isDirectory()) {
			copyTree(src, path.join(to, entry.name), rel, copied);
		} else if (entry.isFile()) {
			if (!isSafePath(rel)) {
				console.log('  skip  ' + rel + ' (not a file the app keeps)');
				continue;
			}
			fs.mkdirSync(to, { recursive: true });
			fs.copyFileSync(src, path.join(to, entry.name));
			copied.push(rel);
		}
	}
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const copied = [];
copyTree(path.join(root, 'shell'), target, '', copied);
if (withContent) {
	copyTree(path.join(root, 'Content', 'Images'), path.join(target, 'images'), 'images', copied);
	copyTree(path.join(root, 'Content', 'Fonts'), path.join(target, 'fonts'), 'fonts', copied);
}
// from: which screens these are, so a build of the same version with other screens keeps its own
// (lib/resources.js).
fs.writeFileSync(path.join(target, '_release.json'), JSON.stringify({
	app: version, shell: api, from: revisionOfDir(path.join(root, 'shell')), publishedAt: new Date().toISOString()
}, null, '\t') + '\n');

console.log('Published ' + copied.length + ' files of the ' + version + ' screens to ' + path.relative(process.cwd(), target));
