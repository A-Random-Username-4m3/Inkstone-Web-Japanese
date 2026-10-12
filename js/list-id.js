'use strict';

export const RESERVED_OBJECT_KEYS = new Set([
	'__proto__',
	'prototype',
	'constructor'
]);

export function isSafeObjectKey(value) {
	const key = String(value || '');
	return Boolean(key) &&
		!RESERVED_OBJECT_KEYS.has(key) &&
		!Object.prototype.hasOwnProperty.call(Object.prototype, key);
}

export function normalizeCustomListId(value) {
	const id = String(value || '')
		.trim()
		.replace(/[^a-zA-Z0-9_.-]/g, '-');
	return isSafeObjectKey(id) ? id : '';
}
