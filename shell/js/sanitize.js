// Announcements are written as HTML in the site's admin panel. This keeps the
// part of HTML they use - paragraphs, bold and italics, links, headings,
// lists, quotes, code, pictures - and rebuilds it as fresh elements, so
// nothing else of the original (scripts, styles, handlers, frames) is ever
// put on the page. An embedded video becomes a link to it.

import { h, picture } from './dom.js';

const KEEP = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'SMALL', 'SUB', 'SUP', 'UL', 'OL', 'LI',
	'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'SPAN', 'DIV', 'MARK']);
const HEADINGS = { H1: 'h3', H2: 'h3', H3: 'h4', H4: 'h4', H5: 'h4', H6: 'h4' };
const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'LINK', 'META']);

function safeUrl(value, base = 'https://empanadas.io/') {
	try {
		const url = new URL(String(value || ''), base);
		return url.protocol === 'https:' ? url.href : null;
	} catch (err) {
		return null;
	}
}

function isSiteUrl(url) {
	try {
		const host = new URL(url).hostname;
		return host === 'empanadas.io' || host.endsWith('.empanadas.io');
	} catch (err) {
		return false;
	}
}

function convert(node) {
	if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue);
	if (node.nodeType !== Node.ELEMENT_NODE) return null;
	const tag = node.tagName;
	if (DROP.has(tag)) return null;
	const kids = () => Array.from(node.childNodes).map(convert).filter(Boolean);

	if (tag === 'A') {
		const href = safeUrl(node.getAttribute('href'));
		if (!href) return h('span', null, kids());
		// Opened by the app: its own screen for a page it has one for,
		// the browser for anything else (guardShell() in main.js).
		return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, kids());
	}
	if (tag === 'IMG') {
		const src = safeUrl(node.getAttribute('src'));
		const alt = node.getAttribute('alt') || '';
		if (src && isSiteUrl(src)) return h('img', { src: picture(src), alt, loading: 'lazy' });
		return src ? h('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, alt || 'View picture') : null;
	}
	if (tag === 'IFRAME' || tag === 'VIDEO') {
		const src = safeUrl(node.getAttribute('src'));
		return src ? h('p', null, h('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, '▶ Watch the video')) : null;
	}
	if (HEADINGS[tag]) return h(HEADINGS[tag], null, kids());
	if (KEEP.has(tag)) return h(tag.toLowerCase(), null, kids());
	// Anything else: its text and allowed children, without the element.
	const frag = document.createDocumentFragment();
	for (const kid of kids()) frag.appendChild(kid);
	return frag;
}

export function sanitize(html) {
	const doc = new DOMParser().parseFromString('<body>' + String(html || '') + '</body>', 'text/html');
	const out = h('div', { class: 'post-body selectable' });
	for (const node of Array.from(doc.body.childNodes)) {
		const converted = convert(node);
		if (converted) out.appendChild(converted);
	}
	return out;
}
