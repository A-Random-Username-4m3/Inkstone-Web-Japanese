'use strict';

export const KANJIVG_SCHEMA_VERSION = 1;
export const DEFAULT_KANJIVG_DATA_URL = 'data/kanji.json';

function isPlainObject(value) {
	return Boolean(
		value &&
		typeof value === 'object' &&
		!Array.isArray(value)
	);
}

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function validPoint(point) {
	return (
		Array.isArray(point) &&
		point.length === 2 &&
		finiteNumber(point[0]) &&
		finiteNumber(point[1]) &&
		point[0] >= 0 &&
		point[0] <= 1 &&
		point[1] >= 0 &&
		point[1] <= 1
	);
}

function assert(condition, message) {
	if (!condition) throw new Error(`Invalid KanjiVG data: ${message}`);
}

export function validateKanjiVgCharacter(record, expectedCharacter = null) {
	assert(isPlainObject(record), 'character record must be an object');
	assert(
		record.schemaVersion === KANJIVG_SCHEMA_VERSION,
		`unsupported character schemaVersion ${record.schemaVersion}`
	);
	assert(typeof record.character === 'string' && record.character.length > 0, 'character is missing');
	if (expectedCharacter !== null) {
		assert(record.character === expectedCharacter, `expected ${expectedCharacter}, got ${record.character}`);
	}
	assert(record.source === 'KanjiVG', 'source must be KanjiVG');
	assert(record.strokeFormat === 'svg-centerline', 'strokeFormat must be svg-centerline');
	assert(record.coordinateSystem === 'normalized-top-left', 'coordinateSystem must be normalized-top-left');
	assert(
		Array.isArray(record.viewBox) &&
		record.viewBox.length === 4 &&
		record.viewBox.every(finiteNumber) &&
		record.viewBox[2] > 0 &&
		record.viewBox[3] > 0,
		'viewBox must contain four finite values with positive width/height'
	);
	assert(Array.isArray(record.strokes) && record.strokes.length > 0, 'strokes must be a non-empty array');

	for (const [index, stroke] of record.strokes.entries()) {
		assert(isPlainObject(stroke), `stroke ${index + 1} must be an object`);
		assert(typeof stroke.path === 'string' && stroke.path.length > 0, `stroke ${index + 1} path is missing`);
		assert(
			Array.isArray(stroke.median) &&
			stroke.median.length >= 2 &&
			stroke.median.every(validPoint),
			`stroke ${index + 1} median must contain normalized [x, y] points`
		);
	}
	return record;
}

export function validateKanjiVgDataset(dataset) {
	assert(isPlainObject(dataset), 'dataset must be an object');
	assert(
		dataset.schemaVersion === KANJIVG_SCHEMA_VERSION,
		`unsupported dataset schemaVersion ${dataset.schemaVersion}`
	);
	assert(isPlainObject(dataset.source), 'dataset.source must be an object');
	assert(dataset.source.name === 'KanjiVG', 'dataset source must be KanjiVG');
	assert(isPlainObject(dataset.characters), 'dataset.characters must be an object');
	for (const [character, record] of Object.entries(dataset.characters)) {
		assert(typeof character === 'string' && character.length > 0, 'dataset contains an empty character key');
		validateKanjiVgCharacter(record, character);
	}
	return dataset;
}

export function toKanjiPracticeCharacter(record) {
	validateKanjiVgCharacter(record);
	return {
		character: record.character,
		source: 'KanjiVG',
		sourceId: record.sourceId,
		strokeFormat: record.strokeFormat,
		coordinateSystem: record.coordinateSystem,
		viewBox: record.viewBox.slice(),
		strokeWidth: finiteNumber(record.strokeWidth) ? record.strokeWidth : 3,
		strokeLinecap: record.strokeLinecap || 'round',
		strokeLinejoin: record.strokeLinejoin || 'round',
		strokes: record.strokes.map((stroke) => stroke.path),
		medians: record.strokes.map((stroke) => stroke.median.map((point) => point.slice())),
		strokeTypes: record.strokes.map((stroke) => stroke.type || null),
		strokeMetadata: record.strokes.map((stroke) => ({
			id: stroke.id || null,
			type: stroke.type || null,
			components: Array.isArray(stroke.components)
				? structuredClone(stroke.components)
				: []
		})),
		dictionary: record.dictionary && typeof record.dictionary === 'object'
			? structuredClone(record.dictionary)
			: null
	};
}

export class KanjiVgStore {
	constructor({
		dataUrl = DEFAULT_KANJIVG_DATA_URL,
		fetchImpl = globalThis.fetch
	} = {}) {
		if (typeof fetchImpl !== 'function') {
			throw new Error('KanjiVgStore requires fetch');
		}
		this.dataUrl = dataUrl;
		this.fetchImpl = fetchImpl;
		this.dataset = null;
		this.loadPromise = null;
		this.practiceCache = new Map();
	}

	async load() {
		if (this.dataset) return this.dataset;
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = (async () => {
			const response = await Reflect.apply(this.fetchImpl, globalThis, [this.dataUrl]);
			if (!response.ok) {
				throw new Error(`Could not load KanjiVG data (${response.status})`);
			}
			const dataset = validateKanjiVgDataset(await response.json());
			this.dataset = dataset;
			return dataset;
		})().finally(() => {
			this.loadPromise = null;
		});
		return this.loadPromise;
	}

	async has(character) {
		const dataset = await this.load();
		return Object.hasOwn(dataset.characters, character);
	}

	async get(character) {
		const dataset = await this.load();
		return dataset.characters[character] || null;
	}

	getLoadedPracticeCharacter(character) {
		if (!this.dataset) return null;
		if (this.practiceCache.has(character)) {
			return this.practiceCache.get(character);
		}
		const record = this.dataset.characters[character] || null;
		const adapted = record ? toKanjiPracticeCharacter(record) : null;
		this.practiceCache.set(character, adapted);
		return adapted;
	}

	async getPracticeCharacter(character) {
		await this.load();
		return this.getLoadedPracticeCharacter(character);
	}
}
