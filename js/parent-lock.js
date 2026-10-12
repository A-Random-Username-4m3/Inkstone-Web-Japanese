const LOCK_VERSION = 1;
const PBKDF2_ITERATIONS = 150000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const HEX_RE = /^[0-9a-f]+$/i;
const PIN_RE = /^\d{4,8}$/;

function bytesToHex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function cryptoApi() {
	const crypto = globalThis.crypto;
	if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') {
		throw new Error('Secure PIN storage is not available in this browser.');
	}
	return crypto;
}

async function derivePinHash(pin, saltHex, iterations) {
	const crypto = cryptoApi();
	const material = new TextEncoder().encode(`Inkstone parent lock:${pin}`);
	const key = await crypto.subtle.importKey(
		'raw',
		material,
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			salt: hexToBytes(saltHex),
			iterations
		},
		key,
		HASH_BITS
	);
	return bytesToHex(new Uint8Array(bits));
}

function equalHex(left, right) {
	if (typeof left !== 'string' || typeof right !== 'string') return false;
	if (left.length !== right.length) return false;
	let mismatch = 0;
	for (let index = 0; index < left.length; index += 1) {
		mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return mismatch === 0;
}

export function isValidParentLockRecord(value) {
	return !!(
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Number(value.version) === LOCK_VERSION &&
		Number.isInteger(Number(value.iterations)) &&
		Number(value.iterations) >= 10000 &&
		Number(value.iterations) <= 1000000 &&
		typeof value.salt === 'string' &&
		value.salt.length === SALT_BYTES * 2 &&
		HEX_RE.test(value.salt) &&
		typeof value.hash === 'string' &&
		value.hash.length === HASH_BITS / 4 &&
		HEX_RE.test(value.hash)
	);
}

export function isValidParentLockPin(pin) {
	return PIN_RE.test(String(pin || ''));
}

export async function createParentLock(pin) {
	const normalizedPin = String(pin || '');
	if (!isValidParentLockPin(normalizedPin)) {
		throw new Error('PIN must contain 4 to 8 digits.');
	}
	const crypto = cryptoApi();
	const salt = new Uint8Array(SALT_BYTES);
	crypto.getRandomValues(salt);
	const saltHex = bytesToHex(salt);
	const hash = await derivePinHash(
		normalizedPin,
		saltHex,
		PBKDF2_ITERATIONS
	);
	return {
		version: LOCK_VERSION,
		iterations: PBKDF2_ITERATIONS,
		salt: saltHex,
		hash
	};
}

export async function verifyParentLock(pin, record) {
	if (!isValidParentLockRecord(record) || !isValidParentLockPin(pin)) {
		return false;
	}
	const candidate = await derivePinHash(
		String(pin),
		record.salt,
		Number(record.iterations)
	);
	return equalHex(candidate, record.hash);
}
