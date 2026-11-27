'use strict';

// The message notifications still up (main.js): which conversations each is
// about and, for one message, its id and how many were unread then. Each
// inbox answer takes off those it no longer stands for: the conversation was
// read (here or on another device) or is gone, or the message was deleted.

const MAX_NOTES = 50;

function createMessageNotes({ thread }) {
	let notes = [];

	function close(entry) {
		try { entry.note.close(); } catch (err) { /* already gone */ }
		notes = notes.filter((e) => e !== entry);
	}

	return {
		get size() { return notes.length; },

		// note: the Notification; fresh: the inbox rows it is about.
		add(note, fresh) {
			if (!note || !fresh.length) return;
			notes.push({
				note,
				convos: fresh.map((c) => String(c.with.id).toLowerCase()),
				message: fresh.length === 1 ? Number(fresh[0].last.id) : 0,
				unread: fresh.length === 1 ? Number(fresh[0].unread) : 0
			});
			if (notes.length > MAX_NOTES) close(notes[0]);
		},

		// What the inbox says now. Fewer unread but not none may be this message
		// deleted: its conversation is asked (thread), and says.
		retire(list) {
			const byId = new Map((list || []).filter((c) => c && c.with).map((c) => [String(c.with.id).toLowerCase(), c]));
			const asked = [];
			for (const entry of notes.slice()) {
				const rows = entry.convos.map((id) => byId.get(id));
				if (rows.every((c) => !c || !(Number(c.unread) > 0))) {
					close(entry);
					continue;
				}
				const c = rows[0];
				if (!entry.message || !c) continue;
				if (c.last && c.last.deleted && Number(c.last.id) === entry.message) {
					close(entry);
				} else if (Number(c.unread) < entry.unread) {
					entry.unread = Number(c.unread);
					asked.push(Promise.resolve(thread(entry.convos[0], { after: entry.message - 1 })).then((answer) => {
						const m = answer && (answer.messages || []).find((x) => Number(x.id) === entry.message);
						if (m && m.deleted) close(entry);
					}, () => { /* asked again next time */ }));
				}
			}
			return Promise.all(asked);
		},

		clear() {
			for (const entry of notes.slice()) close(entry);
		}
	};
}

module.exports = { createMessageNotes, MAX_NOTES };
