import {
	DEFAULT_EXTRA_CARDS,
	DEFAULT_STUDY_EXAMPLE_LIMIT
} from './constants.js';
import { $, $$, clamp, escapeHtml, metaRow, sample, setText } from './dom-utils.js';
import {
	formatClockDuration,
	formatDateTimeLocal,
	formatDebugClockDisplay,
	formatDebugTimeStatus,
	formatDuration,
	formatRelativeDue,
	parseDateTimeLocalSeconds
} from './time-format.js';
import { createStateStore, normalizeBlacklist } from './state-store.js';
import {
	DEFAULT_SCHEDULING,
	configureFsrs,
	normalizeFsrsParametersText,
	ensureFsrsState,
	setEntrySchedulerState
} from './fsrs.js';
import { configurePracticeCanvas } from './practice-canvas.js';
import { KanjiVgStore } from './kanji-data.js';
import { kanjiMasterySummary } from './kanji-mastery.js';
import { JmDictStore } from './jmdict-data.js';
import { createVocabulary } from './vocabulary.js';
import { createSessionQueue } from './session-queue.js';
import { createStudyFlow } from './study-flow.js';
import { createListsUi } from './lists-ui.js';
import { createSettingsUi } from './settings-ui.js';
import { createLookupUi } from './lookup-ui.js';
import { createWordExamples } from './word-examples.js';
import { createBackupApi } from './backup.js';
import { createReviewLogStore } from './review-log-store.js';
import { rowReading, rowWritten } from './word-data.js';
import { migrateJapaneseStudyIds } from './jmdict-id.js';
import {
	JAPANESE_REVIEW_DB_NAME,
	JAPANESE_STORAGE_KEY,
	LEGACY_SHARED_REVIEW_DB_NAME,
	finishLegacyReviewLogMigration,
	migrateLegacyJapaneseStorage
} from './storage-migration.js';

const APP_VERSION = 'inkstone-japanese-0.13.0';
const STORAGE_KEY = JAPANESE_STORAGE_KEY;
const persistenceMigration = migrateLegacyJapaneseStorage(window.localStorage);
const NEXT_CARD_DELAY_MS = 650;
const STAGED_CARD_SPACING_TURNS = 1;

	let state = null;
	const realNow = () => Math.floor(Date.now() / 1000);
	function debugNowSeconds(settings = state?.settings) {
		const value = Number(settings?.debugNow);
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
	}
	const now = () => debugNowSeconds() ?? realNow();

const kanjiStore = new KanjiVgStore();
const jmdictStore = new JmDictStore();
	let vocabularyApi = null;
	let sessionQueueApi = null;
	let studyFlowApi = null;
	let listsUiApi = null;
	let settingsApi = null;
	let lookupUiApi = null;
	let wordExamplesApi = null;
	let backupApi = null;

	// sounds - bound to actions
	let tabChangeAudio = null;
	let addBlacklistAudio = null;
	let restoreBlacklistAudio = null;
	let correctStrokeAudio = null;
	let wrongStrokeAudio = null;
	let fairResultAudio = null;
	let repeatNextAudio = null;
	let goodJobAudio = null;

	const stateStore = createStateStore({
		appVersion: APP_VERSION,
		storageKey: STORAGE_KEY,
		defaultScheduling: DEFAULT_SCHEDULING,
		now,
		clamp,
		syncStageQueueToSession: () => sessionQueueApi?.syncStageQueueToSession?.(),
		setBackupStatus: (message) => setText('#backupStatus', message)
	});
	const {
		freshSession,
		defaultState,
		mergeState,
		loadState,
		saveState: persistState
	} = stateStore;

	state = loadState();
	const initialStudyIdMigrations = migrateJapaneseStudyIds(state);
	let lists = {};
	let knownListIds = null;
	let currentCard = null;
	let stagedQueue = Array.isArray(state.session?.stageQueue)
		? state.session.stageQueue
		: [];
	let trainer = null;
	let lookupAnimator = null;
	let selectedListId = null;
	let listEditorDrafts = {};
	let nextCardTimer = null;
	let reviewLogCount = 0;
	const pendingReviewLogWrites = new Set();
	const reviewLogStore = createReviewLogStore({
		dbName: JAPANESE_REVIEW_DB_NAME,
		migrateFromDbName: persistenceMigration.shouldMigrateReviewLogs
			? LEGACY_SHARED_REVIEW_DB_NAME
			: null,
		onLegacyMigrationComplete: () =>
			finishLegacyReviewLogMigration(window.localStorage),
		setStatus: (message) => setText('#backupStatus', message)
	});


	async function refreshReviewLogCount() {
		reviewLogCount = await reviewLogStore.count();
		return reviewLogCount;
	}


	async function waitForReviewLogWrites() {
		if (!pendingReviewLogWrites.size) return;
		await Promise.allSettled([...pendingReviewLogWrites]);
	}

	function addReviewLog(log) {
		reviewLogCount += 1;
		const write = reviewLogStore.add(log).then((saved) => {
			if (!saved) {
				reviewLogCount = Math.max(0, reviewLogCount - 1);
				renderProgress();
			}
			backupApi?.renderFsrsOptimizationNotice?.();
		});
		pendingReviewLogWrites.add(write);
		void write.finally(() => pendingReviewLogWrites.delete(write));
	}

	async function getAllReviewLogs() {
		await waitForReviewLogWrites();
		return reviewLogStore.getAll();
	}

	async function replaceReviewLogs(logs) {
		await waitForReviewLogWrites();
		const requestedCount = Array.isArray(logs) ? logs.length : 0;
		const restoredCount = await reviewLogStore.replaceAll(logs);
		const ok = Number.isFinite(restoredCount);
		reviewLogCount = await reviewLogStore.count();
		backupApi?.renderFsrsOptimizationNotice?.();
		renderProgress();
		return {
			ok,
			requestedCount,
			restoredCount: ok ? restoredCount : 0,
			actualCount: reviewLogCount
		};
	}

	async function clearAllReviewLogs() {
		await waitForReviewLogWrites();
		const cleared = await reviewLogStore.clear();
		if (cleared) reviewLogCount = 0;
		else reviewLogCount = await refreshReviewLogCount();
		backupApi?.renderFsrsOptimizationNotice?.();
		renderProgress();
		return cleared;
	}

	async function clearReviewLogsForCards(cardIds) {
		await waitForReviewLogWrites();
		const deleted = await reviewLogStore.deleteByCardIds(cardIds);
		if (deleted) reviewLogCount = await refreshReviewLogCount();
		backupApi?.renderFsrsOptimizationNotice?.();
		renderProgress();
		return deleted;
	}

	function liveObject(getTarget) {
		return new Proxy(
			{},
			{
				get(_target, property) {
					return getTarget()?.[property];
				},
				set(_target, property, value) {
					const target = getTarget();
					if (!target) return false;
					target[property] = value;
					return true;
				},
				deleteProperty(_target, property) {
					const target = getTarget();
					if (!target) return true;
					delete target[property];
					return true;
				},
				has(_target, property) {
					return property in (getTarget() || {});
				},
				ownKeys() {
					return Reflect.ownKeys(getTarget() || {});
				},
				getOwnPropertyDescriptor(_target, property) {
					const target = getTarget() || {};
					const descriptor = Object.getOwnPropertyDescriptor(target, property);
					if (descriptor) descriptor.configurable = true;
					return descriptor;
				}
			}
		);
	}


	const appContext = {
		get state() { return state; },
		set state(value) { state = value; },
		get lists() { return lists; },
		set lists(value) { lists = value; },
		get knownListIds() { return knownListIds; },
		set knownListIds(value) {
			knownListIds = Array.isArray(value) ? value.slice() : null;
		},
		get currentCard() { return currentCard; },
		set currentCard(value) { currentCard = value; },
		get stagedQueue() { return stagedQueue; },
		set stagedQueue(value) { stagedQueue = value; },
		get trainer() { return trainer; },
		set trainer(value) { trainer = value; },
		get selectedListId() { return selectedListId; },
		set selectedListId(value) { selectedListId = value; },
		get listEditorDrafts() { return listEditorDrafts; },
		set listEditorDrafts(value) { listEditorDrafts = value; },
		get nextCardTimer() { return nextCardTimer; },
		set nextCardTimer(value) { nextCardTimer = value; },
		liveState: () => liveObject(() => state),
		getKanjiPracticeCharacter: (character) =>
			kanjiStore.getLoadedPracticeCharacter(character),
		loadKanjiPracticeCharacter: (character) =>
			kanjiStore.getPracticeCharacter(character),
		jmdictStore,
		get jmdictAliases() { return jmdictStore.manifest?.idAliases || {}; },
		liveLists: () => liveObject(() => lists),
		get lookupAnimator() { return lookupAnimator; },
		set lookupAnimator(value) { lookupAnimator = value; },
		APP_VERSION, STORAGE_KEY,
		get reviewLogCount() { return reviewLogCount; },
		addReviewLog,
		getAllReviewLogs,
		replaceReviewLogs,
		clearAllReviewLogs,
		clearReviewLogsForCards,
		$, $$, setText, now, realNow, debugNowSeconds, clamp, sample, metaRow,
		playSound, playResultSound,
		NEXT_CARD_DELAY_MS, STAGED_CARD_SPACING_TURNS,
		freshSession,
		defaultState,
		mergeState,
		sessionDuration: (...args) => settingsApi.sessionDuration(...args),
		learningStepInterval: (...args) => settingsApi.learningStepInterval(...args),
		relearningStepInterval: (...args) => settingsApi.relearningStepInterval(...args),
		formatDateTimeLocal,
		formatRelativeDue,
		formatClockDuration,
		formatDebugTimeStatus,
		formatDueSummary,
		escapeHtml,
		normalizeBlacklist,
		ensureFsrsState,
		setEntrySchedulerState,
		saveState: (...args) => saveState(...args),
		renderProgress: (...args) => renderProgress(...args),
		renderSettings: (...args) => settingsApi.renderSettings(...args),
		renderFsrsOptimizationNotice: (...args) =>
			backupApi?.renderFsrsOptimizationNotice?.(...args),
		parseTsvRows: (...args) => vocabularyApi.parseTsvRows(...args),
		rowToTsv: (...args) => vocabularyApi.rowToTsv(...args),
		canStudyWord: (...args) => vocabularyApi.canStudyWord(...args),
		getEnabledListIds: (...args) => vocabularyApi.getEnabledListIds(...args),
		getFirstEnabledListId: (...args) => vocabularyApi.getFirstEnabledListId(...args),
		syncSelectedListForEnabledLists: (...args) => vocabularyApi.syncSelectedListForEnabledLists(...args),
		applyDefaultListSelection: (...args) => vocabularyApi.applyDefaultListSelection(...args),
		syncVocabularyWithEnabledLists: (...args) => vocabularyApi.syncVocabularyWithEnabledLists(...args),
		ensureVocabularyEntry: (...args) => vocabularyApi.ensureVocabularyEntry(...args),
		getEntryRow: (...args) => vocabularyApi.getEntryRow(...args),
		resolveCanonicalWords: (...args) => vocabularyApi.resolveCanonicalWords(...args),
		resolveCanonicalWord: (...args) => vocabularyApi.resolveCanonicalWord(...args),
		getActiveVocabulary: (...args) => vocabularyApi.getActiveVocabulary(...args),
		orderNewItemsByListPosition: (...args) => vocabularyApi.orderNewItemsByListPosition(...args),
		firstNewByListPosition: (...args) => vocabularyApi.firstNewByListPosition(...args),
		isActiveStudyWord: (...args) => vocabularyApi.isActiveStudyWord(...args),
		syncStageQueueToSession: (...args) => sessionQueueApi.syncStageQueueToSession(...args),
		clearCurrentStageCard: (...args) => sessionQueueApi.clearCurrentStageCard(...args),
		pruneStagedState: (...args) => sessionQueueApi.pruneStagedState(...args),
		isWordQueuedForStage: (...args) => sessionQueueApi.isWordQueuedForStage(...args),
		clearStagedWord: (...args) => sessionQueueApi.clearStagedWord(...args),
		getDueSets: (...args) => sessionQueueApi.getDueSets(...args),
		getRemainder: (...args) => sessionQueueApi.getRemainder(...args),
		resetExpiredSession: (...args) => sessionQueueApi.resetExpiredSession(...args),
		ageQueuedStageCards: (...args) => sessionQueueApi.ageQueuedStageCards(...args),
		getQueuedStageCandidates: (...args) => sessionQueueApi.getQueuedStageCandidates(...args),
		chooseAvailableBucket: (...args) => sessionQueueApi.chooseAvailableBucket(...args),
		buildPrimaryBuckets: (...args) => sessionQueueApi.buildPrimaryBuckets(...args),
		orderReviewItems: (...args) => sessionQueueApi.orderReviewItems(...args),
		lastShownWord: (...args) => sessionQueueApi.lastShownWord(...args),
		rememberShownWord: (...args) => sessionQueueApi.rememberShownWord(...args),
		disposeTrainer: (...args) => studyFlowApi.disposeTrainer(...args),
		setPracticeEmptyState: (...args) => studyFlowApi.setPracticeEmptyState(...args),
		setStudyControlsEnabled: (...args) => studyFlowApi.setStudyControlsEnabled(...args),
		clearExternalWordStudyState: (...args) => studyFlowApi.clearExternalWordStudyState(...args),
		refreshStudyAfterExternalChange: (...args) => studyFlowApi.refreshStudyAfterExternalChange(...args),
		setFeedbackMessage: (...args) => studyFlowApi.setFeedbackMessage(...args),
		cancelScheduledNextCard: (...args) => studyFlowApi.cancelScheduledNextCard(...args),
		nextCard: (...args) => studyFlowApi.nextCard(...args),
		isMasteredEntry: (...args) => studyFlowApi.isMasteredEntry(...args),
		setBlacklistedWord: (...args) => listsUiApi.setBlacklistedWord(...args),
		renderLists: (...args) => listsUiApi.renderLists(...args),
		renderListEditor: (...args) => listsUiApi.renderListEditor(...args),
		renderBlacklist: (...args) => listsUiApi.renderBlacklist(...args),
		refreshListEditorAfterAction: (...args) => listsUiApi.refreshListEditorAfterAction(...args),
		refreshListEditorDueText: (...args) => listsUiApi.refreshListEditorDueText(...args),
		refreshVocabularyViews: (...args) => listsUiApi.refreshVocabularyViews(...args),
		renderStudyExamples: (...args) =>
			wordExamplesApi?.renderStudyExamples?.(...args),
		clearStudyExamples: (...args) =>
			wordExamplesApi?.clearStudyExamples?.(...args),
		renderLookupExamples: (...args) =>
			wordExamplesApi?.renderLookupExamples?.(...args),
		clearLookupExamples: (...args) =>
			wordExamplesApi?.clearLookupExamples?.(...args)
	};

	settingsApi = createSettingsUi(appContext);
	vocabularyApi = createVocabulary(appContext);
	sessionQueueApi = createSessionQueue(appContext);
	wordExamplesApi = createWordExamples(appContext);
	studyFlowApi = createStudyFlow(appContext);
	listsUiApi = createListsUi(appContext);
	lookupUiApi = createLookupUi(appContext);
	backupApi = createBackupApi(appContext);

	configureFsrs({
		getSettings: () => state?.settings,
		now,
		learningStepInterval: (...args) => settingsApi.learningStepInterval(...args),
		relearningStepInterval: (...args) => settingsApi.relearningStepInterval(...args)
	});

	const {
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
		getActiveVocabulary,
		orderNewItemsByListPosition,
		firstNewByListPosition
	} = vocabularyApi;
	const {
		syncStageQueueToSession,
		lastShownWord,
		rememberShownWord,
		clearCurrentStageCard,
		pruneStagedState,
		isWordQueuedForStage,
		clearStagedWord,
		stagedWorkCounts,
		getDueSets,
		resetExpiredSession,
		getRemainder,
		ageQueuedStageCards,
		getQueuedStageCandidates,
		chooseAvailableBucket,
		buildPrimaryBuckets,
		orderReviewItems
	} = sessionQueueApi;
	const {
		clearExternalWordStudyState,
		disposeTrainer,
		setPracticeEmptyState,
		setStudyControlsEnabled,
		setFeedbackMessage,
		isMasteredEntry,
		cancelScheduledNextCard,
		nextCard,
		renderCharProgress,
		completeCurrentCard,
		addExtraCards,
		blacklistCurrentCard,
		autoLoadDueCard,
		refreshStudyAfterExternalChange
	} = studyFlowApi;
	const {
		setBlacklistedWord,
		refreshVocabularyViews,
		renderLists,
		refreshListEditorAfterAction,
		renderListEditor,
		renderBlacklist,
		refreshListEditorDueText
	} = listsUiApi;


	const {
		sessionDuration,
		learningStepInterval,
		relearningStepInterval,
		renderSettings,
		updateSetting,
		updateProtectedStudySetting,
		setOrUnlockParentLock,
		lockParentControls,
		removeParentLock,
		updateDebugNow
	} = settingsApi;
	const {
		lookupCharacter,
		stopLookupAnimation,
		handleLookupResultClick,
		pasteDemoList,
		importCustomList
	} = lookupUiApi;
	const {
		loadStaticData,
		exportBackup,
		exportReviewLogs,
		markFsrsOptimized,
		snoozeFsrsOptimizationReminder,
		importBackup,
		deleteAllData,
		registerServiceWorker,
		installApp
	} = backupApi;


	function renderPenaltyStatus(penalties = 0) {
		const node = $('#penaltyStatus');
		if (!node) return;

		const count = Math.max(0, Number(penalties) || 0);
		node.textContent = `Penalty points: ${count}`;
		node.classList.toggle('has-penalty', count > 0);
		node.classList.toggle('high-penalty', count >= 5);
	}

	configurePracticeCanvas({
		getSettings: () => state?.settings,
		renderCharProgress,
		setFeedbackMessage,
		playSound,
		renderPenaltyStatus
	});


	function saveState() {
		return persistState(state);
	}

	async function init() {
		initializeAudio();
		if (initialStudyIdMigrations.size) {
			await reviewLogStore.remapCardIds(initialStudyIdMigrations);
			persistState(state);
		}
		bindUI();
		registerServiceWorker();
		const [, , aliases] = await Promise.all([
			loadStaticData(),
			kanjiStore.load().catch((error) => {
				console.warn('Could not load KanjiVG study data:', error);
				return null;
			}),
			jmdictStore.getIdAliases().catch((error) => {
				console.warn('Could not load JMdict ID aliases:', error);
				return {};
			})
		]);
		const aliasMigrations = migrateJapaneseStudyIds(state, {
			jmdictAliases: aliases
		});
		if (aliasMigrations.size) {
			await reviewLogStore.remapCardIds(aliasMigrations);
			persistState(state);
		}
		await refreshReviewLogCount();
		applyDefaultListSelection();
		syncVocabularyWithEnabledLists();
		renderLists();
		renderBlacklist();
		renderSettings();
		renderProgress();
		nextCard();
		startSessionTicker();
	}

	function makeAudio(fileName) {
		const audio = new Audio(new URL(`../wav/${fileName}`, import.meta.url).href);
		audio.preload = 'auto';
		return audio;
	}

	function playAudio(audio) {
		if (!audio) return;
		audio.currentTime = 0;
		void audio.play().catch(() => {});
	}

	function playSound(name) {
		const sounds = {
			tabChange: tabChangeAudio,
			addBlacklist: addBlacklistAudio,
			restoreBlacklist: restoreBlacklistAudio,
			correctStroke: correctStrokeAudio,
			wrongStroke: wrongStrokeAudio,
			fairResult: fairResultAudio,
			repeatNext: repeatNextAudio,
			goodJob: goodJobAudio
		};
		playAudio(sounds[name]);
	}

	function playResultSound(result) {
		if (result === 3) {
			playSound('repeatNext');
			return;
		}
		if (result === 2) {
			playSound('fairResult');
			return;
		}
		playSound('goodJob');
	}

	function initializeAudio() {
		tabChangeAudio = makeAudio('tabchange.wav');
		correctStrokeAudio = makeAudio('correctstroke.wav');
		wrongStrokeAudio = makeAudio('wrongstroke.wav');
		fairResultAudio = makeAudio('fairresult.wav');
		goodJobAudio = makeAudio('goodjob.wav');
		repeatNextAudio = makeAudio('repeatnext.wav');
		restoreBlacklistAudio = makeAudio('restore.wav');
		addBlacklistAudio = makeAudio('blacklist.wav');
	}

	function blacklistMatchLabel(word) {
		const row = getEntryRow(word);
		const entry = state.vocabulary?.[word];
		const written = rowWritten(row) || entry?.written || word;
		const reading = rowReading(row) || entry?.reading || '';
		return reading ? `${written}【${reading}】` : written;
	}

	function updateBlacklistInputFeedback() {
		const input = $('#blacklistWordInput');
		const button = $('#btnBlacklistAdd');
		if (!input || !button) return;

		const value = input.value.trim();
		if (!value) {
			button.disabled = false;
			setText('#blacklistStatus', '');
			return;
		}

		const matches = resolveCanonicalWords(value);
		if (!matches.length) {
			button.disabled = true;
			setText(
				'#blacklistStatus',
				`No vocabulary entry matches “${value}”. Add it to a list first.`
			);
			return;
		}

		if (matches.length > 1) {
			button.disabled = true;
			const labels = matches.map(blacklistMatchLabel).join(', ');
			setText(
				'#blacklistStatus',
				`“${value}” matches ${matches.length} cards: ${labels}. Blacklist the intended card from Study or its list row.`
			);
			return;
		}

		button.disabled = false;
		setText(
			'#blacklistStatus',
			`Ready to blacklist ${blacklistMatchLabel(matches[0])}.`
		);
	}

	function bindUI() {
		const bind = (selector, event, handler) => {
			const node = $(selector);
			if (node) node.addEventListener(event, handler);
		};

		$$('.tabs button').forEach((button) =>
			button.addEventListener('click', () => showTab(button.dataset.tab))
		);
		bind('#btnNext', 'click', () => nextCard(true));
		bind('#btnHint', 'click', () => trainer?.hint());
		bind('#btnReveal', 'click', () => trainer?.reveal());
		bind('#btnUndo', 'click', () => trainer?.undo());

		bind('#btnGradeExcellent', 'click', () => completeCurrentCard(0));
		bind('#btnGradeGood', 'click', () => completeCurrentCard(1));
		bind('#btnGradeFair', 'click', () => completeCurrentCard(2));
		bind('#btnGradeAgain', 'click', () => completeCurrentCard(3));
		bind('#btnBlacklistCard', 'click', blacklistCurrentCard);

		bind('#btnLookup', 'click', () =>
			lookupCharacter($('#lookupInput').value.trim(), { syncInput: false })
		);
		bind('#lookupInput', 'input', (event) =>
			lookupCharacter(event.target.value.trim(), { syncInput: false })
		);
		bind('#lookupInput', 'keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			lookupCharacter(event.target.value.trim(), { syncInput: false });
		});
		bind('#lookupResult', 'click', handleLookupResultClick);
		bind('#btnPasteDemo', 'click', pasteDemoList);
		bind('#btnImportList', 'click', importCustomList);
		bind('#btnAddExtraCards', 'click', () =>
			addExtraCards(
				Number($('#extraCardCount')?.value) || DEFAULT_EXTRA_CARDS
			)
		);
		bind('#btnResetSession', 'click', () => {
			state.session = freshSession();
			stagedQueue = [];
			currentCard = null;
			saveState();
			renderProgress();
			nextCard();
		});
		bind('#btnClearProgress', 'click', async () => {
			if (
				!confirm(
					'Clear vocabulary and kanji progress? Imported lists and settings will remain.'
				)
			)
				return;
			state.vocabulary = {};
            state.kanjiMastery = {};
			state.history = [];
			const reviewLogsCleared = await clearAllReviewLogs();
			state.fsrsOptimization = defaultState().fsrsOptimization;
			backupApi?.renderFsrsOptimizationNotice?.();
			state.session = freshSession();
			stagedQueue = [];
			currentCard = null;
			syncVocabularyWithEnabledLists();
			saveState();
			renderProgress();
			nextCard();
			if (!reviewLogsCleared) {
				setText(
					'#backupStatus',
					'Vocabulary progress was cleared, but review logs could not be cleared from IndexedDB.'
				);
			}
		});

		bind('#settingRevealOrder', 'change', (e) =>
			updateSetting('revealOrder', e.target.checked)
		);
		bind('#settingShowManualGrading', 'change', (e) => {
			const showManualGrading = e.target.checked;
			if (!updateProtectedStudySetting('showManualGrading', showManualGrading)) return;
			$('#manualGradePanel')?.classList.toggle(
				'hidden',
				!showManualGrading
			);
		});
		bind('#settingShowUndoBlacklistButtons', 'change', (e) => {
			const showButtons = e.target.checked;
			if (!updateProtectedStudySetting('showUndoBlacklistButtons', showButtons)) return;
			$('#btnUndo')?.classList.toggle('hidden', !showButtons);
			$('#btnBlacklistCard')?.classList.toggle('hidden', !showButtons);
		});
		bind('#settingShowNextCardButton', 'change', (e) => {
			const showButton = e.target.checked;
			if (!updateProtectedStudySetting('showNextCardButton', showButton)) return;
			$('#btnNext')?.classList.toggle('hidden', !showButton);
		});
		bind('#btnParentLockPrimary', 'click', async () => {
			await setOrUnlockParentLock($('#parentLockPin')?.value || '');
		});
		bind('#parentLockPin', 'keydown', async (e) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			await setOrUnlockParentLock(e.target.value);
		});
		bind('#btnParentLockNow', 'click', lockParentControls);
		bind('#btnParentLockRemove', 'click', () => {
			if (!confirm('Remove the parent/teacher PIN?')) return;
			removeParentLock();
		});
		bind('#settingSnapStrokes', 'change', (e) =>
			updateSetting('snapStrokes', e.target.checked)
		);
		bind('#settingStage2KeepUserStrokes', 'change', (e) =>
			updateSetting('stage2KeepUserStrokes', e.target.checked)
		);
		bind('#settingStage3KeepUserStrokes', 'change', (e) =>
			updateSetting('stage3KeepUserStrokes', e.target.checked)
		);
		bind('#settingMaxAdds', 'change', (e) =>
			updateSetting('maxAdds', Math.max(0, Math.floor(Number(e.target.value) || 0)))
		);
		bind('#settingMaxReviews', 'change', (e) =>
			updateSetting('maxReviews', Math.max(0, Math.floor(Number(e.target.value) || 0)))
		);
		bind('#settingStudyExampleLimit', 'change', (e) => {
			const limit = Math.max(
				1,
				Math.floor(Number(e.target.value) || DEFAULT_STUDY_EXAMPLE_LIMIT)
			);
			updateSetting('studyExampleLimit', limit);
		});
		bind('#settingExamplesActiveListsOnly', 'change', (e) => {
			updateSetting('examplesActiveListsOnly', e.target.checked);
			if (currentCard)
				renderCharProgress(
					trainer?.charIndex || 0,
					currentCard?.revealedChars || 0
				);
			const lookupQuery = $('#lookupInput')?.value?.trim();
			if (lookupQuery) lookupCharacter(lookupQuery, { syncInput: false });
		});
		bind('#settingSessionHours', 'change', (e) =>
			updateSetting(
				'sessionHours',
				Math.max(
					0.02,
					Number(e.target.value) || DEFAULT_SCHEDULING.sessionHours
				)
			)
		);
		bind('#settingDesiredRetention', 'change', (e) =>
			updateSetting(
				'desiredRetention',
				clamp(Number(e.target.value) || 0.9, 0.7, 0.97)
			)
		);
		bind('#settingMaximumIntervalDays', 'change', (e) =>
			updateSetting(
				'maximumIntervalDays',
				Math.max(1, Number(e.target.value) || 36500)
			)
		);
		bind('#settingLearningStepMinutes', 'change', (e) =>
			updateSetting(
				'learningStepMinutes',
				Math.max(1, Number(e.target.value) || 10)
			)
		);
		bind('#settingRelearningStepMinutes', 'change', (e) =>
			updateSetting(
				'relearningStepMinutes',
				Math.max(1, Number(e.target.value) || 10)
			)
		);
		bind('#settingNewCardOrder', 'change', (e) =>
			updateSetting('newCardOrder', e.target.value)
		);
		bind('#settingReviewOrder', 'change', (e) =>
			updateSetting('reviewOrder', e.target.value)
		);
		bind('#settingNewCardsIgnoreReviewLimit', 'change', (e) =>
			updateSetting('newCardsIgnoreReviewLimit', e.target.checked)
		);
		bind('#settingFsrsParameters', 'change', (e) =>
			updateSetting(
				'fsrsParameters',
				normalizeFsrsParametersText(e.target.value)
			)
		);
		bind('#settingDebugNow', 'change', (e) =>
			updateDebugNow(parseDateTimeLocalSeconds(e.target.value))
		);
		bind('#btnDebugNowBrowser', 'click', () => updateDebugNow(realNow()));
		bind('#btnDebugNowClear', 'click', () => updateDebugNow(null));


		bind('#blacklistWordInput', 'input', updateBlacklistInputFeedback);
		bind('#blacklistWordInput', 'keydown', (event) => {
			if (event.key !== 'Enter') return;
			const button = $('#btnBlacklistAdd');
			if (!button || button.disabled) return;
			event.preventDefault();
			button.click();
		});


		bind('#btnBlacklistAdd', 'click', () => {
			const input = $('#blacklistWordInput');
			const value = input.value.trim();
			if (!value) return;
			const matches = resolveCanonicalWords(value);
			if (!matches.length) {
				setText(
					'#blacklistStatus',
					`No vocabulary entry matches “${value}”. Add it to a list first.`
				);
				return;
			}
			if (matches.length > 1) {
				setText(
					'#blacklistStatus',
					`“${value}” matches ${matches.length} spelling/reading cards. Blacklist the intended card from Study or its list row.`
				);
				return;
			}
			setBlacklistedWord(matches[0], true);
			playSound('addBlacklist');
			input.value = '';
			$('#btnBlacklistAdd').disabled = false;
			setText(
				'#blacklistStatus',
				`Blacklisted ${blacklistMatchLabel(matches[0])}.`
			);
			refreshVocabularyViews();
			nextCard();
		});
		bind('#btnBlacklistClear', 'click', () => {
			if (!confirm('Clear the blacklist?')) return;
			state.blacklist = {};
			saveState();
			refreshVocabularyViews();
			nextCard();
		});

		bind('#btnExport', 'click', exportBackup);
		bind('#btnExportReviewLogs', 'click', exportReviewLogs);
		bind('#btnMarkFsrsOptimized', 'click', markFsrsOptimized);
		bind(
			'#btnSnoozeFsrsOptimization',
			'click',
			snoozeFsrsOptimizationReminder
		);
		bind('#importBackup', 'change', importBackup);
		bind('#btnDeleteAllData', 'click', deleteAllData);
		bind('#btnInstallApp', 'click', installApp);
	}

	function showTab(tab) {
		if (tab !== 'settings') lockParentControls();
	playSound('tabChange');

		$$('.tabs button').forEach((button) =>
			button.classList.toggle('active', button.dataset.tab === tab)
		);

		$$('.tab-panel').forEach((panel) =>
			panel.classList.toggle('active', panel.id === `tab-${tab}`)
		);

		if (tab === 'browse') {
			const query = $('#lookupInput')?.value.trim() || '今';
			lookupCharacter(query, { syncInput: false });
		} else {
			stopLookupAnimation();
		}

		if (tab === 'progress') renderProgress();

		if (tab === 'lists') {
			renderLists();
			renderBlacklist();
		}

		if (tab === 'settings') renderSettings();
	}

	function getSessionTimeLeft() {
		resetExpiredSession();
		return Math.max(0, state.session.started + sessionDuration() - now());
	}

	function getNextScheduledReview(sets = getDueSets()) {
		const t = now();
		const candidates = sets.active
			.filter((entry) => entry.attempts && entry.next && entry.next > t)
			.sort((a, b) => a.next - b.next);
		return candidates[0] || null;
	}

	function formatDueSummary(sets = getDueSets(), left = getRemainder(sets)) {
		const parts = [];
		const staged = stagedWorkCounts();
		if (left.adds) parts.push(`${left.adds} new`);
		if (left.reviews) parts.push(`${left.reviews} review due now`);
		if (left.kanji) parts.push(`${left.kanji} kanji reviews due`);
		if (left.steps)
			parts.push(`${left.steps} learning steps due`);
		if (left.extras) parts.push(`${left.extras} extra`);
		if (staged.total)
			parts.push(
				`${staged.total} staged review${staged.total === 1 ? '' : 's'}`
			);

        const activeCharacters = new Set(sets.active.flatMap((entry) =>
            Array.from(rowWritten(getEntryRow(entry.word)) || entry.word)));
        const nextKanji = Object.values(state.kanjiMastery || {})
            .filter((entry) => activeCharacters.has(entry.kanji) &&
                Number(entry.next || 0) > now())
            .sort((a, b) => a.next - b.next)[0];
        if (nextKanji) {
            parts.push(`Next kanji: ${nextKanji.kanji} ${formatClockDuration(nextKanji.next - now())} away`);
        }
		const next = getNextScheduledReview(sets);
		if (next) {
			const wait = Math.max(0, (next.next || 0) - now());
			const displayWord = rowWritten(getEntryRow(next.word)) || next.word;
			parts.push(
				`Next review: ${displayWord} in ${formatClockDuration(wait)}`
			);
		} else if (!left.reviews && !left.steps && !left.kanji && !staged.total) {
			parts.push(
				sets.active.length
					? 'No scheduled reviews waiting'
					: 'No active words'
			);
		}

		return parts.join(' · ');
	}

	function startSessionTicker() {
		renderSessionStatus();
		setInterval(() => {
			renderSessionStatus();
			autoLoadDueCard();
		}, 1000);
	}

	function renderSessionStatus(sets = null, left = null) {
		sets = sets || getDueSets();
		left = left || getRemainder(sets);
		const timeLeft = formatDuration(getSessionTimeLeft(), true);
		const staged = stagedWorkCounts();
		const plannedCount =
			left.adds + left.reviews + left.extras + left.steps + left.kanji + staged.total;
		const stagedText = staged.total
			? ` · ${staged.total} staged`
			: '';
		const debugPrefix = debugNowSeconds() == null
			? ''
			: `DEBUG ${formatDebugClockDisplay(now())} · `;
		const text =
			`${debugPrefix}${timeLeft} left · ${plannedCount} planned${stagedText}`;
		if ($('#sessionTimeLeft')) $('#sessionTimeLeft').textContent = text;
		if ($('#sessionRemainder'))
			$('#sessionRemainder').textContent =
				`Available now: ${left.adds} new · ${left.reviews} review · ${left.kanji} kanji · ${left.extras} extra · ${left.steps} step`;
		if ($('#dueSummary'))
			$('#dueSummary').textContent = formatDueSummary(sets, left);
		
		const listsTabVisible = 
			document.querySelector('#tab-lists')?.classList.contains('active');
		if (selectedListId && listsTabVisible) {
			refreshListEditorDueText();
		}
	}



    function renderKanjiMasteryList(active) {
        const container = $('#kanjiMasteryList');
        if (!container) return;
        container.replaceChildren();
        const activeKanji = new Set(active.flatMap((entry) =>
            Array.from(rowWritten(getEntryRow(entry.word)) || entry.word)));
        const rows = Object.values(state.kanjiMastery || {})
            .filter((entry) => activeKanji.has(entry.kanji) && entry.attempts)
            .sort((a, b) => (a.next || 0) - (b.next || 0))
            .slice(0, 60);
        if (!rows.length) {
            container.textContent = 'No kanji tested yet. Finish an unaided writing stage to start tracking them.';
            return;
        }
        for (const entry of rows) {
            const row = document.createElement('div');
            row.className = 'kanji-mastery-row';
            const kanji = document.createElement('strong');
            kanji.textContent = entry.kanji;
            const success = document.createElement('span');
            success.textContent = `${entry.successes}/${entry.attempts} recalled`;
            const stability = document.createElement('span');
            stability.textContent = `${Number(entry.fsrs?.stability || 0).toFixed(1)}d stability`;
            const due = document.createElement('span');
            due.textContent = formatRelativeDue((entry.next || 0) - now());
            row.append(kanji, success, stability, due);
            container.appendChild(row);
        }
    }

	function renderProgress(
		sets = getDueSets(),
		left = getRemainder(sets)
	) {
        const mastered = sets.active.filter((x) => isMasteredEntry(x)).length;
        const kanji = kanjiMasterySummary(state.kanjiMastery, sets.active,
            (entry) => rowWritten(getEntryRow(entry.word)) || entry.word, now());
		const stats = [
			[sets.active.length, 'active words'],
			[left.adds, 'new left'],
			[left.reviews, 'reviews left'],
            [left.kanji, 'kanji drills left'],
            [kanji.studied, 'kanji tested'],
            [kanji.strong, 'strong kanji recall'],
            [kanji.due, 'kanji independently due'],
			[left.extras, 'extra left'],
			[left.steps, 'learning steps due'],
			[formatDuration(getSessionTimeLeft(), true), 'session time left'],
			[mastered, 'strong recall'],
			[Object.keys(state.blacklist || {}).length, 'blacklisted'],
			[state.history.length, 'recent attempts'],
			[reviewLogCount, 'review log rows']
		];
		const grid = $('#progressStats');
		if (grid) {
			grid.innerHTML = '';
			for (const [value, label] of stats) {
				const node =
					$('#statTemplate').content.firstElementChild.cloneNode(
						true
					);
				$('strong', node).textContent = value;
				$('span', node).textContent = label;
				grid.appendChild(node);
			}
		}
		renderKanjiMasteryList(sets.active);
		renderSessionStatus(sets, left);
	}


	window.addEventListener('DOMContentLoaded', init);
