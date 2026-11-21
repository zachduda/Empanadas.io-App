// The Spin Progress chart: lifetime spins over time, or spins per day, drawn
// as SVG. history is the dashboard's spin_history: [{ date, spins }], spins
// being the lifetime total on that day.

import { h, svg, replace } from './dom.js';
import { num, short, parseDay, dayLabel } from './format.js';

const RANGES = [
	{ id: '1w', label: '1W', days: 7 },
	{ id: '1m', label: '1M', days: 30 },
	{ id: '3m', label: '3M', days: 90 },
	{ id: '1y', label: '1Y', days: 365 },
	{ id: 'all', label: 'All', days: Infinity }
];

export function points(history, rangeDays, mode) {
	const all = (Array.isArray(history) ? history : [])
		.map((p) => ({ day: parseDay(p.date), total: Math.max(0, Number(p.spins) || 0) }))
		.filter((p) => p.day)
		.sort((a, b) => a.day - b.day);
	if (!all.length) return [];
	const last = all[all.length - 1].day;
	const from = Number.isFinite(rangeDays) ? new Date(last.getFullYear(), last.getMonth(), last.getDate() - rangeDays + 1) : null;
	const out = [];
	for (let i = 0; i < all.length; i++) {
		const p = all[i];
		const daily = i === 0 ? 0 : Math.max(0, p.total - all[i - 1].total);
		if (from && p.day < from) continue;
		out.push({ day: p.day, value: mode === 'daily' ? daily : p.total, total: p.total, daily });
	}
	return out;
}

function niceMax(value) {
	if (value <= 0) return 1;
	const exp = Math.pow(10, Math.floor(Math.log10(value)));
	for (const step of [1, 2, 2.5, 5, 10]) {
		if (step * exp >= value) return step * exp;
	}
	return 10 * exp;
}

export function spinChart(history) {
	let range = '1m';
	let mode = 'total';
	const readout = h('div', { class: 'chart-readout' });
	const holder = h('div', { style: { position: 'relative' } });

	const segmented = (items, current, onPick) => h('div', { class: 'segmented', role: 'group' },
		items.map((item) => {
			const b = h('button', { type: 'button', 'aria-pressed': String(item.id === current) }, item.label);
			b.addEventListener('click', () => onPick(item.id));
			return b;
		}));

	const head = h('div', { class: 'chart-head' });
	const root = h('div', null, head, holder, readout);

	function drawHead() {
		replace(head,
			segmented([{ id: 'total', label: 'Total' }, { id: 'daily', label: 'Per Day' }], mode, (id) => { mode = id; draw(); }),
			h('div', { class: 'spacer' }),
			segmented(RANGES, range, (id) => { range = id; draw(); }));
	}

	function draw() {
		drawHead();
		const days = RANGES.find((r) => r.id === range).days;
		const data = points(history, days, mode);
		const width = Math.max(320, holder.clientWidth || 640);
		const height = 220;
		const pad = { l: 46, r: 10, t: 10, b: 24 };
		if (data.length < 2) {
			replace(holder, h('div', { class: 'empty-state', style: { padding: '50px 0' } }, 'Play some Spin and your progress shows up here.'));
			readout.textContent = '';
			return;
		}
		const max = niceMax(Math.max(...data.map((p) => p.value)));
		const min = mode === 'total' ? Math.min(...data.map((p) => p.value)) : 0;
		const floor = mode === 'total' ? Math.max(0, min - (max - min) * 0.08) : 0;
		const x = (i) => pad.l + (i / (data.length - 1)) * (width - pad.l - pad.r);
		const y = (v) => pad.t + (1 - (v - floor) / Math.max(1, max - floor)) * (height - pad.t - pad.b);

		const ticks = 4;
		const grid = [];
		for (let i = 0; i <= ticks; i++) {
			const v = floor + ((max - floor) * i) / ticks;
			grid.push(svg('line', { class: 'grid-line', x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v) }));
			grid.push(svg('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, short(Math.round(v))));
		}
		const labelEvery = Math.max(1, Math.ceil(data.length / 6));
		const xLabels = data.map((p, i) => (i % labelEvery === 0 || i === data.length - 1) && !(i !== data.length - 1 && data.length - 1 - i < labelEvery / 2)
			? svg('text', { class: 'axis', x: x(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle' }, dayLabel(p.day))
			: null).filter(Boolean);

		let marks;
		if (mode === 'daily') {
			const bw = Math.max(1.5, Math.min(18, (width - pad.l - pad.r) / data.length - 2));
			marks = data.map((p, i) => svg('rect', { class: 'bar', x: x(i) - bw / 2, y: y(p.value), width: bw, height: Math.max(0, y(floor) - y(p.value)), rx: Math.min(3, bw / 2) }));
		} else {
			const line = data.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
			const area = line + ' L' + x(data.length - 1).toFixed(1) + ' ' + y(floor) + ' L' + x(0).toFixed(1) + ' ' + y(floor) + ' Z';
			marks = [svg('path', { class: 'area', d: area }), svg('path', { class: 'line', d: line })];
		}

		const cursor = svg('line', { class: 'cursor', y1: pad.t, y2: height - pad.b, visibility: 'hidden' });
		const dot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' });
		const chart = svg('svg', { class: 'chart', viewBox: '0 0 ' + width + ' ' + height, width, height, role: 'img', 'aria-label': 'Spin progress chart' },
			svg('defs', null, svg('linearGradient', { id: 'chartFill', x1: 0, x2: 0, y1: 0, y2: 1 },
				svg('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.28' }),
				svg('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' }))),
			grid, marks, xLabels, cursor, dot);

		const describe = (p) => {
			replace(readout, dayLabel(p.day, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ': ',
				h('b', null, num(mode === 'daily' ? p.daily : p.total)), mode === 'daily' ? ' spins that day' : ' lifetime spins');
		};
		const latest = () => {
			replace(readout, h('b', null, '+' + num(Math.max(0, data[data.length - 1].total - data[0].total))), ' spins in this period',
				mode === 'daily' ? ' · best day ' + num(Math.max(...data.map((p) => p.daily))) : '');
		};
		chart.addEventListener('mousemove', (e) => {
			const box = chart.getBoundingClientRect();
			const px = ((e.clientX - box.left) / box.width) * width;
			const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (data.length - 1))));
			cursor.setAttribute('x1', x(i));
			cursor.setAttribute('x2', x(i));
			cursor.setAttribute('visibility', 'visible');
			dot.setAttribute('cx', x(i));
			dot.setAttribute('cy', y(data[i].value));
			dot.setAttribute('visibility', 'visible');
			describe(data[i]);
		});
		chart.addEventListener('mouseleave', () => {
			cursor.setAttribute('visibility', 'hidden');
			dot.setAttribute('visibility', 'hidden');
			latest();
		});
		replace(holder, chart);
		latest();
	}

	let lastWidth = 0;
	const observer = new ResizeObserver(() => {
		const w = holder.clientWidth;
		if (Math.abs(w - lastWidth) > 8) {
			lastWidth = w;
			draw();
		}
	});
	observer.observe(holder);
	drawHead();

	return {
		el: root,
		update(next) {
			history = next;
			draw();
		},
		destroy() { observer.disconnect(); }
	};
}
