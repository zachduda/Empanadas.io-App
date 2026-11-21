// Save Points: the saves the site keeps as the Spin Game saves, newest first,
// each against the account as it is now. Restoring one asks first; the site
// keeps what it replaces as a new save point, so a restore can be undone
// from the same list. Through the site's own /v2/gamehistory.php.

import { h, replace, button, icon } from '../dom.js';
import { num } from '../format.js';
import { errorState, skeleton } from '../data.js';

const FIELDS = [
	['prestige', 'Prestige'],
	['ascensions', 'Ascensions'],
	['manual_spins', 'Manual Spins'],
	['peppers', 'Peppers'],
	['flappy_best', 'Flappy Best'],
	['tower_best', 'Tower Best']
];

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner narrow' });
	const list = h('div', { class: 'list' });
	const more = h('div', { style: { padding: '12px 16px' } });
	replace(container, inner);

	let current = null;
	let before = null;

	function compare(point, key) {
		const then = point[key];
		const now = current ? current[key] : null;
		if (then === null || then === undefined) return null;
		const diff = now === null || now === undefined ? 0 : Number(then) - Number(now);
		return h('div', { class: 'stat' },
			h('div', { class: 'k' }, FIELDS.find(([k]) => k === key)[1]),
			h('div', { class: 'v' }, num(then),
				diff ? h('span', { class: 'small', style: { color: diff > 0 ? 'var(--success)' : 'var(--danger)', marginLeft: '6px', fontWeight: '600' } }, (diff > 0 ? '▲ ' : '▼ ') + num(Math.abs(diff))) : null));
	}

	function row(point) {
		const restore = button('Restore', async () => {
			const changes = FIELDS.filter(([k]) => point[k] !== null && point[k] !== undefined && current && Number(point[k]) !== Number(current[k]))
				.map(([k, label]) => label + ': ' + num(current[k]) + ' → ' + num(point[k]));
			const sure = await app.confirm({
				title: 'Restore this save point?',
				message: (point.full ? '' : 'This older save point puts back the Spin Game only. ') +
					(changes.length ? changes.join(' · ') + '. ' : '') + 'What you have now is kept as a save point too, so you can undo this.',
				confirm: 'Restore'
			});
			if (!sure) return;
			restore.disabled = true;
			const result = await window.native.data.act('restoreSavePoint', { id: point.id });
			restore.disabled = false;
			if (!result.ok) {
				app.toast(result.error.message, 'error');
				return;
			}
			app.toast('Restored. The games pick it up next time they open.', 'success');
			start();
		}, { kind: 'small', disabled: !point.restorable });
		return h('div', { class: 'list-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '10px' } },
			h('div', { class: 'row-flex', style: { width: '100%' } },
				icon('history'),
				h('div', { class: 'main' },
					h('div', { class: 'title' }, point.label || point.date),
					h('div', { class: 'subtitle' }, point.restorable ? (point.full ? 'All games' : 'Spin only') : 'From before an anti-cheat reset: can’t be restored')),
				restore),
			h('div', { class: 'stat-grid', style: { width: '100%' } }, FIELDS.map(([k]) => compare(point, k))));
	}

	async function page(first) {
		const result = await window.native.data.load('savePoints', first ? {} : { before });
		if (!result.ok) {
			if (first) replace(inner, errorState(result, start));
			else app.toast(result.error.message, 'error');
			return;
		}
		const d = result.data;
		if (first) replace(list);
		current = d.current || current;
		before = d.before;
		for (const point of d.points || []) list.appendChild(row(point));
		if (first && !(d.points || []).length) list.appendChild(h('div', { class: 'list-empty' }, 'No save points yet. They’re made as the Spin Game saves.'));
		replace(more, d.more ? button('Show Older', () => page(false), { kind: 'small' }) : null);
	}

	function start() {
		replace(list);
		replace(inner,
			h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Save Points'), h('div', { class: 'sub' }, 'Put your games back the way they were at an earlier save.'))),
			h('div', { class: 'card flush' }, list, more));
		replace(list, h('div', { style: { padding: '16px' } }, skeleton(4, 40)));
		page(true);
	}

	start();
	return { title: 'Save Points', refresh: start };
}
