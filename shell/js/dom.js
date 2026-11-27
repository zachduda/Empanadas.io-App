// Small helpers for building the screens. Everything the site sends is put
// on the page as text (textContent), never as markup: the one exception,
// announcements, goes through sanitize.js.

export function h(tag, attrs, ...children) {
	const el = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) continue;
			if (key === 'class') el.className = value;
			else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
			else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
			else if (key === 'dataset') Object.assign(el.dataset, value);
			else if (value === true) el.setAttribute(key, '');
			else el.setAttribute(key, String(value));
		}
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const child of children) {
		if (child === undefined || child === null || child === false) continue;
		if (Array.isArray(child)) append(el, child);
		else if (child instanceof Node) el.appendChild(child);
		else el.appendChild(document.createTextNode(String(child)));
	}
}

export function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
	return el;
}

export function replace(el, ...children) {
	clear(el);
	append(el, children);
	return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Line icons, drawn on a 24-unit grid.
const ICONS = {
	home: 'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
	games: 'M6 9h4M8 7v4M15 10h.01M18 12h.01M7.5 5h9A4.5 4.5 0 0 1 21 9.5v3.2a3.3 3.3 0 0 1-5.8 2.1L14 13.5h-4l-1.2 1.3A3.3 3.3 0 0 1 3 12.7V9.5A4.5 4.5 0 0 1 7.5 5z',
	trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3',
	users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
	user: 'M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
	settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
	bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
	refresh: 'M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5',
	back: 'M15 18l-6-6 6-6',
	forward: 'M9 18l6-6-6-6',
	search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
	play: 'M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z',
	close: 'M18 6 6 18M6 6l12 12',
	check: 'M20 6 9 17l-5-5',
	plus: 'M12 5v14M5 12h14',
	userPlus: 'M15 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M16 11h6',
	userMinus: 'M15 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 11h6',
	external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
	download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
	offline: 'M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.5M19 12.9a10 10 0 0 0-2.3-1.6M1.5 9a15 15 0 0 1 4.4-2.9M22.5 9A15 15 0 0 0 12 4.9c-.9 0-1.8.1-2.6.2M12 20h.01',
	cloud: 'M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 6.5 19h11zM9 14l2 2 4-4',
	trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
	logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
	shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
	mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6',
	sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
	star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z',
	flame: 'M12 22c4 0 7-2.8 7-7 0-3.7-2.5-6.2-4-8-.5 2.4-1.7 3.6-3 4 .3-3.4-1.5-6.4-4-9 0 4.2-3 6.4-3 11 0 5.2 3 9 7 9z',
	chevron: 'M9 18l6-6-6-6',
	more: 'M5 12h.01M12 12h.01M19 12h.01',
	sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
	info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
	alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
	message: 'M21 12a8 8 0 0 1-11.8 7L3 21l2-6.2A8 8 0 1 1 21 12z',
	send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
	fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
	exitFullscreen: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
	lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
	unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.75-1.4',
	reply: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5',
	smile: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
	pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
	clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
	history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
	spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
	pepper: 'M14 4c1.5 0 2 1 2 2M16 6c3 1 4 4 3 7-1.5 4.5-6 8-11 8-1.5 0-3-.5-3-1.5S6 18 8 16c2.2-2.2 2.5-5 3.5-7S14 6 16 6z',
	link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'
};

export function icon(name, extraClass) {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', 'icon' + (extraClass ? ' ' + extraClass : ''));
	svg.setAttribute('aria-hidden', 'true');
	const p = document.createElementNS(SVG_NS, 'path');
	p.setAttribute('d', ICONS[name] || ICONS.info);
	svg.appendChild(p);
	return svg;
}

export function svg(tag, attrs, ...children) {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs || {})) {
		if (value !== undefined && value !== null) el.setAttribute(key, String(value));
	}
	for (const child of children.flat()) {
		if (child instanceof Node) el.appendChild(child);
		else if (child !== undefined && child !== null) el.appendChild(document.createTextNode(String(child)));
	}
	return el;
}

// A picture of the site's, through the app's picture cache (main.js).
export function picture(url) {
	if (!url || typeof url !== 'string') return 'images/logo.png';
	return '__img?u=' + encodeURIComponent(url);
}

export function avatar(url, size, presence) {
	const img = h('img', { class: 'avatar' + (size ? ' ' + size : ''), src: picture(url), alt: '', loading: 'lazy', draggable: 'false' });
	img.addEventListener('error', () => { img.src = 'images/logo.png'; }, { once: true });
	if (!presence) return img;
	return h('span', { class: 'avatar-wrap' }, img, h('span', { class: 'presence ' + presence, title: presence }));
}

export function button(label, onClick, opts = {}) {
	const b = h('button', {
		type: 'button',
		class: 'btn' + (opts.kind ? ' ' + opts.kind : ''),
		title: opts.title,
		disabled: opts.disabled,
		'aria-label': opts.ariaLabel
	}, opts.icon ? icon(opts.icon) : null, label);
	if (onClick) b.addEventListener('click', onClick);
	return b;
}

export function iconButton(name, label, onClick, opts = {}) {
	const b = h('button', { type: 'button', class: 'icon-btn' + (opts.class ? ' ' + opts.class : ''), title: label, 'aria-label': label, disabled: opts.disabled }, icon(name));
	if (onClick) b.addEventListener('click', onClick);
	return b;
}

// Runs an async action from a button: disabled while it runs.
export async function busy(btn, fn) {
	if (btn) btn.disabled = true;
	try {
		return await fn();
	} finally {
		if (btn) btn.disabled = false;
	}
}
