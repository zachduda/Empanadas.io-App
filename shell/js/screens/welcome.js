// Signed out: the login page's own question, "Got an account?", on the
// launch screen's navy. Either answer opens the whole sign-in in the
// player's browser (lib/signin.js), where their passwords, passkeys and
// Google/GitHub/Discord already are, and the site hands it back to the app.

import { h, replace, button } from '../dom.js';

export function mount(container, { session, signin }) {
	const panel = h('div', { class: 'panel' });
	const root = h('div', { class: 'welcome' }, h('div', { class: 'glow' }), panel);
	replace(container, root);

	let error = null;
	let waiting = !!(session && session.signingIn);
	let finishing = false;

	const draw = () => {
		const top = [
			h('img', { class: 'logo', src: 'images/logo.png', alt: '' }),
			h('h1', null, 'Empanadas.io')
		];
		if (finishing) {
			replace(panel, top, h('p', { class: 'lead' }, 'Signing you in…'),
				h('div', { class: 'waiting' }, h('div', { class: 'spinner' })));
			return;
		}
		if (waiting) {
			replace(panel, top,
				h('p', { class: 'lead' }, 'Finish signing in in your browser. You’ll come straight back here.'),
				h('div', { class: 'waiting' },
					h('div', { class: 'spinner' }),
					h('div', { class: 'choices', style: { width: '100%' } },
						button('Open the Browser Again', () => start(session.mode || 'login'), { kind: 'ghost large' }),
						button('Cancel', async () => {
							await window.native.session.cancel();
							waiting = false;
							draw();
						}, { kind: 'quiet' }))));
			return;
		}
		replace(panel, top,
			h('p', { class: 'lead' }, 'Spin, flap and stack. Your progress follows you everywhere.'),
			error ? h('div', { class: 'error', role: 'alert' }, error) : null,
			h('div', { class: 'question' }, 'Got an account?'),
			h('div', { class: 'choices' },
				button('Yup! Log In', () => start('login'), { kind: 'primary large' }),
				button('Nope. Create One', () => start('create'), { kind: 'ghost large' })),
			h('p', { class: 'note' }, 'You’ll sign in on empanadas.io in your browser. ',
				h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.native.external.open('privacy'); } }, 'Privacy Policy')));
	};

	async function start(mode) {
		error = null;
		const next = await window.native.session.signIn(mode);
		session = Object.assign({}, session, next);
		waiting = true;
		draw();
	}

	if (signin && signin.state === 'failed') error = signin.error && signin.error.message;
	draw();

	return {
		onSignIn(update) {
			if (!update) return;
			if (update.state === 'finishing') {
				finishing = true;
			} else if (update.state === 'failed') {
				finishing = false;
				waiting = false;
				error = (update.error && update.error.message) || 'That didn’t work. Try again.';
			}
			draw();
		}
	};
}
