'use strict';

export const JMDICT_SCHEMA_VERSION = 3;
export const DEFAULT_JMDICT_BASE_URL = 'data/jmdict';
export const DEFAULT_JMDICT_MANIFEST_URL = `${DEFAULT_JMDICT_BASE_URL}/manifest.json`;

function isPlainObject(value) {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assert(condition, message) {
	if (!condition) throw new Error(`Invalid JMdict data: ${message}`);
}

function kanaScriptVariant(value, direction) {
	return Array.from(value).map((character) => {
		const code = character.codePointAt(0);
		if (direction === 'hiragana' && code >= 0x30a1 && code <= 0x30f6) {
			return String.fromCodePoint(code - 0x60);
		}
		if (direction === 'katakana' && code >= 0x3041 && code <= 0x3096) {
			return String.fromCodePoint(code + 0x60);
		}
		return character;
	}).join('');
}

function isKanaOnlyLookup(value) {
	return Array.from(value).every((character) => {
		const code = character.codePointAt(0);
		return (code >= 0x3040 && code <= 0x30ff) ||
			(code >= 0x31f0 && code <= 0x31ff) ||
			character === '・' || character === ' ';
	});
}

export function jmdictLookupVariants(text) {
	const query = String(text || '').trim().normalize('NFKC');
	if (!query) return [];
	const variants = [query];
	if (isKanaOnlyLookup(query)) {
		variants.push(
			kanaScriptVariant(query, 'hiragana'),
			kanaScriptVariant(query, 'katakana')
		);
	}
	return [...new Set(variants.filter(Boolean))];
}

export function jmdictLookupShardIndex(text, shardCount) {
	assert(Number.isInteger(shardCount) && shardCount > 0, 'shardCount must be a positive integer');
	let hash = 0x811c9dc5;
	for (const character of Array.from(String(text || ''))) {
		hash ^= character.codePointAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % shardCount;
}

export function jmdictEntryShardIndex(id, shardCount) {
	assert(Number.isInteger(shardCount) && shardCount > 0, 'shardCount must be a positive integer');
	const match = /^([1-9]\d*):[^:]+:[^:]+$/.exec(String(id || ''));
	assert(match, `entry id ${id} is invalid`);
	return Number(match[1]) % shardCount;
}

export function validateJmDictEntry(record, expectedId = null) {
	assert(isPlainObject(record), 'entry must be an object');
	assert(typeof record.id === 'string' && record.id.length > 0, 'entry id is missing');
	if (expectedId !== null) {
		assert(record.id === expectedId, `expected entry ${expectedId}, got ${record.id}`);
	}
	assert(Number.isInteger(record.sequence) && record.sequence > 0, `entry ${record.id} sequence is invalid`);
	assert(typeof record.written === 'string' && record.written.length > 0, `entry ${record.id} written form is missing`);
	assert(typeof record.reading === 'string' && record.reading.length > 0, `entry ${record.id} reading is missing`);
	assert(
		Array.isArray(record.definitions) &&
		record.definitions.length > 0 &&
		record.definitions.every((value) => typeof value === 'string' && value.length > 0),
		`entry ${record.id} definitions are invalid`
	);
	if (record.priority !== undefined) {
		assert(
			Array.isArray(record.priority) &&
			record.priority.every((value) => typeof value === 'string' && value.length > 0),
			`entry ${record.id} priority is invalid`
		);
	}
	return record;
}

export function validateJmDictManifest(manifest) {
	assert(isPlainObject(manifest), 'manifest must be an object');
	assert(manifest.schemaVersion === JMDICT_SCHEMA_VERSION, `unsupported schemaVersion ${manifest.schemaVersion}`);
	assert(isPlainObject(manifest.source) && manifest.source.name === 'JMdict', 'source must be JMdict');
	assert(Number.isInteger(manifest.shardCount) && manifest.shardCount > 0, 'shardCount is invalid');
	for (const key of ['entryShards', 'lookupShards']) {
		assert(Array.isArray(manifest[key]), `${key} must be an array`);
		assert(manifest[key].length === manifest.shardCount, `${key} count does not match shardCount`);
		assert(
			manifest[key].every((value) => typeof value === 'string' && value.length > 0),
			`${key} contains an invalid filename`
		);
	}
	if (manifest.idAliases !== undefined) {
		assert(isPlainObject(manifest.idAliases), 'idAliases must be an object');
		for (const [oldId, newId] of Object.entries(manifest.idAliases)) {
			assert(typeof oldId === 'string' && oldId.length > 0, 'idAliases contains an invalid source id');
			assert(typeof newId === 'string' && newId.length > 0, 'idAliases contains an invalid target id');
		}
	}
	return manifest;
}

export function validateJmDictEntryShard(shard, expectedIndex, shardCount) {
	assert(isPlainObject(shard), 'entry shard must be an object');
	assert(shard.schemaVersion === JMDICT_SCHEMA_VERSION, 'entry shard schemaVersion is invalid');
	assert(shard.kind === 'entries', 'entry shard kind must be entries');
	assert(shard.shard === expectedIndex, `expected entry shard ${expectedIndex}`);
	assert(isPlainObject(shard.entries), `entry shard ${expectedIndex} has no entries object`);
	for (const [id, record] of Object.entries(shard.entries)) {
		validateJmDictEntry(record, id);
		assert(
			jmdictEntryShardIndex(id, shardCount) === expectedIndex,
			`entry ${id} is in the wrong shard`
		);
	}
	return shard;
}

export function validateJmDictLookupShard(shard, expectedIndex, shardCount) {
	assert(isPlainObject(shard), 'lookup shard must be an object');
	assert(shard.schemaVersion === JMDICT_SCHEMA_VERSION, 'lookup shard schemaVersion is invalid');
	assert(shard.kind === 'lookup', 'lookup shard kind must be lookup');
	assert(shard.shard === expectedIndex, `expected lookup shard ${expectedIndex}`);
	assert(isPlainObject(shard.lookup), `lookup shard ${expectedIndex} has no lookup object`);
	for (const [text, ids] of Object.entries(shard.lookup)) {
		assert(text.length > 0, 'lookup contains an empty key');
		assert(
			jmdictLookupShardIndex(text, shardCount) === expectedIndex,
			`lookup ${text} is in the wrong shard`
		);
		assert(Array.isArray(ids), `lookup ${text} must be an array`);
		assert(ids.every((id) => typeof id === 'string' && id.length > 0), `lookup ${text} contains an invalid id`);
	}
	return shard;
}

function joinDataUrl(baseUrl, filename) {
	return `${String(baseUrl).replace(/\/+$/, '')}/${filename}`;
}

export class JmDictStore {
	constructor({
		baseUrl = DEFAULT_JMDICT_BASE_URL,
		manifestUrl = null,
		fetchImpl = globalThis.fetch
	} = {}) {
		if (typeof fetchImpl !== 'function') {
			throw new Error('JmDictStore requires fetch');
		}
		this.baseUrl = String(baseUrl).replace(/\/+$/, '');
		this.manifestUrl = manifestUrl || joinDataUrl(this.baseUrl, 'manifest.json');
		this.fetchImpl = fetchImpl;
		this.manifest = null;
		this.manifestPromise = null;
		this.entryShards = new Map();
		this.lookupShards = new Map();
		this.entryShardPromises = new Map();
		this.lookupShardPromises = new Map();
	}

	async fetchJson(url) {
		const response = await Reflect.apply(this.fetchImpl, globalThis, [url]);
		if (!response.ok) {
			throw new Error(`Could not load JMdict data (${response.status}) from ${url}`);
		}
		return response.json();
	}

	async loadManifest() {
		if (this.manifest) return this.manifest;
		if (this.manifestPromise) return this.manifestPromise;
		this.manifestPromise = this.fetchJson(this.manifestUrl)
			.then((manifest) => {
				this.manifest = validateJmDictManifest(manifest);
				return this.manifest;
			})
			.finally(() => {
				this.manifestPromise = null;
			});
		return this.manifestPromise;
	}

	async loadEntryShard(index) {
		if (this.entryShards.has(index)) return this.entryShards.get(index);
		if (this.entryShardPromises.has(index)) return this.entryShardPromises.get(index);
		const promise = (async () => {
			const manifest = await this.loadManifest();
			const filename = manifest.entryShards[index];
			assert(filename, `entry shard ${index} is missing from manifest`);
			const shard = validateJmDictEntryShard(
				await this.fetchJson(joinDataUrl(this.baseUrl, filename)),
				index,
				manifest.shardCount
			);
			this.entryShards.set(index, shard.entries);
			return shard.entries;
		})().finally(() => {
			this.entryShardPromises.delete(index);
		});
		this.entryShardPromises.set(index, promise);
		return promise;
	}

	async loadLookupShard(index) {
		if (this.lookupShards.has(index)) return this.lookupShards.get(index);
		if (this.lookupShardPromises.has(index)) return this.lookupShardPromises.get(index);
		const promise = (async () => {
			const manifest = await this.loadManifest();
			const filename = manifest.lookupShards[index];
			assert(filename, `lookup shard ${index} is missing from manifest`);
			const shard = validateJmDictLookupShard(
				await this.fetchJson(joinDataUrl(this.baseUrl, filename)),
				index,
				manifest.shardCount
			);
			this.lookupShards.set(index, shard.lookup);
			return shard.lookup;
		})().finally(() => {
			this.lookupShardPromises.delete(index);
		});
		this.lookupShardPromises.set(index, promise);
		return promise;
	}

	async getIdAliases() {
		const manifest = await this.loadManifest();
		return { ...(manifest.idAliases || {}) };
	}

	async get(id) {
		const manifest = await this.loadManifest();
		const shardIndex = jmdictEntryShardIndex(id, manifest.shardCount);
		const entries = await this.loadEntryShard(shardIndex);
		return entries[id] || null;
	}

	async lookup(text) {
		const variants = jmdictLookupVariants(text);
		if (!variants.length) return [];
		const manifest = await this.loadManifest();
		const lookupIndexes = [...new Set(
			variants.map((query) => jmdictLookupShardIndex(query, manifest.shardCount))
		)];
		await Promise.all(lookupIndexes.map((index) => this.loadLookupShard(index)));

		const ids = [...new Set(variants.flatMap((query) => {
			const index = jmdictLookupShardIndex(query, manifest.shardCount);
			return this.lookupShards.get(index)?.[query] || [];
		}))];
		if (!ids.length) return [];

		const entryIndexes = [...new Set(
			ids.map((id) => jmdictEntryShardIndex(id, manifest.shardCount))
		)];
		await Promise.all(entryIndexes.map((index) => this.loadEntryShard(index)));
		return ids
			.map((id) => {
				const index = jmdictEntryShardIndex(id, manifest.shardCount);
				return this.entryShards.get(index)?.[id] || null;
			})
			.filter(Boolean);
	}
}
