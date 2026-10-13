import { DEFAULT_STUDY_EXAMPLE_LIMIT } from './constants.js';
import { isValidParentLockRecord } from './parent-lock.js';
import { isSafeObjectKey } from './list-id.js';
import { normalizeKanjiMastery } from './kanji-mastery.js';

function isPlainObject(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value)
	);
}

function normalizeObject(value) {
	return isPlainObject(value) ? value : {};
}
export function normalizeBlacklist(blacklist) {
	if (Array.isArray(blacklist)) {
		return Object.fromEntries(
			blacklist
				.filter(Boolean)
				.map((item) => [
					item.word || item,
					typeof item === 'string' ? { word: item } : item
				])
		);
	}
	const result = {};
	for (const [word, value] of Object.entries(blacklist || {})) {
		if (!value) continue;
		result[word] =
			typeof value === 'object' ? { word, ...value } : { word };
	}
	return result;
}


function normalizeFsrsOptimizationState(value = {}) {
	const source = value && typeof value === 'object' ? value : {};
	const lastOptimizedAt = Number(source.lastOptimizedAt);
	const lastOptimizedReviewCount = Number(source.lastOptimizedReviewCount);
	const reminderSnoozedUntil = Number(source.reminderSnoozedUntil);
	const nextOptimizationReviewCount = Number(
		source.nextOptimizationReviewCount
	);
	return {
		lastOptimizedAt: Number.isFinite(lastOptimizedAt) && lastOptimizedAt > 0
			? Math.floor(lastOptimizedAt)
			: null,
		lastOptimizedReviewCount:
			Number.isFinite(lastOptimizedReviewCount) && lastOptimizedReviewCount > 0
				? Math.floor(lastOptimizedReviewCount)
				: 0,
		reminderSnoozedUntil:
			Number.isFinite(reminderSnoozedUntil) && reminderSnoozedUntil > 0
				? Math.floor(reminderSnoozedUntil)
				: null,
		nextOptimizationReviewCount:
			Number.isFinite(nextOptimizationReviewCount) &&
				nextOptimizationReviewCount > 0
				? Math.floor(nextOptimizationReviewCount)
				: null
	};
}

export function createStateStore({
	appVersion,
	storageKey,
	defaultScheduling,
	now,
	clamp,
	syncStageQueueToSession,
	setBackupStatus
}) {
	function freshSession(started = now()) {
		return {
			started,
			adds: 0,
			reviews: 0,
			steps: 0,
			kanji: 0,
			kanjiReviewed: [],
			minCards: 0,
			stageQueue: [],
			currentStageCard: null,
			lastWord: null
		};
	}

	const defaultState = () => ({
		version: appVersion,
		settings: {
			revealOrder: true,
			showManualGrading: true,
			showUndoBlacklistButtons: true,
			showNextCardButton: true,
			parentLock: null,
			snapStrokes: true,
			maxAdds: 5,
			maxReviews: 10,
			studyExampleLimit: DEFAULT_STUDY_EXAMPLE_LIMIT,
			examplesActiveListsOnly: false,
			stage2KeepUserStrokes: false,
			stage3KeepUserStrokes: false,
			sessionHours: defaultScheduling.sessionHours,
			desiredRetention: defaultScheduling.desiredRetention,
			maximumIntervalDays: defaultScheduling.maximumIntervalDays,
			learningStepMinutes: defaultScheduling.learningStepMinutes,
			relearningStepMinutes: defaultScheduling.relearningStepMinutes,
			newCardOrder: defaultScheduling.newCardOrder,
			reviewOrder: defaultScheduling.reviewOrder,
			newCardsIgnoreReviewLimit:
				defaultScheduling.newCardsIgnoreReviewLimit,
			fsrsParameters: defaultScheduling.fsrsParameters,
			debugNow: defaultScheduling.debugNow
		},
		enabledLists: {},
		customLists: {},
		vocabulary: {},
		kanjiMastery: {},
		blacklist: {},
		session: freshSession(),
		history: [],
		fsrsOptimization: {
			lastOptimizedAt: null,
			lastOptimizedReviewCount: 0,
			reminderSnoozedUntil: null,
			nextOptimizationReviewCount: null
		}
	});

	function mergeState(base, saved, root = true) {
		for (const [key, value] of Object.entries(normalizeObject(saved))) {
			if (!isSafeObjectKey(key)) continue;
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				base[key] &&
				typeof base[key] === 'object' &&
				!Array.isArray(base[key])
			) {
				base[key] = mergeState(base[key], value, false);
			} else {
				base[key] = value;
			}
		}
		if (!root) return base;

		const defaults = defaultState();
		base.settings = isPlainObject(base.settings)
			? base.settings
			: { ...defaults.settings };
		base.enabledLists = normalizeObject(base.enabledLists);
		base.customLists = normalizeObject(base.customLists);
		base.vocabulary = normalizeObject(base.vocabulary);
		base.kanjiMastery = normalizeKanjiMastery(base.kanjiMastery);
		base.blacklist =
			Array.isArray(base.blacklist) || isPlainObject(base.blacklist)
				? base.blacklist
				: {};
		base.session = isPlainObject(base.session) ? base.session : {};

		for (const [word, entry] of Object.entries(base.vocabulary)) {
			if (!isPlainObject(entry)) {
				delete base.vocabulary[word];
				continue;
			}
			entry.word = String(entry.word || word).trim() || word;
			entry.lists = Array.isArray(entry.lists)
				? [...new Set(entry.lists.filter((id) => typeof id === 'string'))]
				: [];
		}

		if (base.settings) {
			for (const [key, value] of Object.entries(defaultScheduling)) {
				if (base.settings[key] === undefined) base.settings[key] = value;
			}
			base.settings.desiredRetention = clamp(
				Number(base.settings.desiredRetention) ||
					defaultScheduling.desiredRetention,
				0.7,
				0.97
			);
			base.settings.maximumIntervalDays = Math.max(
				1,
				Number(base.settings.maximumIntervalDays) ||
					defaultScheduling.maximumIntervalDays
			);
			base.settings.studyExampleLimit = Math.max(
				1,
				Math.floor(
					Number(base.settings.studyExampleLimit) ||
						DEFAULT_STUDY_EXAMPLE_LIMIT
				)
			);
			base.settings.examplesActiveListsOnly =
				!!base.settings.examplesActiveListsOnly;
			base.settings.showManualGrading =
				base.settings.showManualGrading !== false;
			base.settings.showUndoBlacklistButtons =
				base.settings.showUndoBlacklistButtons !== false;
			base.settings.showNextCardButton =
				base.settings.showNextCardButton !== false;
			base.settings.parentLock = isValidParentLockRecord(
				base.settings.parentLock
			)
				? { ...base.settings.parentLock }
				: null;
			delete base.settings.scriptMode;
			base.settings.stage2KeepUserStrokes =
				!!base.settings.stage2KeepUserStrokes;
			base.settings.stage3KeepUserStrokes =
				!!base.settings.stage3KeepUserStrokes;
		}
		if ('session' in base) {
			base.session = {
				...freshSession(),
				...(base.session || {})
			};
			delete base.session.failures;
            base.session.kanji = Math.max(0, Math.floor(Number(base.session.kanji) || 0));
            base.session.kanjiReviewed = Array.isArray(base.session.kanjiReviewed)
                ? [...new Set(base.session.kanjiReviewed.filter((ch) =>
                    typeof ch === 'string' && ch.length <= 2))] : [];
		}
		if ('blacklist' in base) {
			base.blacklist = normalizeBlacklist(base.blacklist || {});
		}
		base.history = Array.isArray(base.history) ? base.history : [];
		delete base.reviewLogs;
		base.fsrsOptimization = normalizeFsrsOptimizationState(
			base.fsrsOptimization
		);
		return base;
	}

	function loadState() {
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return defaultState();
			return mergeState(defaultState(), JSON.parse(raw));
		} catch (error) {
			console.warn('Could not load local state:', error);
			return defaultState();
		}
	}

	function saveState(state) {
		state.version = appVersion;
		syncStageQueueToSession?.();
		try {
			const persisted = { ...state };
			delete persisted.reviewLogs;
			localStorage.setItem(storageKey, JSON.stringify(persisted));
			return true;
		} catch (error) {
			console.error('Could not save Inkstone state:', error);
			setBackupStatus?.(
				'Save failed. Storage may be full or unavailable; export a backup before closing.'
			);
			return false;
		}
	}

	return {
		freshSession,
		defaultState,
		mergeState,
		loadState,
		saveState
	};
}
