export const $ = (selector, root = document) => root.querySelector(selector);

export const $$ = (selector, root = document) =>
	Array.from(root.querySelectorAll(selector));

export function setText(selector, text, root = document) {
	const node = $(selector, root);
	if (node) node.textContent = text;
}

export function escapeHtml(value) {
	return String(value).replace(
		/[&<>"]/g,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
	);
}

export function metaRow(label, value) {
	return `<div class="meta-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`;
}

export function cssEscape(value) {
	if (window.CSS?.escape) return window.CSS.escape(value);
	return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) =>
		`\\${ch.codePointAt(0).toString(16)} `
	);
}

export const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

export const sample = (items) => items[Math.floor(Math.random() * items.length)];
