'use strict';

// lib/messagenotes.js: which message notifications main.js takes off again.

const assert = require('assert');
const { createMessageNotes, MAX_NOTES } = require('../lib/messagenotes');

const failures = [];

async function check(what, fn) {
	try {
		await fn();
		console.log('  ok    ' + what);
	} catch (err) {
		failures.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	}
}

const ANA = 'AB12CD34-0000-1111-2222-333344445555';
const BEN = 'cd34cd34-0000-1111-2222-333344445555';

function note() {
	return { closed: false, close() { this.closed = true; } };
}

const row = (id, last, unread, deleted = false) => ({ with: { id }, last: { id: last, deleted }, unread });

(async () => {
	await check('read here or on another device: it comes off', async () => {
		const notes = createMessageNotes({ thread: () => null });
		const n = note();
		notes.add(n, [row(ANA, 10, 2)]);
		await notes.retire([row(ANA.toLowerCase(), 10, 2)]);
		assert.strictEqual(n.closed, false, 'still unread');
		await notes.retire([row(ANA, 10, 0)]);
		assert.strictEqual(n.closed, true);
		assert.strictEqual(notes.size, 0);
	});

	await check('a conversation gone from the inbox takes its notification with it', async () => {
		const notes = createMessageNotes({ thread: () => null });
		const n = note();
		notes.add(n, [row(ANA, 10, 1)]);
		await notes.retire([row(BEN, 3, 1)]);
		assert.strictEqual(n.closed, true);
	});

	await check('the newest message deleted: it comes off', async () => {
		const notes = createMessageNotes({ thread: () => null });
		const n = note();
		notes.add(n, [row(ANA, 10, 2)]);
		await notes.retire([row(ANA, 10, 2, true)]);
		assert.strictEqual(n.closed, true);
	});

	await check('fewer unread: the conversation is asked whether this one was deleted', async () => {
		const asked = [];
		let deleted = false;
		const notes = createMessageNotes({ thread: (id, opts) => { asked.push([id, opts]); return { messages: [{ id: 10, deleted }, { id: 11 }] }; } });
		const n = note();
		notes.add(n, [row(ANA, 10, 3)]);
		await notes.retire([row(ANA, 11, 2)]);
		assert.deepStrictEqual(asked, [[ANA.toLowerCase(), { after: 9 }]]);
		assert.strictEqual(n.closed, false, 'another one was deleted');
		await notes.retire([row(ANA, 11, 2)]);
		assert.strictEqual(asked.length, 1, 'not asked again for the same count');
		deleted = true;
		await notes.retire([row(ANA, 11, 1)]);
		assert.strictEqual(n.closed, true, 'this one was');
	});

	await check('a notification for several friends comes off once all of them are read', async () => {
		const notes = createMessageNotes({ thread: () => null });
		const n = note();
		notes.add(n, [row(ANA, 10, 1), row(BEN, 12, 1)]);
		await notes.retire([row(ANA, 10, 0), row(BEN, 12, 1)]);
		assert.strictEqual(n.closed, false);
		await notes.retire([row(ANA, 10, 0), row(BEN, 12, 0)]);
		assert.strictEqual(n.closed, true);
	});

	await check('a conversation that can\'t be asked is asked again later, and nothing breaks', async () => {
		const notes = createMessageNotes({ thread: () => Promise.reject(new Error('offline')) });
		const n = note();
		notes.add(n, [row(ANA, 10, 3)]);
		await notes.retire([row(ANA, 11, 2)]);
		assert.strictEqual(n.closed, false);
	});

	await check('signing out takes them all off, and only so many are kept', async () => {
		const notes = createMessageNotes({ thread: () => null });
		const all = [];
		for (let i = 0; i < MAX_NOTES + 2; i++) {
			const n = note();
			all.push(n);
			notes.add(n, [row(ANA, 100 + i, 1)]);
		}
		assert.strictEqual(notes.size, MAX_NOTES);
		assert.deepStrictEqual(all.slice(0, 2).map((n) => n.closed), [true, true], 'the oldest went first');
		notes.clear();
		assert.ok(all.every((n) => n.closed));
		notes.add(null, [row(ANA, 1, 1)]);
		assert.strictEqual(notes.size, 0, 'no notification, nothing kept');
	});

	if (failures.length) {
		console.log('\n' + failures.length + ' message notification test(s) failed');
		process.exit(1);
	}
	console.log('\nAll message notification tests passed.');
})();
