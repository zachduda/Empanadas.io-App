'use strict';

// What `npm test` runs: a syntax check of everything Electron loads (which
// nothing else in CI would ever parse), the hardening settings that silently
// make the app less safe when they regress, the packaging config, and the
// test suites of the parts that need no running Electron. The whole app, run
// against a fake site, is `npm run e2e` (test/e2e/run.js).

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

const sources = ['main.js', 'updater.js', 'lib/pgp.js', 'lib/urls.js', 'lib/background.js',
	'lib/api.js', 'lib/answers.js', 'lib/signin.js', 'lib/jsonfile.js', 'lib/gamebundle.js', 'lib/gameprotocol.js',
	'lib/cookiebridge.js', 'lib/imagecache.js', 'lib/routes.js', 'lib/windowstate.js', 'lib/resources.js',
	'lib/serverstatus.js',
	'Content/JS/shell-preload.js', 'Content/JS/game-preload.js', 'Content/JS/auth-preload.js',
	'Content/Loading/loading.js',
	'scripts/validate.js', 'scripts/import-release-key.js', 'scripts/thumbprint.js', 'scripts/publish-resources.js'];

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
const htmlSrc = fs.readFileSync(path.join(root, 'shell', 'index.html'), 'utf8');

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

check('WebGL is switched off', () => {
	for (const name of ['disable-webgl', 'disable-webgl2']) {
		assert(mainSrc.includes("appendSwitch('" + name + "')"), 'main.js no longer appends ' + name);
	}
});

// `npm start` once ran with the GPU process unsandboxed and inside the browser
// process, so development was less safe than the installed app and drew
// differently from it.
check('nothing turns the sandbox off', () => {
	const pkgScripts = JSON.stringify(require(path.join(root, 'package.json')).scripts);
	for (const flag of ['no-sandbox', 'disable-gpu-sandbox', 'in-process-gpu', 'single-process']) {
		assert(!mainSrc.includes("'" + flag + "'"), 'main.js appends ' + flag);
		assert(!pkgScripts.includes('--' + flag), 'a package.json script passes --' + flag);
	}
});

const urlsSrc = fs.readFileSync(path.join(root, 'lib', 'urls.js'), 'utf8');

check('the app host is matched by parsed hostname', () => {
	assert(/function isAppUrl/.test(urlsSrc), 'lib/urls.js no longer defines isAppUrl');
	assert(/new URL\(url\)/.test(urlsSrc), 'lib/urls.js no longer parses the URL');
});

// The sign-in popup is the one window the site is allowed to raise, so the
// terms it is allowed on are worth pinning down.
check('the sign-in popup is the only window the page can open', () => {
	assert(/const fromSite = isAppUrl\(contents\.getURL\(\)\) && !authContents\.has\(contents\)/.test(mainSrc),
		'main.js no longer restricts window.open to popups raised by the site');
	assert(/fromSite && isSignInPopupRequest\(url, disposition\)/.test(mainSrc),
		'main.js no longer gates the popup on isSignInPopupRequest()');
	assert(/isAuthUrl\(url\) \|\| \(isAppUrl\(url\) && disposition === 'new-window'\)/.test(mainSrc),
		'a sign-in popup is no longer limited to a provider or a sized window.open() of the site');
	assert(/action:\s*'deny'/.test(mainSrc), 'main.js no longer denies other windows');
});

check('the sign-in popup cannot leave the sign-in hosts', () => {
	assert(/if \(!isPopupUrl\(url\)\)/.test(mainSrc),
		'the popup navigation guard no longer checks isPopupUrl()');
});

check('the sign-in popup does not inherit the preload', () => {
	assert(/preload:\s*AUTH_PRELOAD/.test(mainSrc),
		'the auth window does not name its own preload, so it inherits the app bridge');
	const authPreload = fs.readFileSync(
		path.join(root, 'Content', 'JS', 'auth-preload.js'), 'utf8');
	assert(!/contextBridge|ipcRenderer/.test(authPreload),
		'Content/JS/auth-preload.js must expose nothing');
});

// The games are served from disk by answering every https request of their
// session (lib/gameprotocol.js). That must only ever be the games' own
// session: in the default one it would also answer for the API, the app's
// screens and the site's account pages.
check('only the games\' session answers https requests itself', () => {
	assert(/play\.protocol\.handle\('https'/.test(mainSrc), 'the games\' session no longer serves them from disk');
	const handlers = mainSrc.match(/\.protocol\.handle\('https'/g) || [];
	assert(handlers.length === 1, 'https is handled in ' + handlers.length + ' places');
	assert(/const PLAY_PARTITION = 'persist:play'/.test(mainSrc), 'the games no longer have a session of their own');
	assert(/bypassCustomProtocolHandlers: true/.test(mainSrc), 'what the games send on to the site would come back to the handler');
});

// The screens' files can come from the site (lib/resources.js). What must
// never: the code that can talk to the main process, and the page's policy.
check('screens from the site cannot replace the preloads, the loading screen or the policy', () => {
	assert(/const SHELL_PRELOAD = path\.join\(__dirname, 'Content\/JS\/shell-preload\.js'\)/.test(mainSrc),
		'the screens\' preload is no longer the bundled file');
	assert(/headers\['content-security-policy'\] = SHELL_CSP/.test(mainSrc),
		'the screens\' content security policy is no longer set by main.js');
	assert(/function loadingFile\(pathname\) \{[^}]*bundledFile\(decoded, LOADING_ROOT\)/.test(mainSrc),
		'the loading screen can be served from somewhere other than the app');
	const resourcesSrc = fs.readFileSync(path.join(root, 'lib', 'resources.js'), 'utf8');
	assert(/const SITE = 'https:\/\/empanadas\.io'/.test(resourcesSrc), 'the screens can come from another host');
	assert(/sha256\(body\) !== entry\.sha256/.test(resourcesSrc), 'a fetched file is no longer checked against its hash');
	assert(!/['"]js['"],\s*['"]node['"]|\.node['"]/.test(resourcesSrc), 'native modules in the list of types');
});

check('the loading screen is packaged and has no inline script', () => {
	const html = fs.readFileSync(path.join(root, 'Content', 'Loading', 'index.html'), 'utf8');
	assert(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), 'inline script (the policy refuses it)');
	for (const file of ['index.html', 'loading.css', 'loading.js']) {
		assert(fs.existsSync(path.join(root, 'Content', 'Loading', file)), 'Content/Loading/' + file + ' is missing');
	}
});

check('the games only keep static files, never the saves', () => {
	const bundleSrc = fs.readFileSync(path.join(root, 'lib', 'gamebundle.js'), 'utf8');
	assert(/function isEligible\(/.test(bundleSrc), 'lib/gamebundle.js no longer decides what is kept');
	assert(/p\.startsWith\('\/Content\/'\)/.test(bundleSrc), 'kept files are no longer limited to /Content/');
});

// The app's own screens get the site's answers, never a cookie or a token.
check('csrf tokens stay in the main process', () => {
	assert(/function forShell\(body\)[\s\S]{0,200}delete out\.csrf/.test(mainSrc), 'forShell() no longer drops the csrf token');
	const answersSrc = fs.readFileSync(path.join(root, 'lib', 'answers.js'), 'utf8');
	assert(/csrf: ''/.test(answersSrc), 'lib/answers.js writes csrf tokens to disk');
});

check('every IPC call checks who is asking', () => {
	assert(/if \(!trusted\(event\)\)/.test(mainSrc), 'handle() no longer checks the sender');
	assert(/event\.sender === win\.webContents && url\.startsWith\(SHELL_ORIGIN \+ '\/'\)/.test(mainSrc),
		'isShellSender() no longer requires the app\'s own window and page');
	assert((mainSrc.match(/ipcMain\.handle\(/g) || []).length === 1, 'an IPC handler bypasses handle()');
});

check('the games\' preload offers nothing of the account', () => {
	const gamePreload = fs.readFileSync(path.join(root, 'Content', 'JS', 'game-preload.js'), 'utf8');
	for (const channel of ["'data:", "'session:", "'site:", "'external:", "'cache:"]) {
		assert(!gamePreload.includes(channel), 'Content/JS/game-preload.js exposes ' + channel);
	}
});

check('signing in to the app happens in the browser, with PKCE', () => {
	const signinSrc = fs.readFileSync(path.join(root, 'lib', 'signin.js'), 'utf8');
	assert(/createHash\('sha256'\)/.test(signinSrc), 'lib/signin.js no longer makes an S256 challenge');
	assert(/api\.redeemSignIn\(code, request\.verifier\)/.test(mainSrc), 'a sign-in code is redeemed without the verifier');
	assert(/shell\.openExternal\(request\.url\)/.test(mainSrc), 'the sign-in no longer opens in the browser');
});

check('signing out forgets the account in both sessions', () => {
	const start = mainSrc.indexOf('async function signOut()');
	assert(start >= 0, 'signOut() is gone from main.js');
	const body = mainSrc.slice(start, mainSrc.indexOf('\n}\n', start));
	assert(/clearSiteCookies\(session\.defaultSession\.cookies\)/.test(body) && /clearSiteCookies\(play\.cookies\)/.test(body),
		'signOut() no longer clears the account\'s cookies in both sessions');
	assert(/api\.signOut\(\)/.test(body), 'signOut() no longer tells the site');
});

check('the site\'s pages get the zoom where Electron reads it', () => {
	// zoomFactor is a webPreferences option. On the window options it is
	// silently ignored.
	const start = mainSrc.indexOf('function siteWindowOptions()');
	assert(start >= 0, 'siteWindowOptions() is gone from main.js');
	const body = mainSrc.slice(start, mainSrc.indexOf('\n}\n', start));
	const prefs = body.slice(body.indexOf('webPreferences: {'), body.indexOf('\n\t\t},', body.indexOf('webPreferences: {')));
	assert(/zoomFactor:/.test(prefs), 'zoomFactor is not inside the site window\'s webPreferences');
});

// Toggle Full Screen showed twice in the macOS View menu, and setting
// NSFullScreenMenuItemEverywhere did not fix it. See buildAppMenu().
check('the macOS View menu leaves Full Screen to macOS', () => {
	assert(!/role:\s*'togglefullscreen'/.test(mainSrc),
		'main.js has a togglefullscreen item again, which shows twice on macOS');
	assert(!/setUserDefault\('NSFullScreenMenuItemEverywhere'/.test(mainSrc),
		'main.js sets NSFullScreenMenuItemEverywhere, which stops macOS adding Enter Full Screen');
	assert(/removeUserDefault\('NSFullScreenMenuItemEverywhere'\)/.test(mainSrc),
		'main.js no longer clears the NSFullScreenMenuItemEverywhere left by older builds');
});

// Settings' "Clear Cache" must not sign anyone out or lose their saves.
check('clearing the cache keeps cookies and saves', () => {
	assert(/handle\('cache:clear'/.test(mainSrc), "main.js no longer answers 'cache:clear'");
	const start = mainSrc.indexOf('async function clearAppCache()');
	assert(start >= 0, 'clearAppCache() is gone from main.js');
	const body = mainSrc.slice(start, mainSrc.indexOf('\n}\n', start));
	for (const kept of ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']) {
		assert(!body.includes("'" + kept + "'"), 'clearAppCache() now clears ' + kept);
	}
	assert(/clearStorageData\(\{ storages: \[/.test(body),
		'clearAppCache() calls clearStorageData() without naming storages, which clears everything');
});

check('the app\'s screens set a strict Content-Security-Policy', () => {
	assert(/http-equiv=["']Content-Security-Policy["']/i.test(htmlSrc), 'shell/index.html has no CSP meta tag');
	assert(/default-src\s+'none'/.test(htmlSrc), "the CSP does not start from default-src 'none'");
	assert(/script-src 'self'/.test(htmlSrc) && !/unsafe-inline|unsafe-eval/.test(htmlSrc), 'the CSP allows inline or eval\'d script');
	assert(/\['content-security-policy'\] = SHELL_CSP/.test(mainSrc), 'main.js no longer sends the CSP header with the app\'s page');
});

check('the app\'s screens put the site\'s words on the page as text', () => {
	const files = fs.readdirSync(path.join(root, 'shell', 'js', 'screens')).map((f) => path.join('shell', 'js', 'screens', f))
		.concat(['shell/js/main.js', 'shell/js/dom.js', 'shell/js/components.js', 'shell/js/chart.js', 'shell/js/friendship.js',
		'shell/js/statussheet.js']);
	for (const file of files) {
		const src = fs.readFileSync(path.join(root, file), 'utf8');
		assert(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/.test(src), file + ' writes markup');
	}
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
	// The install step is offerInstall(), and nothing else: a fresh download
	// reaches it after the signature check, and one kept from earlier after
	// being checked again (readyUpdateStillGood).
	const order = updaterSrc.indexOf('await verifyReleaseSignature');
	const install = updaterSrc.lastIndexOf('await offerInstall(ready)');
	assert(order > 0 && install > order,
		'the signature check does not run before the install step');
	assert(updaterSrc.split('await offerInstall(').length === 3,
		'offerInstall() is called from somewhere this check does not know');
	const kept = updaterSrc.indexOf('await readyUpdateStillGood(ready)');
	assert(kept > 0 && updaterSrc.indexOf('await offerInstall(ready)') > kept,
		'a kept download is offered without being checked again');
	const body = updaterSrc.slice(updaterSrc.indexOf('async function offerInstall('));
	const installing = updaterSrc.split("status: 'installing'").length - 1;
	assert(installing === 1 && body.indexOf("status: 'installing'") > 0,
		'something other than offerInstall() starts an install');
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
		'build.nsis.deleteAppDataOnUninstall must be set explicitly, see SECURITY.md');
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
	for (const needed of ['lib', 'release-keys.json', 'Content', 'shell']) {
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

// --- window placement -------------------------------------------------
console.log('window placement');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'windowstate.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/windowstate.js test suite failed');
}

// --- the native screens' requests and the sign-in ---------------------
console.log('api and sign-in');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'api.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/api.js, lib/signin.js and lib/answers.js test suite failed');
}

// --- the games kept on this computer -------------------------------------
console.log('games kept on this computer');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'games.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/gamebundle.js, lib/gameprotocol.js and lib/cookiebridge.js test suite failed');
}

// --- the screens over the air ----------------------------------------------
console.log('screens over the air');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'resources.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/resources.js test suite failed');
}

// --- server status ----------------------------------------------------------
console.log('server status');

check('the status page is kept apart from the app', () => {
	const start = mainSrc.indexOf('function openStatusPage()');
	assert(start > 0, 'main.js no longer has openStatusPage()');
	const body = mainSrc.slice(start, mainSrc.indexOf('\nfunction ', start + 1));
	assert(/partition: STATUS_PARTITION/.test(body), 'the status page shares a session');
	assert(!/preload:/.test(body), 'the status page has a preload');
	assert(/sandbox: true/.test(body) && /contextIsolation: true/.test(body) && /nodeIntegration: false/.test(body),
		'the status page is not sandboxed');
	assert(/const STATUS_PARTITION = '(?!persist:)[^']+'/.test(mainSrc), 'the status page\'s session is kept on disk');
	assert(/function guardStatusPage\(contents\)[\s\S]{0,4000}setWindowOpenHandler[\s\S]{0,300}action: 'deny'/.test(mainSrc),
		'the status page may open windows');
});

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'serverstatus.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/serverstatus.js test suite failed');
}

// --- links ----------------------------------------------------------------
console.log('links');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'routes.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/routes.js test suite failed');
}

// --- keep spinning when closed ----------------------------------------
console.log('background spins');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'background.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('lib/background.js test suite failed');
}

// --- iOS bridge -------------------------------------------------------
// ios/Empanadas/Resources/bridge.js runs in every page of the iOS app;
// navigator.vibrate() and the page colour it reports are tested in a VM.
console.log('ios bridge');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'iosbridge.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('ios bridge.js test suite failed');
}

// --- updater logic ----------------------------------------------------
console.log('updater logic');

try {
	execFileSync(process.execPath, [path.join(root, 'test', 'updater.test.js')], { stdio: 'inherit' });
} catch (err) {
	failures.push('updater.js test suite failed');
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
