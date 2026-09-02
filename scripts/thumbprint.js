'use strict';

// Prints the signing identity of a built artifact, in the form the updater's
// CONFIG wants it pinned.
//
//   Windows:  node scripts/thumbprint.js dist\empanadas.io-Setup-1.10.9.exe
//   macOS:    node scripts/thumbprint.js "dist/mac-arm64/Empanadas.io.app"
//
// Run it against an artifact you just signed yourself. Reading the value off a
// downloaded build and pinning that would pin whatever signed the download,
// which is the thing a pin is supposed to catch.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = process.argv[2];

if (!target) {
	console.error('usage: node scripts/thumbprint.js <signed .exe | signed .app>');
	process.exit(1);
}
if (!fs.existsSync(target)) {
	console.error('error: ' + target + ' does not exist');
	process.exit(1);
}

function run(cmd, args) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
			if (err && !stderr) reject(err);
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

const PS = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath $env:TARGET
[pscustomobject]@{
	status     = [string]$sig.Status
	subject    = [string]$sig.SignerCertificate.Subject
	thumbprint = [string]$sig.SignerCertificate.Thumbprint
	notAfter   = [string]$sig.SignerCertificate.NotAfter
} | ConvertTo-Json -Compress
`;

async function windows() {
	const { stdout } = await run('powershell.exe',
		['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS]);
	const info = JSON.parse(stdout);

	console.log('status:      ' + info.status);
	console.log('subject:     ' + info.subject);
	console.log('expires:     ' + info.notAfter);
	console.log('thumbprint:  ' + info.thumbprint);

	if (info.status !== 'Valid') {
		console.log('\nThe signature is not valid, so there is nothing worth pinning yet.');
		return;
	}

	console.log('\nPin it in updater.js:\n');
	console.log('  pinnedThumbprints: [');
	console.log("  \t'" + info.thumbprint + "'");
	console.log('  ],');
	console.log('\nDuring a certificate rollover, keep both the old and the new entry so');
	console.log('clients still running the previous release accept either one.');
}

async function macos() {
	const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', target]);
	const info = {};
	for (const line of stderr.split('\n')) {
		const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
		if (m) info[m[1]] = m[2];
	}

	console.log('identifier:  ' + (info.Identifier || '(none)'));
	console.log('team id:     ' + (info.TeamIdentifier || '(none)'));
	console.log('authority:   ' + (info.Authority || '(none)'));

	if (!info.TeamIdentifier || info.TeamIdentifier === 'not set') {
		console.log('\nThis build is unsigned or ad-hoc signed - there is no team to pin.');
		return;
	}

	console.log('\nPin it in updater.js:\n');
	console.log("  macTeamId: '" + info.TeamIdentifier + "',");
	console.log("  macBundleId: '" + info.Identifier + "',");
}

const isApp = target.endsWith('.app') ||
	(fs.statSync(target).isDirectory() && fs.existsSync(path.join(target, 'Contents')));

const job = isApp || process.platform === 'darwin' ? macos() : windows();

job.catch((err) => {
	console.error('error: ' + (err.stderr || err.message || err).toString().trim());
	process.exit(1);
});
