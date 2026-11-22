'use strict';

// The loading screen's words, from how the check of the screens' files goes
// in main.js (startupCheck()): { phase, done, total, status }.
//
//   starting     the window is up, the check not yet begun
//   checking     asking the site for its list of the screens' files
//   downloading  fetching the ones that changed (done of total)
//   done         nothing (more) to fetch: status current, updated, bundled...
//   slow         the site took too long: carrying on with what is on disk
//   offline      no connection: the same
//   leaving      the screens are loading

(function () {
	const native = window.native;
	const body = document.body;
	const status = document.getElementById('status');
	const bar = document.getElementById('progress');
	const version = document.getElementById('version');

	function say(text) {
		if (status.textContent === text) return;
		status.textContent = text;
		status.classList.remove('changed');
		void status.offsetWidth; // so the animation starts again
		status.classList.add('changed');
	}

	function show(state) {
		if (!state) return;
		if (state.version) version.textContent = 'Version ' + state.version;
		switch (state.phase) {
		case 'checking':
			say('Checking for updates...');
			break;
		case 'downloading': {
			const total = Number(state.total) || 0;
			const done = Math.min(Number(state.done) || 0, total);
			if (!total) break;
			body.classList.add('counting');
			body.style.setProperty('--done', Math.round(done / total * 100) + '%');
			bar.setAttribute('aria-valuenow', String(Math.round(done / total * 100)));
			say('Fresh out of the oven... ' + done + ' of ' + total);
			break;
		}
		case 'done':
			body.classList.add('ready');
			say(state.status === 'updated' ? 'All updated!' : 'Ready!');
			break;
		case 'slow':
			body.classList.add('ready');
			say('Taking a while. Starting anyway!');
			break;
		case 'offline':
			body.classList.add('ready');
			say("You're offline. Starting anyway!");
			break;
		case 'leaving':
			body.classList.add('ready', 'leaving');
			break;
		default:
			break;
		}
	}

	if (!native || !native.loading) return;
	native.on('loading', show);
	native.loading.state().then(show, () => {});
})();
