// Friend requests and friendships, through account_edit.php as the site's
// own buttons send them (lib/api.js does the sending).

import { button } from './dom.js';

const DONE = {
	add: 'Friend request sent.',
	accept: "You're now friends!",
	decline: 'Request declined.',
	cancel: 'Request taken back.',
	unfriend: 'Removed from your friends.'
};

export async function friendAction(app, kind, id, name) {
	if (kind === 'unfriend') {
		const sure = await app.confirm({
			title: 'Unfriend ' + (name || 'this player') + '?',
			message: 'They won’t be told, and you can send a new request later.',
			confirm: 'Unfriend',
			danger: true
		});
		if (!sure) return false;
	}
	const actions = {
		add: () => window.native.data.act('addFriend', { id }),
		accept: () => window.native.data.act('answerFriend', { id, accept: true }),
		decline: () => window.native.data.act('answerFriend', { id, accept: false }),
		cancel: () => window.native.data.act('removeFriend', { id }),
		unfriend: () => window.native.data.act('removeFriend', { id })
	};
	const result = await actions[kind]();
	if (!result || !result.ok) {
		const error = (result && result.error) || {};
		if (error.code === 'needs_captcha') {
			app.toast('The site needs a quick check first. Opening your account page…', 'error');
			window.native.site.open('account');
		} else {
			app.toast(error.message || "That didn't work. Try again.", 'error');
		}
		return false;
	}
	app.toast(DONE[kind], 'success');
	return true;
}

// The buttons for how the viewer stands with a player. after() runs once a
// change went through.
export function relationButtons(app, { id, username, relation, acceptsRequests = true }, after) {
	const run = (kind) => async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true;
		const ok = await friendAction(app, kind, id, username);
		btn.disabled = false;
		if (ok && after) after(kind);
	};
	switch (relation) {
	case 'friends':
		return [button('Friends', null, { kind: 'small', icon: 'check', disabled: true }), button('Unfriend', run('unfriend'), { kind: 'small danger' })];
	case 'incoming':
		return [button('Accept', run('accept'), { kind: 'small primary', icon: 'check' }), button('Decline', run('decline'), { kind: 'small' })];
	case 'outgoing':
		return [button('Requested', null, { kind: 'small', disabled: true }), button('Cancel', run('cancel'), { kind: 'small' })];
	case 'self':
		return [];
	default:
		return acceptsRequests
			? [button('Add Friend', run('add'), { kind: 'small primary', icon: 'userPlus' })]
			: [button('Not taking requests', null, { kind: 'small', disabled: true })];
	}
}
