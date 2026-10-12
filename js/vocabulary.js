import {
	normalizeJapaneseText,
	rowCanonicalWord,
	rowDefinition,
	rowReading,
	rowWritten,
	rowWords
} from './word-data.js';
import { migrateLegacyJmdictStudyId, stableCustomStudyId } from './jmdict-id.js';
export function createVocabulary(ctx) {
	const state = ctx.liveState();
	const lists = ctx.liveLists();
	const ensureFsrsState = (...args) => ctx.ensureFsrsState(...args);
	const saveState = (...args) => ctx.saveState(...args);
	const listRowIndexCache = new WeakMap();


	function getListRowIndex(list) {
		const rows = Array.isArray(list?.rows) ? list.rows : [];
		const cached = list && typeof list === 'object'
			? listRowIndexCache.get(list)
			: null;
		if (
			cached &&
			cached.rows === rows &&
			cached.length === rows.length
		) return cached.index;

		const index = new Map();
		for (const row of rows) {
			const word = rowCanonicalWord(row);
			if (word && !index.has(word)) index.set(word, row);
		}
		if (list && typeof list === 'object') {
			listRowIndexCache.set(list, { rows, length: rows.length, index });
		}
		return index;
	}
	function hasEnabledList(word) {
		const entry = state.vocabulary[word];
		return (
			!!entry &&
			(entry.lists || []).some((id) => !!state.enabledLists[id])
		);
	}


	function isActiveStudyWord(word) {
		const row = getEntryRow(word);
		const studyWord = rowWritten(row) || word;
		return (
			!!word &&
			!state.blacklist[word] &&
			hasEnabledList(word) &&
			canStudyWord(studyWord)
		);
	}



	function parseTsvRows(text) {
		return text
			.replace(/^\ufeff/, '')
			.split(/\r?\n/)
			.map((line, originalIndex) => ({ line, originalIndex }))
			.filter(({ line }) => line.trim().length > 0)
			.map(({ line, originalIndex }) => {
				const cells = line.split('\t').map((cell) => cell.trim());
				if (cells.length >= 4 && /^jmdict:/.test(cells[0])) {
					const written = normalizeJapaneseText(cells[1]);
					const reading = normalizeJapaneseText(cells[2]);
					const studyId = migrateLegacyJmdictStudyId(cells[0], written, reading);
					const definition = cells.slice(3).join('\t').trim();
					if (!written || !reading) {
						throw new Error(`Line ${originalIndex + 1} has an invalid JMdict list row.`);
					}
					return {
						studyId,
						source: 'JMdict',
						jmdictId: studyId.slice('jmdict:'.length),
						written,
						reading,
						definitions: definition ? [definition] : [],
						definition
					};
				}
				if (cells.length < 3) {
					throw new Error(
						`Line ${originalIndex + 1} has ${cells.length} columns, expected 3: written form, reading, definition.`
					);
				}
				const written = normalizeJapaneseText(cells[0]);
				const reading = normalizeJapaneseText(cells[1]);
				const definition = cells.slice(2).join('\t').trim();
				if (!written) {
					throw new Error(`Line ${originalIndex + 1} is missing a written form.`);
				}
				return {
					studyId: stableCustomStudyId(written, reading),
					source: 'Custom',
					written,
					reading,
					definitions: definition ? [definition] : [],
					definition
				};
			});
	}


	function rowToTsv(row) {
		return [
			rowWritten(row),
			rowReading(row),
			rowDefinition(row)
		].join('\t');
	}


	function canStudyWord(word) {
		const chars = Array.from(normalizeJapaneseText(word));
		return chars.length > 0 && chars.every((ch) =>
			Boolean(ctx.getKanjiPracticeCharacter?.(ch))
		);
	}



	function getEnabledListIds() {
		return Object.keys(lists || {}).filter(
			(id) => !!state.enabledLists?.[id]
		);
	}


	function getFirstEnabledListId() {
		return getEnabledListIds()[0] || null;
	}


	function syncSelectedListForEnabledLists() {
		if (ctx.selectedListId && lists[ctx.selectedListId]) return ctx.selectedListId;
		ctx.selectedListId = getFirstEnabledListId();
		return ctx.selectedListId;
	}


	function applyDefaultListSelection() {
		state.enabledLists = state.enabledLists || {};
		if (Array.isArray(ctx.knownListIds)) {
			const knownListIds = new Set(ctx.knownListIds);
			for (const id of Object.keys(state.enabledLists)) {
				if (!knownListIds.has(id)) delete state.enabledLists[id];
			}
		}
		syncSelectedListForEnabledLists();
	}


	function syncVocabularyWithEnabledLists({ save = true } = {}) {
		state.vocabulary =
			state.vocabulary && typeof state.vocabulary === 'object'
				? state.vocabulary
				: {};

		const memberships = new Map();
		for (const [id, list] of Object.entries(lists || {})) {
			for (const row of list.rows || []) {
				const word = rowCanonicalWord(row);
				if (!word) continue;
				if (!memberships.has(word)) memberships.set(word, new Set());
				memberships.get(word).add(id);
			}
		}

		const activeIds = Object.keys(state.enabledLists || {}).filter(
			(id) => state.enabledLists[id] && lists[id]
		);
		for (const id of activeIds) {
			for (const row of lists[id].rows || []) {
				const word = rowCanonicalWord(row);
				const studyWord = rowWritten(row);
				if (!word || !canStudyWord(studyWord)) continue;
				ensureVocabularyEntry(word, null, row);
			}
		}

		for (const [word, entry] of Object.entries(state.vocabulary)) {
			if (!entry || typeof entry !== 'object') continue;
			entry.lists = [...(memberships.get(word) || [])];
		}

		if (save) saveState();
	}


	function ensureVocabularyEntry(word, listId = null, row = null) {
		if (!state.vocabulary[word]) {
			state.vocabulary[word] = {
				word,
				last: null,
				next: null,
				lists: [],
				attempts: 0,
				successes: 0
			};
		}
		const entry = state.vocabulary[word];
		if (row) {
			entry.written = rowWritten(row) || entry.written || '';
			entry.reading = rowReading(row) || entry.reading || '';
			entry.definition = rowDefinition(row) || entry.definition || '';
		}
		delete entry.failed;
		entry.lists = Array.isArray(entry.lists) ? entry.lists : [];
		if (listId && !entry.lists.includes(listId)) entry.lists.push(listId);
		entry.attempts = Number(entry.attempts || 0);
		entry.successes = Number(entry.successes || 0);
		if (entry.attempts) ensureFsrsState(entry);
		else delete entry.fsrs;
		return entry;
	}


	function resolveCanonicalWords(value) {
		const query = String(value || '').trim();
		if (!query) return [];
		const matches = new Set();
		if (state.vocabulary[query]) matches.add(query);
		for (const list of Object.values(lists)) {
			for (const row of list.rows || []) {
				const canonical = rowCanonicalWord(row);
				if (!canonical) continue;
				if (canonical === query || rowWords(row).includes(query)) {
					matches.add(canonical);
				}
			}
		}
		for (const [canonical, entry] of Object.entries(state.vocabulary || {})) {
			if (entry?.written === query) matches.add(canonical);
		}
		return [...matches];
	}


	function resolveCanonicalWord(value) {
		const query = String(value || '').trim();
		return resolveCanonicalWords(query)[0] || query;
	}


	function getEntryRow(word) {
		const entryListIds = state.vocabulary[word]?.lists || [];
		const preferredListIds = [
			...entryListIds.filter((listId) => state.enabledLists?.[listId]),
			...entryListIds.filter((listId) => !state.enabledLists?.[listId])
		];
		for (const listId of preferredListIds) {
			const found = getListRowIndex(lists[listId]).get(word);
			if (found) return found;
		}
		const entry = state.vocabulary[word] || {};
		return {
			studyId: word,
			written: entry.written || word,
			reading: entry.reading || '',
			definition: entry.definition || ''
		};
	}


	function getActiveVocabulary() {
		return Object.values(state.vocabulary).filter((entry) => {
			if (
				!entry?.word ||
				!(entry.lists || []).some((id) => state.enabledLists[id]) ||
				state.blacklist[entry.word]
			) return false;
			const row = getEntryRow(entry.word);
			return canStudyWord(rowWritten(row) || entry.word);
		});
	}


	function orderNewItemsByListPosition(items) {
		const byWord = new Map(items.map((entry) => [entry.word, entry]));
		const ordered = [];
		const seen = new Set();
		for (const [listId, list] of Object.entries(lists)) {
			if (!state.enabledLists[listId]) continue;
			for (const row of list.rows || []) {
				const word = rowCanonicalWord(row);
				const entry = byWord.get(word);
				if (!entry || seen.has(word)) continue;
				ordered.push(entry);
				seen.add(word);
			}
		}
		for (const entry of items) {
			if (seen.has(entry.word)) continue;
			ordered.push(entry);
		}
		return ordered;
	}


	function firstNewByListPosition(items) {
		return orderNewItemsByListPosition(
			items.filter((entry) => !(entry.attempts || 0))
		)[0] || null;
	}


	return {
		isActiveStudyWord,
		parseTsvRows,
		rowToTsv,
		canStudyWord,
		getEnabledListIds,
		getFirstEnabledListId,
		syncSelectedListForEnabledLists,
		applyDefaultListSelection,
		syncVocabularyWithEnabledLists,
		ensureVocabularyEntry,
		getEntryRow,
		resolveCanonicalWords,
		resolveCanonicalWord,
		getActiveVocabulary,
		orderNewItemsByListPosition,
		firstNewByListPosition
	};
}
