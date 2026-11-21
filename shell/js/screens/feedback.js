// Send Feedback, from /v2/ios/feedback.php: the site's subjects, its length
// limits, and "I'd like a reply" with the address it goes to. Sent through
// account_edit.php as the site's form sends it.

import { h, replace, button, icon } from '../dom.js';
import { num } from '../format.js';
import { errorState, skeleton } from '../data.js';

export function mount(container, { app, params }) {
	const inner = h('div', { class: 'content-inner narrow' });
	replace(container, inner);
	replace(inner, skeleton(5, 30));

	async function start() {
		const result = await window.native.data.load('feedbackForm');
		if (!result.ok) {
			replace(inner, errorState(result, start));
			return;
		}
		draw(result.data);
	}

	function draw(form) {
		const subjects = Array.isArray(form.subjects) ? form.subjects : [];
		const wanted = Number(params && params.reason);
		let subject = subjects.find((s) => s.id === wanted) || subjects.find((s) => s.id === form.default_subject) || subjects[0];
		const min = Number(form.min_length) || 6;
		const max = Number(form.max_length) || 2000;

		const select = h('select', { class: 'field', 'aria-label': 'Subject' },
			subjects.map((s) => h('option', { value: String(s.id), selected: s === subject ? true : null }, s.label)));
		const text = h('textarea', { class: 'field', maxlength: String(max), spellcheck: 'true' });
		const counter = h('div', { class: 'muted small' });
		const reply = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'I’d like a reply' });
		const replyRow = h('label', { class: 'setting', style: { padding: '12px 0', borderTop: '0' } },
			h('div', { class: 'main' }, h('div', { class: 'title' }, 'I’d like a reply'),
				h('div', { class: 'desc' }, form.email ? 'We’ll write to ' + form.email + (form.email_verified ? '' : ' (not verified yet)') + '.' : 'We’ll write to your account’s address.')),
			h('div', { class: 'control' }, reply));
		const send = button('Send Feedback', null, { kind: 'primary', icon: 'message' });

		const sync = () => {
			text.placeholder = subject && subject.placeholder ? subject.placeholder : 'What’s on your mind?';
			replyRow.style.display = subject && subject.reply === false ? 'none' : '';
			const length = text.value.trim().length;
			const required = !subject || subject.message_required !== false;
			counter.textContent = num(length) + ' / ' + num(max) + (required && length < min ? ' · at least ' + num(min) : '');
			send.disabled = required && (length < min || length > max);
		};
		select.addEventListener('change', () => {
			subject = subjects.find((s) => String(s.id) === select.value) || subject;
			sync();
		});
		text.addEventListener('input', sync);
		send.addEventListener('click', async () => {
			send.disabled = true;
			const result = await window.native.data.act('sendFeedback', {
				subject: subject.id,
				message: text.value,
				wantsReply: subject.reply !== false && reply.checked
			});
			if (!result.ok) {
				app.toast(result.error.message, 'error');
				sync();
				return;
			}
			replace(inner, h('div', { class: 'empty-state' }, icon('check'),
				h('h2', null, 'Thanks for the feedback!'),
				h('p', null, reply.checked ? 'We’ll get back to you by email.' : 'Every message is read.'),
				h('div', { class: 'actions' }, button('Done', () => app.back(), { kind: 'primary' }))));
		});

		replace(inner,
			h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Send Feedback'), h('div', { class: 'sub' }, 'Ideas, problems, questions: it all goes straight to us.'))),
			h('div', { class: 'card stack' },
				h('div', null, h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Subject'), select),
				h('div', null, text, h('div', { class: 'row-flex', style: { marginTop: '6px' } }, counter)),
				replyRow,
				h('div', { class: 'row-flex' }, h('div', { class: 'spacer' }), send)));
		sync();
		text.focus();
	}

	start();
	return { title: 'Send Feedback' };
}
