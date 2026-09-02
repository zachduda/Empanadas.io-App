'use strict';

// Turns an exported OpenPGP public key into release-keys.json, which is what
// the updater pins.
//
//   gpg --export --armor <your key id> > key.asc
//   node scripts/import-release-key.js key.asc
//
// Only the public half is ever read, and only the public half is written. The
// resulting file is meant to be committed - it is what makes the app able to
// tell your releases from anyone else's, so it needs to ship inside the signed
// app bundle.

const fs = require('fs');
const path = require('path');
const pgp = require('../lib/pgp');

const OUT = path.join(__dirname, '..', 'release-keys.json');

function die(message) {
	console.error('error: ' + message);
	process.exit(1);
}

const input = process.argv[2];
if (!input) {
	die('usage: node scripts/import-release-key.js <exported-public-key.asc>\n\n' +
		'  Export one with:  gpg --export --armor <key id> > key.asc');
}
if (!fs.existsSync(input)) die(input + ' does not exist');

const raw = fs.readFileSync(input);

if (/PRIVATE KEY/.test(raw.slice(0, 200).toString('latin1'))) {
	die('that is a PRIVATE key. Export the public half instead:\n' +
		'  gpg --export --armor <key id> > key.asc');
}

let keys;
try {
	keys = pgp.parsePublicKeys(raw);
} catch (err) {
	die(err.message);
}

// Only the fingerprint and the public key go in. No user IDs, no email
// addresses: the updater matches on fingerprint and nothing else, so anything
// more would just be personal data riding along in a shipped file.
const pinned = keys.map((key) => ({
	fingerprint: key.fingerprint,
	primary: key.primary,
	pem: key.pem
}));

fs.writeFileSync(OUT, JSON.stringify(pinned, null, '\t') + '\n');

console.log('Wrote ' + path.relative(path.join(__dirname, '..'), OUT) + ' with ' +
	pinned.length + ' key' + (pinned.length === 1 ? '' : 's') + ':\n');

for (const key of pinned) {
	const f = key.fingerprint;
	// Grouped the way gpg prints it, so it can be compared by eye against
	// `gpg --fingerprint` without counting characters.
	const grouped = (f.match(/.{4}/g) || []).join(' ');
	console.log('  ' + (key.primary ? 'primary' : 'subkey ') + '  ' + grouped);
}

console.log('\nCheck those against `gpg --fingerprint` before committing.');
console.log('Once committed, the updater will refuse any release not signed by one of them.');
