import { isValidParentLockRecord } from './parent-lock.js';
import { isSafeObjectKey } from './list-id.js';
import { isTrackableKanji } from './kanji-mastery.js';

function isPlainObject(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value)
	);
}

function requirePlainObject(value, path) {
	if (!isPlainObject(value)) {
		throw new Error(`${path} must be an object.`);
	}
}

function requireStringArray(value, path) {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== 'string')
	) {
		throw new Error(`${path} must be an array of strings.`);
	}
}

function validateOptionalFiniteNumber(value, path, { nullable = false } = {}) {
	if (value === undefined || (nullable && value === null)) return;
	if (!Number.isFinite(Number(value))) {
		throw new Error(`${path} must be a finite number${nullable ? ' or null' : ''}.`);
	}
}

function validateListRow(row, path) {
	requirePlainObject(row, path);
	if (typeof row.written !== 'string' || !row.written.trim()) {
		throw new Error(`${path}.written must be a non-empty string.`);
	}
	if (typeof row.reading !== 'string') {
		throw new Error(`${path}.reading must be a string.`);
	}
	if (row.definition !== undefined && typeof row.definition !== 'string') {
		throw new Error(`${path}.definition must be a string.`);
	}
	if (row.definitions !== undefined) {
		requireStringArray(row.definitions, `${path}.definitions`);
	}
	for (const field of ['studyId', 'source', 'jmdictId']) {
		if (row[field] !== undefined && typeof row[field] !== 'string') {
			throw new Error(`${path}.${field} must be a string.`);
		}
	}
	if (row.common !== undefined && typeof row.common !== 'boolean') {
		throw new Error(`${path}.common must be a boolean.`);
	}
}


function validateCustomLists(customLists) {
	requirePlainObject(customLists, 'state.customLists');
	for (const [id, list] of Object.entries(customLists)) {
		if (!isSafeObjectKey(id)) {
			throw new Error(`state.customLists contains reserved list id ${id}.`);
		}
		const path = `state.customLists.${id}`;
		requirePlainObject(list, path);
		if (list.name !== undefined && typeof list.name !== 'string') {
			throw new Error(`${path}.name must be a string.`);
		}
		if (list.category !== undefined && typeof list.category !== 'string') {
			throw new Error(`${path}.category must be a string.`);
		}
		if (!Array.isArray(list.rows)) {
			throw new Error(`${path}.rows must be an array.`);
		}
		list.rows.forEach((row, index) =>
			validateListRow(row, `${path}.rows[${index}]`)
		);
	}
}

function validateVocabulary(vocabulary) {
	requirePlainObject(vocabulary, 'state.vocabulary');
	for (const [word, entry] of Object.entries(vocabulary)) {
		const path = `state.vocabulary.${word}`;
		requirePlainObject(entry, path);
		if (entry.word !== undefined && typeof entry.word !== 'string') {
			throw new Error(`${path}.word must be a string.`);
		}
		if (entry.lists !== undefined) {
			requireStringArray(entry.lists, `${path}.lists`);
		}
		for (const field of ['written', 'reading', 'definition']) {
			if (entry[field] !== undefined && typeof entry[field] !== 'string') {
				throw new Error(`${path}.${field} must be a string.`);
			}
		}
		for (const field of ['attempts', 'successes']) {
			validateOptionalFiniteNumber(entry[field], `${path}.${field}`);
		}
		for (const field of ['last', 'next']) {
			validateOptionalFiniteNumber(entry[field], `${path}.${field}`, {
				nullable: true
			});
		}
		if (entry.fsrs !== undefined) {
			requirePlainObject(entry.fsrs, `${path}.fsrs`);
		}
	}
}

function validateKanjiMastery(mastery) {
    requirePlainObject(mastery, 'state.kanjiMastery');
    for (const [kanji, entry] of Object.entries(mastery)) {
        if (!isTrackableKanji(kanji)) {
            throw new Error(`Invalid kanji mastery key: ${kanji}`);
        }
        const path = `state.kanjiMastery.${kanji}`;
        requirePlainObject(entry, path);
        if (entry.kanji !== undefined && entry.kanji !== kanji) {
            throw new Error(`${path}.kanji must match its key.`);
        }
        for (const field of ['attempts', 'successes', 'last', 'next']) {
            validateOptionalFiniteNumber(entry[field], `${path}.${field}`, {
                nullable: field === 'last' || field === 'next'
            });
        }
        if (entry.fsrs !== undefined) {
            requirePlainObject(entry.fsrs, `${path}.fsrs`);
        }
    }
}

function validateReviewLog(log, index) {
	const path = `state.reviewLogs[${index}]`;
	requirePlainObject(log, path);
	if (!String(log.card_id || '').trim()) {
		throw new Error(`${path}.card_id must be a non-empty string.`);
	}
	const reviewTime = Number(log.review_time);
	const reviewRating = Number(log.review_rating);
	const reviewState = Number(log.review_state);
	if (!Number.isFinite(reviewTime) || reviewTime <= 0) {
		throw new Error(`${path}.review_time must be a positive number.`);
	}
	if (!Number.isInteger(reviewRating) || reviewRating < 1 || reviewRating > 4) {
		throw new Error(`${path}.review_rating must be an integer from 1 to 4.`);
	}
	if (!Number.isInteger(reviewState) || reviewState < 0 || reviewState > 3) {
		throw new Error(`${path}.review_state must be an integer from 0 to 3.`);
	}
}

export function validateBackupPayload(payload) {
	requirePlainObject(payload, 'Backup');
	if (payload.app !== undefined && typeof payload.app !== 'string') {
		throw new Error('Backup.app must be a string when present.');
	}
	requirePlainObject(payload.state, 'state');
	const declaredEditions = [payload.app, payload.state.version]
		.filter((value) => typeof value === 'string' && value);
	if (declaredEditions.some((edition) =>
		edition.startsWith('inkstone-') &&
		!edition.startsWith('inkstone-japanese-')
	)) {
		throw new Error('This backup belongs to a different Inkstone edition.');
	}

	const sourceState = payload.state;
	const objectFields = [
		'settings',
		'enabledLists',
		'customLists',
		'vocabulary',
		'kanjiMastery',
		'session',
		'fsrsOptimization'
	];
	for (const field of objectFields) {
		if (sourceState[field] !== undefined) {
			requirePlainObject(sourceState[field], `state.${field}`);
		}
	}
	if (
		sourceState.blacklist !== undefined &&
		!Array.isArray(sourceState.blacklist) &&
		!isPlainObject(sourceState.blacklist)
	) {
		throw new Error('state.blacklist must be an object or array.');
	}
	if (sourceState.history !== undefined && !Array.isArray(sourceState.history)) {
		throw new Error('state.history must be an array.');
	}
	if (sourceState.session?.stageQueue !== undefined) {
		if (!Array.isArray(sourceState.session.stageQueue)) {
			throw new Error('state.session.stageQueue must be an array.');
		}
	}
	if (sourceState.settings?.parentLock !== undefined && sourceState.settings.parentLock !== null) {
		if (!isValidParentLockRecord(sourceState.settings.parentLock)) {
			throw new Error('state.settings.parentLock is not a valid parent/teacher lock record.');
		}
	}
	if (sourceState.enabledLists !== undefined) {
		for (const [id, enabled] of Object.entries(sourceState.enabledLists)) {
			if (typeof enabled !== 'boolean') {
				throw new Error(`state.enabledLists.${id} must be a boolean.`);
			}
		}
	}
	if (sourceState.customLists !== undefined) {
		validateCustomLists(sourceState.customLists);
	}
	if (sourceState.vocabulary !== undefined) {
		validateVocabulary(sourceState.vocabulary);
	}
	if (sourceState.kanjiMastery !== undefined) {
		validateKanjiMastery(sourceState.kanjiMastery);
	}

	const hasReviewLogs = Object.prototype.hasOwnProperty.call(
		sourceState,
		'reviewLogs'
	);
	let reviewLogs = null;
	if (hasReviewLogs) {
		if (!Array.isArray(sourceState.reviewLogs)) {
			throw new Error('state.reviewLogs must be an array when present.');
		}
		sourceState.reviewLogs.forEach(validateReviewLog);
		reviewLogs = structuredClone(sourceState.reviewLogs);
	}

	const state = structuredClone(sourceState);
	delete state.reviewLogs;
	return {
		state,
		hasReviewLogs,
		reviewLogs
	};
}
