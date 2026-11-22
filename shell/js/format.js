// Numbers and times, the way the site writes them.

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function num(value) {
	const n = Number(value);
	return Number.isFinite(n) ? integer.format(n) : '0';
}

// 1.2M for the tiles; the whole number in the tooltip.
export function short(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return '0';
	return Math.abs(n) < 100000 ? integer.format(n) : compact.format(n);
}

export function plural(n, one, many) {
	return num(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));
}

export function bytes(value) {
	const n = Number(value) || 0;
	if (n < 1024) return n + ' bytes';
	const units = ['KB', 'MB', 'GB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function ago(timestamp, now = Date.now()) {
	const t = Number(timestamp);
	if (!t) return 'never';
	const seconds = Math.round((t - now) / 1000);
	const abs = Math.abs(seconds);
	if (abs < 45) return 'just now';
	if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
	if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
	if (abs < 86400 * 30) return relative.format(Math.round(seconds / 86400), 'day');
	if (abs < 86400 * 365) return relative.format(Math.round(seconds / (86400 * 30)), 'month');
	return relative.format(Math.round(seconds / (86400 * 365)), 'year');
}

// "2026-10-01" as a date in the local calendar, not UTC midnight.
export function parseDay(day) {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
	return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function dayLabel(day, opts = { month: 'short', day: 'numeric' }) {
	const d = day instanceof Date ? day : parseDay(day);
	return d ? d.toLocaleDateString(undefined, opts) : '';
}

export function greeting(now = new Date()) {
	const hour = now.getHours();
	if (hour < 5) return 'Up late';
	if (hour < 12) return 'Good morning';
	if (hour < 18) return 'Good afternoon';
	return 'Good evening';
}

export const GAMES = {
	spin: { name: 'Spin', full: 'The Spin Game', blurb: 'Spin the empanada, buy upgrades, prestige and ascend.' },
	flappy: { name: 'Flappy', full: 'Flappy Empanada', blurb: 'Flap through the gaps for as long as you can.' },
	tower: { name: 'Tower', full: 'Empanada Tower', blurb: 'Stack empanadas as high as they will go.' }
};

export const GAME_ORDER = ['spin', 'flappy', 'tower'];
