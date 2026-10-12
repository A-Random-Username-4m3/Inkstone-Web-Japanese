'use strict';

export function normalizedIdentityText(value) {
	return String(value || '').trim().normalize('NFKC');
}

export function stableCustomStudyId(written, reading) {
	const normalizedWritten = normalizedIdentityText(written);
	const normalizedReading = normalizedIdentityText(reading);
	if (!normalizedWritten) return null;
	return `custom:${encodeURIComponent(normalizedWritten)}:${encodeURIComponent(normalizedReading)}`;
}

export function stableJmdictRecordId(sequence, written, reading) {
	const numericSequence = Number(sequence);
	const normalizedWritten = normalizedIdentityText(written);
	const normalizedReading = normalizedIdentityText(reading);
	if (!Number.isInteger(numericSequence) || numericSequence <= 0) return null;
	if (!normalizedWritten || !normalizedReading) return null;
	return `${numericSequence}:${encodeURIComponent(normalizedWritten)}:${encodeURIComponent(normalizedReading)}`;
}

export function stableJmdictStudyId(sequence, written, reading) {
	const recordId = stableJmdictRecordId(sequence, written, reading);
	return recordId ? `jmdict:${recordId}` : null;
}

export function jmdictSequenceFromRecordId(recordId) {
	const match = /^([1-9]\d*):/.exec(String(recordId || ''));
	return match ? Number(match[1]) : null;
}

export function legacyJmdictStudyIdSequence(studyId) {
	const match = /^jmdict:([1-9]\d*):\d+$/.exec(String(studyId || ''));
	return match ? Number(match[1]) : null;
}

export function migrateLegacyJmdictStudyId(studyId, written, reading) {
	const sequence = legacyJmdictStudyIdSequence(studyId);
	if (!sequence) return String(studyId || '');
	return stableJmdictStudyId(sequence, written, reading) || String(studyId || '');
}

function mergeUniqueStrings(left, right) {
	return [...new Set([
		...(Array.isArray(left) ? left : []),
		...(Array.isArray(right) ? right : [])
	].filter((value) => typeof value === 'string' && value))];
}

function mergeVocabularyEntries(existing, incoming, word) {
	if (!existing) return { ...incoming, word };
	const existingAttempts = Number(existing.attempts || 0);
	const incomingAttempts = Number(incoming.attempts || 0);
	const preferred = incomingAttempts > existingAttempts ? incoming : existing;
	const fallback = preferred === existing ? incoming : existing;
	return {
		...fallback,
		...preferred,
		word,
		lists: mergeUniqueStrings(existing.lists, incoming.lists)
	};
}

function remapWord(value, migrations) {
	const key = String(value || '');
	return migrations.get(key) || key;
}

function resolveAliasRecordId(recordId, aliases) {
	let current = String(recordId || '');
	const seen = new Set();
	while (current && aliases?.[current] && !seen.has(current)) {
		seen.add(current);
		current = String(aliases[current]);
	}
	return current;
}

function applyJmdictAlias(studyId, aliases) {
	const value = String(studyId || '');
	if (!value.startsWith('jmdict:')) return value;
	const recordId = value.slice('jmdict:'.length);
	const resolved = resolveAliasRecordId(recordId, aliases);
	return resolved && resolved !== recordId ? `jmdict:${resolved}` : value;
}

export function migrateJapaneseStudyIds(state, { jmdictAliases = null } = {}) {
	const migrations = new Map();
	if (!state || typeof state !== 'object') return migrations;

	const vocabulary = state.vocabulary && typeof state.vocabulary === 'object'
		? state.vocabulary
		: {};
	const migratedVocabulary = {};
	for (const [key, entryValue] of Object.entries(vocabulary)) {
		if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
			migratedVocabulary[key] = entryValue;
			continue;
		}
		const entry = { ...entryValue };
		entry.written = normalizedIdentityText(entry.written);
		entry.reading = normalizedIdentityText(entry.reading);
		const currentWord = String(entry.word || key).trim() || key;
		let migratedWord = migrateLegacyJmdictStudyId(
			currentWord,
			entry.written,
			entry.reading
		);
		if (currentWord.startsWith('custom:')) {
			migratedWord = stableCustomStudyId(entry.written, entry.reading) || migratedWord;
		}
		migratedWord = applyJmdictAlias(migratedWord, jmdictAliases);
		if (migratedWord !== currentWord) migrations.set(currentWord, migratedWord);
		if (key !== currentWord && migratedWord !== key) migrations.set(key, migratedWord);
		migratedVocabulary[migratedWord] = mergeVocabularyEntries(
			migratedVocabulary[migratedWord],
			entry,
			migratedWord
		);
	}
	state.vocabulary = migratedVocabulary;

	if (state.customLists && typeof state.customLists === 'object') {
		for (const list of Object.values(state.customLists)) {
			if (!Array.isArray(list?.rows)) continue;
			for (const row of list.rows) {
				if (!row || typeof row !== 'object') continue;
				row.written = normalizedIdentityText(row.written);
				row.reading = normalizedIdentityText(row.reading);
				const oldId = String(row.studyId || '');
				let migrated = migrateLegacyJmdictStudyId(
					oldId,
					row.written,
					row.reading
				);
				if (oldId.startsWith('custom:')) {
					migrated = stableCustomStudyId(row.written, row.reading) || migrated;
				}
				migrated = applyJmdictAlias(migrated, jmdictAliases);
				if (migrated !== oldId) {
					migrations.set(oldId, migrated);
					row.studyId = migrated;
					if (migrated.startsWith('jmdict:')) {
						row.jmdictId = migrated.slice('jmdict:'.length);
					}
				}
			}
		}
	}

	if (state.blacklist && typeof state.blacklist === 'object' && !Array.isArray(state.blacklist)) {
		const migratedBlacklist = {};
		for (const [key, value] of Object.entries(state.blacklist)) {
			const migratedKey = remapWord(key, migrations);
			const item = value && typeof value === 'object'
				? { ...value, word: remapWord(value.word || migratedKey, migrations) }
				: value;
			migratedBlacklist[migratedKey] = item;
		}
		state.blacklist = migratedBlacklist;
	}

	const session = state.session;
	if (session && typeof session === 'object') {
		if (Array.isArray(session.stageQueue)) {
			session.stageQueue = session.stageQueue.map((item) =>
				item && typeof item === 'object'
					? { ...item, word: remapWord(item.word, migrations) }
					: item
			);
		}
		if (session.currentStageCard && typeof session.currentStageCard === 'object') {
			session.currentStageCard = {
				...session.currentStageCard,
				word: remapWord(session.currentStageCard.word, migrations)
			};
		}
		if (session.lastWord) session.lastWord = remapWord(session.lastWord, migrations);
	}

	if (Array.isArray(state.history)) {
		state.history = state.history.map((item) =>
			item && typeof item === 'object' && item.word
				? { ...item, word: remapWord(item.word, migrations) }
				: item
		);
	}

	return migrations;
}

export function remapReviewLogCardIds(logs, migrations) {
	if (!Array.isArray(logs) || !migrations?.size) return Array.isArray(logs) ? logs : [];
	return logs.map((log) => {
		if (!log || typeof log !== 'object') return log;
		const cardId = String(log.card_id || '');
		const migrated = migrations.get(cardId);
		return migrated ? { ...log, card_id: migrated } : log;
	});
}
