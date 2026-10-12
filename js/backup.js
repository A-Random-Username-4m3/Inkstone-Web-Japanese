import { SAMPLE_LISTS } from './sample-data.js';
import { validateBackupPayload } from './backup-validation.js';
import { migrateJapaneseStudyIds, remapReviewLogCardIds } from './jmdict-id.js';

const FIRST_FSRS_OPTIMIZATION_LOGS = 400;
const FSRS_OPTIMIZATION_SNOOZE_DAYS = 30;
const FSRS_OPTIMIZATION_SNOOZE_MS =
	FSRS_OPTIMIZATION_SNOOZE_DAYS * 24 * 60 * 60 * 1000;

export function createBackupApi(ctx) {
	const state = ctx.liveState();
	const $ = (...args) => ctx.$(...args);
	const setText = (...args) => ctx.setText(...args);
	const parseTsvRows = (...args) => ctx.parseTsvRows(...args);
	const syncVocabularyWithEnabledLists = (...args) => ctx.syncVocabularyWithEnabledLists(...args);
	const pruneStagedState = (...args) => ctx.pruneStagedState(...args);
	const saveState = (...args) => ctx.saveState(...args);
	const renderLists = (...args) => ctx.renderLists(...args);
	const renderBlacklist = (...args) => ctx.renderBlacklist(...args);
	const renderSettings = (...args) => ctx.renderSettings(...args);
	const renderProgress = (...args) => ctx.renderProgress(...args);
	const nextCard = (...args) => ctx.nextCard(...args);
	const cancelScheduledNextCard = (...args) => ctx.cancelScheduledNextCard(...args);
	const disposeTrainer = (...args) => ctx.disposeTrainer(...args);
	const setPracticeEmptyState = (...args) => ctx.setPracticeEmptyState(...args);
	const setStudyControlsEnabled = (...args) => ctx.setStudyControlsEnabled(...args);
	const setFeedbackMessage = (...args) => ctx.setFeedbackMessage(...args);
	const mergeState = (...args) => ctx.mergeState(...args);
	const defaultState = (...args) => ctx.defaultState(...args);
	const applyDefaultListSelection = (...args) => ctx.applyDefaultListSelection(...args);
	const getAllReviewLogs = (...args) => ctx.getAllReviewLogs(...args);
	const replaceReviewLogs = (...args) => ctx.replaceReviewLogs(...args);
	const clearAllReviewLogs = (...args) => ctx.clearAllReviewLogs(...args);

	async function buildStaticData(sourceState = state) {
		const builtInListsPromise = (async () => {
			const manifest = await fetchJson(
				'data/lists.json',
				null
			);

			if (
				!manifest ||
				typeof manifest !== 'object' ||
				Array.isArray(manifest)
			) {
				return {
					lists: {},
					knownListIds: null
				};
			}

			const knownListIds = Object.keys(manifest);
			const results = await Promise.all(
				Object.entries(manifest).map(
					async ([id, meta]) => {
						try {
							const text = await fetchText(meta.path);

							return [
								id,
								{
									...meta,
									rows: parseTsvRows(text)
								}
							];
						} catch (error) {
							console.warn(
								`Could not load list ${id}:`,
								error
							);

							return null;
						}
					}
				)
			);

			return {
				lists: Object.fromEntries(
					results.filter(Boolean)
				),
				knownListIds
			};
		})();

		const loadedBuiltInData = await builtInListsPromise;

		const loadedBuiltInLists = loadedBuiltInData.lists;
		const loadedLists = Object.keys(loadedBuiltInLists).length
			? loadedBuiltInLists
			: structuredClone(SAMPLE_LISTS);
		const customListIds = [];

		for (const [id, custom] of Object.entries(
			sourceState.customLists || {}
		)) {
			loadedLists[id] = structuredClone(custom);
			customListIds.push(id);
		}

		return {
			lists: loadedLists,
			knownListIds: Array.isArray(loadedBuiltInData.knownListIds)
				? [
					...new Set([
						...loadedBuiltInData.knownListIds,
						...Object.keys(loadedLists),
						...customListIds
					])
				]
				: null
		};
	}

	async function loadStaticData() {
		const loaded = await buildStaticData(state);
		ctx.lists = loaded.lists;
		ctx.knownListIds = loaded.knownListIds;
		return loaded;
	}

	async function fetchJson(url, fallback) {
		try {
			const response = await fetch(url);
			if (!response.ok)
				throw new Error(`${response.status} ${response.statusText}`);
			return await response.json();
		} catch (error) {
			console.warn(`Using fallback for ${url}:`, error);
			return fallback;
		}
	}

	async function fetchText(url) {
		const response = await fetch(url);
		if (!response.ok)
			throw new Error(`${response.status} ${response.statusText}`);
		return await response.text();
	}

	async function exportBackup() {
		const reviewLogs = await getAllReviewLogs();
		if (!Array.isArray(reviewLogs)) {
			setText(
				'#backupStatus',
				'Backup export failed: review logs could not be read from IndexedDB. Try again before relying on a backup.'
			);
			return;
		}
		const backupState = JSON.parse(JSON.stringify(ctx.state));
		backupState.reviewLogs = reviewLogs;
		const backup = {
			app: ctx.APP_VERSION,
			exportedAt: new Date().toISOString(),
			state: backupState
		};
		const blob = new Blob([JSON.stringify(backup, null, 2)], {
			type: 'application/json'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `inkstone-static-backup-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setText('#backupStatus', 'Backup exported.');
	}



	function csvCell(value) {
		if (value === null || value === undefined) return '';
		const text = String(value);
		return /[",\n\r]/.test(text)
			? `"${text.replaceAll('"', '""')}"`
			: text;
	}


	function ensureFsrsOptimizationState() {
		if (
			!state.fsrsOptimization ||
			typeof state.fsrsOptimization !== 'object'
		) {
			state.fsrsOptimization = {};
		}
		const data = state.fsrsOptimization;
		const lastOptimizedAt = Number(data.lastOptimizedAt);
		const lastOptimizedReviewCount = Number(
			data.lastOptimizedReviewCount
		);
		const reminderSnoozedUntil = Number(data.reminderSnoozedUntil);
		const nextOptimizationReviewCount = Number(
			data.nextOptimizationReviewCount
		);
		data.lastOptimizedAt =
			Number.isFinite(lastOptimizedAt) && lastOptimizedAt > 0
				? Math.floor(lastOptimizedAt)
				: null;
		data.lastOptimizedReviewCount =
			Number.isFinite(lastOptimizedReviewCount) &&
			lastOptimizedReviewCount > 0
				? Math.floor(lastOptimizedReviewCount)
				: 0;
		data.reminderSnoozedUntil =
			Number.isFinite(reminderSnoozedUntil) && reminderSnoozedUntil > 0
				? Math.floor(reminderSnoozedUntil)
				: null;
		data.nextOptimizationReviewCount =
			Number.isFinite(nextOptimizationReviewCount) &&
				nextOptimizationReviewCount > 0
				? Math.floor(nextOptimizationReviewCount)
				: null;
		if (
			data.lastOptimizedReviewCount > 0 &&
			(!data.nextOptimizationReviewCount ||
				data.nextOptimizationReviewCount <= data.lastOptimizedReviewCount)
		) {
			data.nextOptimizationReviewCount = Math.max(
				FIRST_FSRS_OPTIMIZATION_LOGS,
				data.lastOptimizedReviewCount * 2
			);
		}
		return data;
	}

	function reviewLogCount() {
		return Math.max(0, Math.floor(Number(ctx.reviewLogCount) || 0));
	}

	function nextFsrsOptimizationReviewCount() {
		const data = ensureFsrsOptimizationState();
		return Math.max(
			FIRST_FSRS_OPTIMIZATION_LOGS,
			Math.floor(Number(data.nextOptimizationReviewCount) || 0)
		);
	}

	function formatLocalDate(ms) {
		if (!ms) return 'never';
		return new Date(ms).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function fsrsOptimizationReminderDue() {
		const data = ensureFsrsOptimizationState();
		const count = reviewLogCount();
		const nextCount = nextFsrsOptimizationReviewCount();
		const snoozedUntil = Number(data.reminderSnoozedUntil) || 0;
		const snoozed = snoozedUntil > Date.now();
		return {
			count,
			nextCount,
			due: count >= nextCount && !snoozed,
			snoozed,
			snoozedUntil,
			lastOptimizedAt: data.lastOptimizedAt,
			lastOptimizedReviewCount: data.lastOptimizedReviewCount
		};
	}

	function renderFsrsOptimizationNotice() {
		const status = $('#fsrsOptimizationStatus');
		const reminder = $('#fsrsOptimizationReminder');
		const markButton = $('#btnMarkFsrsOptimized');
		const snoozeButton = $('#btnSnoozeFsrsOptimization');
		if (!status || !reminder) return;

		const info = fsrsOptimizationReminderDue();
		const remaining = Math.max(0, info.nextCount - info.count);
		if (info.due) {
			status.textContent =
				`You have ${info.count} review-log rows. FSRS ` +
				'parameters may benefit from re-optimization.';
			reminder.classList.remove('hidden');
		} else {
			if (info.snoozed) {
				status.textContent =
					`${info.count} review-log rows stored. Reminder snoozed ` +
					`until ${formatLocalDate(info.snoozedUntil)}. ` +
					`Current optimization threshold: ${info.nextCount} rows.`;
			} else {
				status.textContent =
					`${info.count} review-log rows stored. Next optimization ` +
					`reminder at ${info.nextCount} rows` +
					(remaining ? ` (${remaining} more).` : '.');
			}
			reminder.classList.add('hidden');
		}

		const lastOptimized = $('#fsrsLastOptimized');
		if (lastOptimized) {
			lastOptimized.textContent = info.lastOptimizedAt
				? `Last marked optimized: ${formatLocalDate(info.lastOptimizedAt)} ` +
					`at ${info.lastOptimizedReviewCount} rows.`
				: 'Last marked optimized: never.';
		}
		if (markButton) markButton.disabled = info.count === 0;
		if (snoozeButton)
			snoozeButton.disabled = info.count < info.nextCount || info.snoozed;
	}

	function markFsrsOptimized() {
		const data = ensureFsrsOptimizationState();
		const count = reviewLogCount();
		if (!count) {
			setText('#backupStatus', 'No review logs to mark as optimized yet.');
			return;
		}
		data.lastOptimizedAt = Date.now();
		data.lastOptimizedReviewCount = count;
		data.nextOptimizationReviewCount = Math.max(
			FIRST_FSRS_OPTIMIZATION_LOGS,
			count < FIRST_FSRS_OPTIMIZATION_LOGS
				? FIRST_FSRS_OPTIMIZATION_LOGS
				: count * 2
		);
		data.reminderSnoozedUntil = null;
		saveState();
		renderFsrsOptimizationNotice();
		setText(
			'#backupStatus',
			`FSRS optimization marked at ${count} review-log rows.`
		);
	}

	function snoozeFsrsOptimizationReminder() {
		const data = ensureFsrsOptimizationState();
		const info = fsrsOptimizationReminderDue();
		if (info.count < info.nextCount) {
			setText(
				'#backupStatus',
				`Next FSRS optimization reminder starts at ${info.nextCount} rows.`
			);
			return;
		}
		if (info.snoozed) {
			setText(
				'#backupStatus',
				`FSRS optimization reminder is already snoozed until ` +
					`${formatLocalDate(info.snoozedUntil)}.`
			);
			return;
		}
		data.reminderSnoozedUntil = Date.now() + FSRS_OPTIMIZATION_SNOOZE_MS;
		saveState();
		renderFsrsOptimizationNotice();
		setText(
			'#backupStatus',
			`FSRS optimization reminder snoozed for ` +
				`${FSRS_OPTIMIZATION_SNOOZE_DAYS} days.`
		);
	}

	async function exportReviewLogs() {
		const logs = await getAllReviewLogs();
		if (!Array.isArray(logs)) {
			setText(
				'#backupStatus',
				'Review-log export failed: logs could not be read from IndexedDB. Try again before using optimizer data.'
			);
			return;
		}
		const fields = [
			'card_id',
			'review_time',
			'review_rating',
			'review_state'
		];
		const rows = [
			fields.join(','),
			...logs.map((log) =>
				fields.map((field) => csvCell(log[field])).join(',')
			)
		];
		const blob = new Blob([`${rows.join('\n')}\n`], {
			type: 'text/csv;charset=utf-8'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `inkstone-review-logs-${new Date().toISOString().slice(0, 10)}.csv`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setText(
			'#backupStatus',
			`Review logs exported (${logs.length} rows). Use the CSV with ` +
				'an FSRS optimizer, then paste the optimized parameters into ' +
				'Advanced FSRS parameters.'
		);
	}

	function importBackup(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		cancelScheduledNextCard();
		const reader = new FileReader();
		reader.onload = async () => {
			let previousReviewLogs = null;
			let reviewLogsWereReplaced = false;
			const previous = {
				state: ctx.state,
				lists: ctx.lists,
				knownListIds: ctx.knownListIds,
				currentCard: ctx.currentCard,
				selectedListId: ctx.selectedListId,
				listEditorDrafts: ctx.listEditorDrafts,
				stagedQueue: ctx.stagedQueue
			};

			try {
				const parsed = JSON.parse(reader.result);
				const validated = validateBackupPayload(parsed);
				const importedState = mergeState(
					defaultState(),
					validated.state
				);
				const studyIdMigrations = migrateJapaneseStudyIds(importedState, {
					jmdictAliases: ctx.jmdictAliases || {}
				});
				const importedReviewLogs = validated.hasReviewLogs
					? remapReviewLogCardIds(validated.reviewLogs, studyIdMigrations)
					: null;
				const loaded = await buildStaticData(importedState);

				if (validated.hasReviewLogs) {
					previousReviewLogs = await getAllReviewLogs();
					if (!Array.isArray(previousReviewLogs)) {
						throw new Error(
							'Existing review logs could not be read, so the import was cancelled.'
						);
					}
				}

				ctx.state = importedState;
						ctx.lists = loaded.lists;
				ctx.knownListIds = loaded.knownListIds;
				ctx.currentCard = null;
				ctx.selectedListId = null;
				ctx.listEditorDrafts = {};
				ctx.stagedQueue = Array.isArray(importedState.session?.stageQueue)
					? importedState.session.stageQueue.slice()
					: [];

				applyDefaultListSelection();
				syncVocabularyWithEnabledLists({ save: false });
				pruneStagedState();

				if (validated.hasReviewLogs) {
					const result = await replaceReviewLogs(importedReviewLogs);
					reviewLogsWereReplaced = result.ok;
					if (
						!result.ok ||
						result.restoredCount !== importedReviewLogs.length
					) {
						throw new Error(
							'Review logs could not be restored completely.'
						);
					}
				}

				if (!saveState()) {
					throw new Error('Imported state could not be saved.');
				}

				disposeTrainer();
				setPracticeEmptyState(true);
				setStudyControlsEnabled(false);
				renderLists();
				renderBlacklist();
				renderSettings();
				renderProgress();
				nextCard();
				setText(
					'#backupStatus',
					validated.hasReviewLogs
						? 'Backup imported.'
						: 'Backup imported. It did not include review logs, so existing review logs were preserved.'
				);
			} catch (error) {
				ctx.state = previous.state;
				ctx.lists = previous.lists;
				ctx.knownListIds = previous.knownListIds;
				ctx.currentCard = previous.currentCard;
				ctx.selectedListId = previous.selectedListId;
				ctx.listEditorDrafts = previous.listEditorDrafts;
				ctx.stagedQueue = previous.stagedQueue;

				let rollbackWarning = '';
				if (reviewLogsWereReplaced && previousReviewLogs) {
					const rollback = await replaceReviewLogs(previousReviewLogs);
					if (!rollback.ok) {
						rollbackWarning =
							' Review-log rollback also failed; restore a known-good backup before continuing.';
					}
				}
				saveState();
				setText(
					'#backupStatus',
					`Import failed: ${error.message} Existing data was kept.${rollbackWarning}`
				);
			}
		};
		reader.onloadend = () => {
			event.target.value = '';
		};
		reader.readAsText(file);
	}

	async function deleteAllData() {
		const first = confirm(
			'Delete all Inkstone data on this device? This' +
				' removes progress, custom lists, settings, blacklist, session data, history, and review logs.'
		);
		if (!first) return;
		const second = confirm(
			'This cannot be undone. Export a backup first if you may want ' +
				'to restore later. Delete everything now?'
		);
		if (!second) return;
		cancelScheduledNextCard();
		localStorage.removeItem(ctx.STORAGE_KEY);
		const reviewLogsCleared = await clearAllReviewLogs();
		ctx.state = defaultState();
		disposeTrainer();
		setPracticeEmptyState(true);
		setStudyControlsEnabled(false);
		ctx.selectedListId = null;
		ctx.listEditorDrafts = {};
		ctx.stagedQueue = [];
		ctx.currentCard = null;
		loadStaticData().then(() => {
			syncVocabularyWithEnabledLists();
			renderLists();
			renderBlacklist();
			renderSettings();
			renderProgress();
			nextCard();
			setText(
				'#backupStatus',
				reviewLogsCleared
					? 'All local Inkstone data was deleted. Fresh defaults loaded.'
					: 'Local Inkstone data was deleted, but review logs could not be cleared from IndexedDB.'
			);
		});
	}

	let deferredInstallPrompt = null;

	function registerServiceWorker() {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker
				.register('sw.js')
				.catch((error) =>
					console.warn('Service worker registration failed:', error)
				);
		}
		window.addEventListener('beforeinstallprompt', (event) => {
			event.preventDefault();
			deferredInstallPrompt = event;
			const button = $('#btnInstallApp');
			if (button) button.hidden = false;
		});
		window.addEventListener('appinstalled', () => {
			deferredInstallPrompt = null;
			const button = $('#btnInstallApp');
			if (button) button.hidden = true;
		});
	}

	async function installApp() {
		if (!deferredInstallPrompt) {
			const message =
				'Install is available from your browser menu once the app is' +
				' served over HTTPS or localhost.';
			if ($('#feedback')) setFeedbackMessage(message, 'info');
			else setText('#backupStatus', message);
			return;
		}
		deferredInstallPrompt.prompt();
		await deferredInstallPrompt.userChoice.catch(() => null);
		deferredInstallPrompt = null;
		const button = $('#btnInstallApp');
		if (button) button.hidden = true;
	}

	return {
		loadStaticData,
		exportBackup,
		exportReviewLogs,
		renderFsrsOptimizationNotice,
		markFsrsOptimized,
		snoozeFsrsOptimizationReminder,
		importBackup,
		deleteAllData,
		registerServiceWorker,
		installApp
	};
}
