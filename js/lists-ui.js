import { ONE_DAY, MASTERED_STABILITY_DAYS } from './constants.js';
import { cssEscape } from './dom-utils.js';
import {
	rowCanonicalWord,
	rowDefinition,
	rowReading,
	rowWritten,
	rowWords
} from './word-data.js';
import {
	ensureFsrsState,
	getEntrySchedulerState,
	setEntrySchedulerState,
	getFsrsRetrievability,
	fsrsIntervalSeconds,
	fsrsDesiredRetention
} from './fsrs.js';

export function removeCustomListRowByIndex(state, lists, listId, sourceIndex) {
	const list = state?.customLists?.[listId];
	if (
		!list ||
		!Array.isArray(list.rows) ||
		!Number.isInteger(sourceIndex) ||
		sourceIndex < 0 ||
		sourceIndex >= list.rows.length
	) return null;

	const [removedRow] = list.rows.splice(sourceIndex, 1);
	lists[listId] = list;
	return removedRow || null;
}


export function removeCustomListPreservingProgress(
	state,
	lists,
	listId,
	reconcileMemberships = null
) {
	const list = state?.customLists?.[listId];
	if (!list) return null;
	const rows = Array.isArray(list.rows) ? list.rows.slice() : [];
	delete state.customLists[listId];
	delete lists[listId];
	delete state.enabledLists?.[listId];
	reconcileMemberships?.();
	return rows;
}


export function createListsUi(ctx) {
	const state = ctx.liveState();
	const lists = ctx.liveLists();
	const $ = (...args) => ctx.$(...args);
	const now = (...args) => ctx.now(...args);
	const escapeHtml = (...args) => ctx.escapeHtml(...args);
	const formatRelativeDue = (...args) => ctx.formatRelativeDue(...args);
	const canStudyWord = (...args) => ctx.canStudyWord(...args);
	const syncSelectedListForEnabledLists = (...args) => ctx.syncSelectedListForEnabledLists(...args);
	const syncVocabularyWithEnabledLists = (...args) => ctx.syncVocabularyWithEnabledLists(...args);
	const ensureVocabularyEntry = (...args) => ctx.ensureVocabularyEntry(...args);
	const getEntryRow = (...args) => ctx.getEntryRow(...args);
	const resolveCanonicalWord = (...args) =>
		ctx.resolveCanonicalWord?.(...args) ?? String(args[0] || '').trim();
	const clearExternalWordStudyState = (...args) => ctx.clearExternalWordStudyState(...args);
	const pruneStagedState = (...args) => ctx.pruneStagedState(...args);
	const isWordQueuedForStage = (...args) => ctx.isWordQueuedForStage(...args);
	const saveState = (...args) => ctx.saveState(...args);
	const renderProgress = (...args) => ctx.renderProgress(...args);
	const refreshStudyAfterExternalChange = (...args) => ctx.refreshStudyAfterExternalChange(...args);
	const isMasteredEntry = (...args) => ctx.isMasteredEntry(...args);
	const clearReviewLogsForCards = (...args) =>
		ctx.clearReviewLogsForCards?.(...args) ?? Promise.resolve(0);
	const normalizeBlacklist = (...args) => ctx.normalizeBlacklist(...args);
	const learningStepInterval = (...args) => ctx.learningStepInterval(...args);
	const relearningStepInterval = (...args) => ctx.relearningStepInterval(...args);
	const nextCard = (...args) => ctx.nextCard(...args);
	const playSound = (...args) => ctx.playSound?.(...args);
	const LIST_EDITOR_OVERSCAN_ROWS = 6;
	let listEditorSearchListId = null;
	let listEditorSearchQuery = '';
	let listEditorRenderFrame = 0;
	const listEditorScrollPositions = new Map();
	function blacklistKeysForWord(word, row = null) {
		const canonical = resolveCanonicalWord(word);
		const keys = new Set([String(word || '').trim(), canonical].filter(Boolean));
		for (const key of rowWords(row || getEntryRow(canonical) || getEntryRow(word))) {
			if (key) keys.add(key);
		}
		return [...keys];
	}


	function setBlacklistedWord(word, blacklisted, row = null, { save = true } = {}) {
		state.blacklist = normalizeBlacklist(state.blacklist || {});
		const canonical = resolveCanonicalWord(word);
		const data = row || getEntryRow(canonical) || getEntryRow(word);
		for (const key of blacklistKeysForWord(word, data)) {
			delete state.blacklist[key];
		}
		if (blacklisted && canonical) {
			state.blacklist[canonical] = {
				word: canonical,
				reading: rowReading(data),
				definition: rowDefinition(data)
			};
			clearExternalWordStudyState(canonical);
		}
		if (save) saveState();
	}


	function refreshVocabularyViews() {
		renderLists();
		renderBlacklist();
		renderProgress();
	}



	function setText(selector, text) {
		const node = $(selector);
		if (node) node.textContent = text;
	}


	function normalizeJapaneseSearch(value) {
		return Array.from(String(value || '').normalize('NFKC').toLowerCase())
			.map((character) => {
				const code = character.codePointAt(0);
				return code >= 0x30a1 && code <= 0x30f6
					? String.fromCodePoint(code - 0x60)
					: character;
			})
			.join('')
			.replace(/[\s・･.,。、！？!?()（）「」『』【】]/g, '');
	}


	function createListEditorSearchRecord(row, sourceIndex) {
		return {
			row,
			sourceIndex,
			words: rowWords(row).map((word) =>
				String(word || '').toLowerCase()
			),
			reading: normalizeJapaneseSearch(rowReading(row))
		};
	}


	function filterListEditorRecords(records, query) {
		const rawQuery = String(query || '').trim();
		if (!rawQuery) return records;

		const wordQuery = rawQuery
			.toLowerCase()
			.replace(/\s+/g, '');
		const readingQuery = normalizeJapaneseSearch(rawQuery);

		return records.filter((record) =>
			record.words.some((word) =>
				word.replace(/\s+/g, '').includes(wordQuery)
			) ||
			(Boolean(readingQuery) && record.reading.includes(readingQuery))
		);
	}



	function listEditorScrollKey(
		listId = listEditorSearchListId,
		query = listEditorSearchQuery
	) {
		return `${listId || ''}\u0000${query || ''}`;
	}


	function getListEditorRowHeight(body) {
		const cssValue = Number.parseFloat(
			getComputedStyle(body).getPropertyValue(
				'--word-editor-row-height'
			)
		);
		return Number.isFinite(cssValue) && cssValue > 0
			? cssValue
			: 54;
	}


	function renderLists() {
		const container = $('#listContainer');
		if (!container) return;
		syncSelectedListForEnabledLists();
		container.innerHTML = '';
		for (const [id, list] of Object.entries(lists)) {
			const enabled = !!state.enabledLists[id];
			const studyable = (list.rows || []).filter((row) =>
				canStudyWord(rowWritten(row))
			).length;
			const row = document.createElement('div');
			row.className = `list-row selectable-list-row${ctx.selectedListId === id ? ' selected' : ''}`;
			row.innerHTML = `
				<input type="checkbox" ${enabled ? 'checked' : ''}
					aria-label="Enable ${escapeHtml(list.name)}">
				<div>
					<strong>${escapeHtml(list.name)}</strong>
					<small>
						${escapeHtml(list.category || 'List')} ·
						${studyable}/${(list.rows || []).length} rows studyable ·
						${ctx.selectedListId === id ? (enabled ? 'viewing · enabled for study' : 'viewing · disabled') : (enabled ? 'enabled for study' : 'disabled')}
					</small>
				</div>
				<button type="button" class="list-delete">
					${state.customLists[id] ? 'Delete' : 'Built in'}
				</button>`;
			row.addEventListener('click', (event) => {
				if (
					event.target instanceof Element &&
					event.target.closest('input, button, label')
				) return;
				ctx.selectedListId = id;
				renderLists();
			});
			const checkbox = $('input', row);
			checkbox.addEventListener('change', () => {
				state.enabledLists[id] = checkbox.checked;
				if (checkbox.checked && !ctx.selectedListId) ctx.selectedListId = id;
				syncSelectedListForEnabledLists();
				syncVocabularyWithEnabledLists();
				pruneStagedState();
				saveState();
				renderLists();
				renderProgress();
				if (!ctx.currentCard) nextCard();
			});
			const button = $('button', row);
			button.disabled = !state.customLists[id];
			button.addEventListener('click', () => {
				if (
					!state.customLists[id] ||
					!confirm(`Delete imported list ${list.name}? Study progress will be kept.`)
				)
					return;
				const listRows = removeCustomListPreservingProgress(
					state,
					lists,
					id,
					() => syncVocabularyWithEnabledLists({ save: false })
				) || [];
				for (const row of listRows) {
					const word = rowCanonicalWord(row);
					if (!word || (state.vocabulary[word]?.lists || []).some(
						(listId) => !!state.enabledLists[listId] && !!lists[listId]
					)) continue;
					clearExternalWordStudyState(word);
				}
				if (ctx.selectedListId === id) ctx.selectedListId = null;
				pruneStagedState();
				saveState();
				renderLists();
				renderListEditor();
				renderBlacklist();
				renderProgress();
				if (!ctx.currentCard) nextCard();
			});
			container.appendChild(row);
		}
		const listsTabVisible =
			$('#tab-lists')?.classList.contains('active');

		if (listsTabVisible) {
			renderListEditor(false);
		}
	}



	function refreshListEditorAfterAction(statusMessage = '') {
		renderListEditor();
		if (statusMessage) setText('#listEditorStatus', statusMessage);
		renderBlacklist();
		renderProgress();
		refreshStudyAfterExternalChange();
	}


	function renderListEditor(scrollIntoView = false) {
		const panel = $('#listWordEditor');
		if (!panel) return;

		if (listEditorRenderFrame) {
			cancelAnimationFrame(listEditorRenderFrame);
			listEditorRenderFrame = 0;
		}
		panel.oninput = null;
		panel.onkeydown = null;
		panel.onchange = null;
		panel.onclick = null;

		const previousBody = panel.querySelector('.word-editor-body');
		const previousScrollTop = previousBody?.scrollTop || 0;
		const previousScrollLeft = previousBody?.scrollLeft || 0;
		if (previousBody && listEditorSearchListId) {
			listEditorScrollPositions.set(
				listEditorScrollKey(),
				previousScrollTop
			);
		}

		captureListEditorDrafts(panel);
		syncSelectedListForEnabledLists();
		const card = panel.closest('.card');
		if (!ctx.selectedListId || !lists[ctx.selectedListId]) {
			if (card) card.classList.add('hidden');
			panel.innerHTML =
				'<p class="feedback">Select a word list row to inspect its words. Use the checkbox to enable lists for study.</p>';
			return;
		}
		if (card) card.classList.remove('hidden');

		const listId = ctx.selectedListId;
		const listChanged = listEditorSearchListId !== listId;
		if (listChanged) {
			listEditorSearchListId = listId;
			listEditorSearchQuery = '';
		}

		const list = lists[listId];
		const rows = list.rows || [];
		const searchRecords = rows.map(createListEditorSearchRecord);
		let filteredRecords = filterListEditorRecords(
			searchRecords,
			listEditorSearchQuery
		);
		const studyableCount = rows.filter((row) =>
			canStudyWord(rowWritten(row))
		).length;
		const enabled = !!state.enabledLists[listId];

		panel.innerHTML = `
			<div class="list-editor-header">
				<div>
					<h3>${escapeHtml(list.name)}</h3>
					<p>
						${escapeHtml(list.category || 'List')} ·
						${studyableCount}/${rows.length} studyable ·
						${enabled ? 'enabled' : 'disabled'}
					</p>
				</div>
				<div class="button-row compact">
					<button type="button" data-list-action="due-all">Make scheduled/step words due now</button>
					<button type="button" data-list-action="reset-list">Reset list progress</button>
				</div>
			</div>
			<label class="list-editor-search">
				<span>Search words</span>
				<input
					type="search"
					data-list-search
					value="${escapeHtml(listEditorSearchQuery)}"
					placeholder="Word or kana reading"
					autocomplete="off"
					spellcheck="false">
				<small data-list-search-count aria-live="polite"></small>
			</label>
			<p id="listEditorStatus" class="feedback list-editor-status">
				Use this developer view to inspect FSRS state, due times, and per-word progress.
			</p>
			<div class="word-editor-table" role="table" aria-label="Words in ${escapeHtml(list.name)}">
				<div class="word-editor-row word-editor-head" role="row">
					<span>Word</span><span>Status</span><span>Next review</span><span>FSRS</span><span>Stats</span><span>Actions</span>
				</div>
				<div class="word-editor-body" tabindex="0">
					<div class="word-editor-virtual-spacer">
						<div class="word-editor-visible-rows"></div>
					</div>
				</div>
			</div>
		`;

		const body = panel.querySelector('.word-editor-body');
		const spacer = panel.querySelector('.word-editor-virtual-spacer');
		const visibleRows = panel.querySelector('.word-editor-visible-rows');
		const searchInput = panel.querySelector('[data-list-search]');
		const searchCount = panel.querySelector('[data-list-search-count]');
		const rowHeight = getListEditorRowHeight(body);
		let renderedStart = -1;
		let renderedEnd = -1;

		function syncVirtualSpacerHeight() {
			if (!spacer) return;
			spacer.style.height = `${Math.max(
				rowHeight,
				filteredRecords.length * rowHeight
			)}px`;
		}

		function renderVisibleRows(force = false) {
			if (!body || !spacer || !visibleRows) return;
			syncVirtualSpacerHeight();
			const viewportHeight = body.clientHeight || 470;
			const firstVisible = Math.floor(body.scrollTop / rowHeight);
			const start = Math.max(
				0,
				firstVisible - LIST_EDITOR_OVERSCAN_ROWS
			);
			const visibleCount = Math.ceil(viewportHeight / rowHeight);
			const end = Math.min(
				filteredRecords.length,
				start + visibleCount + LIST_EDITOR_OVERSCAN_ROWS * 2
			);

			if (force || start !== renderedStart || end !== renderedEnd) {
				captureListEditorDrafts(visibleRows);
				renderedStart = start;
				renderedEnd = end;
				visibleRows.dataset.start = String(start);
				visibleRows.style.transform =
					`translateY(${start * rowHeight}px)`;
				visibleRows.innerHTML = filteredRecords.length
					? filteredRecords
						.slice(start, end)
						.map(({ row, sourceIndex }, visibleIndex) =>
							renderWordEditorRow(
								row,
								listId,
								start + visibleIndex,
								sourceIndex
							)
						)
						.join('')
					: '<p class="feedback word-editor-empty">No matching words.</p>';
			}

			if (searchCount) {
				const first = filteredRecords.length ? start + 1 : 0;
				const last = filteredRecords.length ? end : 0;
				searchCount.textContent = listEditorSearchQuery.trim()
					? `Showing ${first}–${last} of ${filteredRecords.length} matches · ${rows.length} total`
					: `Showing ${first}–${last} of ${rows.length} words`;
			}
		}

		function scheduleVisibleRowsRender() {
			if (listEditorRenderFrame) return;
			listEditorRenderFrame = requestAnimationFrame(() => {
				listEditorRenderFrame = 0;
				renderVisibleRows();
			});
		}

		body?.addEventListener('scroll', () => {
			listEditorScrollPositions.set(
				listEditorScrollKey(listId, listEditorSearchQuery),
				body.scrollTop
			);
			scheduleVisibleRowsRender();
		}, { passive: true });

		panel.oninput = (event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement)) return;

			if (target.matches('[data-list-search]')) {
				listEditorSearchQuery = target.value;
				filteredRecords = filterListEditorRecords(
					searchRecords,
					listEditorSearchQuery
				);
				renderedStart = -1;
				renderedEnd = -1;
				syncVirtualSpacerHeight();
				listEditorScrollPositions.set(
					listEditorScrollKey(listId, listEditorSearchQuery),
					0
				);
				if (body) body.scrollTop = 0;
				renderVisibleRows(true);
				return;
			}

			if (target.matches('[data-next-value]')) {
				saveListEditorDraft(target.dataset.word, listId);
			}
		};

		panel.onkeydown = (event) => {
			const target = event.target;
			if (
				event.key === 'Enter' &&
				target instanceof HTMLInputElement &&
				target.matches('[data-next-value]')
			) {
				setNextReviewFromControls(target.dataset.word, listId);
			}
		};

		panel.onchange = async (event) => {
			const target = event.target;
			if (!(target instanceof HTMLSelectElement)) return;

			if (target.matches('[data-next-unit]')) {
				saveListEditorDraft(target.dataset.word, listId);
				return;
			}

			if (!target.matches('[data-word-status]')) return;
			const word = target.dataset.word;
			const wasBlacklisted = !!state.blacklist[word];
			const nextStatus = target.value;
			const statusMessage = await updateWordLearningStatus(
				word,
				listId,
				nextStatus
			);
			if (!statusMessage) {
				if (nextStatus === 'blacklisted' && !wasBlacklisted)
					playSound('addBlacklist');
				if (nextStatus !== 'blacklisted' && wasBlacklisted)
					playSound('restoreBlacklist');
			}
			refreshListEditorAfterAction(statusMessage);
		};

		panel.onclick = async (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const button = target.closest('button');
			if (!button || !panel.contains(button)) return;

			if (button.matches('[data-word-action]')) {
				const word = button.dataset.word;
				const action = button.dataset.wordAction;
				if (action === 'remove-from-list') {
					const sourceIndex = Number.parseInt(
						button.dataset.rowIndex || '',
						10
					);
					const sourceRow = state.customLists[listId]?.rows?.[sourceIndex];
					if (!sourceRow) return;
					const displayWord = rowWritten(sourceRow) || word;
					const listName = lists[listId]?.name || listId;
					if (!confirm(`Remove ${displayWord} from ${listName}? Study progress will be kept.`))
						return;

					const removedRow = removeCustomListRowByIndex(
						state,
						lists,
						listId,
						sourceIndex
					);
					if (!removedRow) return;

					syncVocabularyWithEnabledLists({ save: false });
					const stillEnabled = (state.vocabulary[word]?.lists || []).some(
						(id) => !!state.enabledLists[id] && !!lists[id]
					);
					if (!stillEnabled) clearExternalWordStudyState(word);
					pruneStagedState();
					saveState();
					renderLists();
					renderBlacklist();
					renderProgress();
					refreshStudyAfterExternalChange();
					setText(
						'#listEditorStatus',
						`Removed ${displayWord} from ${listName}. Study progress was kept.`
					);
					return;
				}
				if (action === 'set-next')
					setNextReviewFromControls(word, listId);
				if (action === 'due-now') setWordDueNow(word, listId);
				if (action === 'tomorrow')
					setWordNext(word, listId, ONE_DAY);
				if (action === 'reset')
					await resetWordProgress(word);
				if (action === 'blacklist') {
					const shouldBlacklist = !state.blacklist[word];
					setBlacklistedWord(word, shouldBlacklist, getEntryRow(word));
					playSound(
						shouldBlacklist ? 'addBlacklist' : 'restoreBlacklist'
					);
				}
				refreshListEditorAfterAction();
				return;
			}

			if (!button.matches('[data-list-action]')) return;
			const action = button.dataset.listAction;
			let statusMessage = '';
			if (action === 'due-all') {
				const changed = makeListDueNow(listId);
				statusMessage = changed
					? `${changed} scheduled/step word${changed === 1 ? '' : 's'} made due now.`
					: 'No scheduled review or step words in this list.';
			}
			if (action === 'reset-list')
				statusMessage = await resetListProgress(listId);
			refreshListEditorAfterAction(statusMessage);
		};

		syncVirtualSpacerHeight();
		if (body) {
			const savedScrollTop = listEditorScrollPositions.get(
				listEditorScrollKey(listId, listEditorSearchQuery)
			);
			const requestedScrollTop = scrollIntoView || listChanged
				? 0
				: savedScrollTop ?? previousScrollTop;
			const maximumScrollTop = Math.max(
				0,
				filteredRecords.length * rowHeight - body.clientHeight
			);
			body.scrollTop = Math.min(
				maximumScrollTop,
				Math.max(0, requestedScrollTop)
			);
		}
		renderVisibleRows(true);
		if (body) body.scrollLeft = previousScrollLeft;

		if (scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
		if (scrollIntoView) searchInput?.focus({ preventScroll: true });
	}


	function renderWordEditorRow(row, listId, virtualIndex = null, sourceIndex = null) {
		const word = rowCanonicalWord(row);
		const displayWord = rowWritten(row) || word;
		const studyable = canStudyWord(displayWord);
		const entry = state.vocabulary[word];
		const status = getWordLearningStatus(word);
		const dueText = getWordDueText(word);
		const attempts = entry?.attempts || 0;
		const successes = entry?.successes || 0;
		const pct = attempts
			? `${Math.round((100 * successes) / attempts)}%`
			: '—';
		const fsrsDebug = getWordFsrsDebugHtml(word);
		const disabled = studyable ? '' : ' disabled';
		const draft = getListEditorDraft(word, listId);
		const showNextControls =
			studyable && isWordScheduledForLater(word);
		const nextReviewControls = showNextControls
			? `
					<div class="inline-mini">
						<input type="number" min="0"
							value="${escapeHtml(draft.value)}" data-next-value
							data-word="${escapeHtml(word)}"${disabled}>
						<select data-next-unit data-word="${escapeHtml(word)}"${disabled}>
							${unitOption('minutes', 'min', draft.unit)}
							${unitOption('hours', 'hr', draft.unit)}
							${unitOption('days', 'day', draft.unit)}
						</select>
						<button type="button" data-word-action="set-next" data-word="${escapeHtml(word)}"${disabled}>Set</button>
					</div>`
			: `<span class="timer-not-applicable" aria-hidden="true"></span>`;
		const scheduleActions = showNextControls
			? `
					<button type="button" data-word-action="due-now" data-word="${escapeHtml(word)}"${disabled}>Due now</button>
					<button type="button" data-word-action="tomorrow" data-word="${escapeHtml(word)}"${disabled}>+1 day</button>`
			: '';
		const wordActions =
			status === 'blacklisted'
				? `
					<button type="button" data-word-action="blacklist" data-word="${escapeHtml(word)}">Restore</button>`
				: `
					${scheduleActions}
					<button type="button" data-word-action="reset" data-word="${escapeHtml(word)}"${disabled}>Reset</button>
					<button type="button" data-word-action="blacklist" data-word="${escapeHtml(word)}"${disabled}>Blacklist</button>`;
		const removeFromListAction =
			state.customLists[listId] && Number.isInteger(sourceIndex)
				? `<button type="button" data-word-action="remove-from-list" data-word="${escapeHtml(word)}" data-row-index="${sourceIndex}">Remove</button>`
				: '';
		const virtualIndexAttribute = Number.isInteger(virtualIndex)
			? ` data-virtual-index="${virtualIndex}"`
			: '';
		return `
			<div class="word-editor-row status-${escapeHtml(status)}${studyable ? '' : ' not-studyable'}" role="row"${virtualIndexAttribute}>
				<span class="word-cell">
					<strong>${escapeHtml(displayWord)}</strong>
					<small title="${escapeHtml(rowReading(row))}">
						${escapeHtml(rowReading(row))}
						${studyable ? '' : ' · missing stroke data'}
					</small>
				</span>
				<span class="word-status-cell">
					<select data-word-status data-word="${escapeHtml(word)}"${disabled}>
						${statusOption('new', 'New', status)}
						${statusOption('due', 'Due review', status)}
						${statusOption('scheduled', 'Scheduled', status)}
						${statusOption('learning', 'Learning', status)}
						${statusOption('relearning', 'Relearning', status)}
						${statusOption('mastered', 'Mastered', status)}
						${statusOption('blacklisted', 'Blacklisted', status)}
					</select>
				</span>
				<span class="next-review-cell">
					<small data-due-label data-word="${escapeHtml(word)}">${escapeHtml(dueText)}</small>
					${nextReviewControls}
				</span>
				<span class="fsrs-debug-cell">${fsrsDebug}</span>
				<span class="word-stats-cell"><small>${attempts} attempts · ${pct} success</small></span>
				<span class="word-actions">
					${wordActions}
					${removeFromListAction}
				</span>
			</div>
		`;
	}


	function statusOption(value, label, current) {
		return `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
	}


	function unitOption(value, label, current) {
		return `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
	}


	function listEditorDraftKey(word, listId = ctx.selectedListId) {
		return `${listId || ''}\u0000${word}`;
	}


	function getListEditorDraft(word, listId = ctx.selectedListId) {
		const draft = ctx.listEditorDrafts[listEditorDraftKey(word, listId)] || {};
		const unit = ['minutes', 'hours', 'days'].includes(draft.unit)
			? draft.unit
			: 'days';
		const numeric = Number(draft.value);
		return {
			value: Number.isFinite(numeric) ? String(numeric) : '1',
			unit
		};
	}


	function saveListEditorDraft(word, listId = ctx.selectedListId) {
		const panel = $('#listWordEditor');
		if (!panel || !word) return;
		const valueNode = panel.querySelector(
			`[data-next-value][data-word="${cssEscape(word)}"]`
		);
		const unitNode = panel.querySelector(
			`[data-next-unit][data-word="${cssEscape(word)}"]`
		);
		if (!valueNode && !unitNode) return;
		ctx.listEditorDrafts[listEditorDraftKey(word, listId)] = {
			value: valueNode
				? valueNode.value
				: getListEditorDraft(word, listId).value,
			unit: unitNode
				? unitNode.value
				: getListEditorDraft(word, listId).unit
		};
	}


	function captureListEditorDrafts(panel = $('#listWordEditor')) {
		if (!panel || !ctx.selectedListId) return;
		panel
			.querySelectorAll('[data-next-value]')
			.forEach((input) =>
				saveListEditorDraft(input.dataset.word, ctx.selectedListId)
			);
	}


	function getWordLearningStatus(word) {
		if (state.blacklist[word]) return 'blacklisted';
		const entry = state.vocabulary[word];
		if (!entry || !(entry.attempts || 0)) return 'new';
		const stateName = getEntrySchedulerState(entry);
		if (stateName === 'learning') return 'learning';
		if (stateName === 'relearning') return 'relearning';
		if (isMasteredEntry(entry)) return 'mastered';
		if ((entry.next || 0) <= now()) return 'due';
		return 'scheduled';
	}


	function getWordDueText(word) {
		if (state.blacklist[word]) return 'Blacklisted';
		const entry = state.vocabulary[word];
		if (!entry || !(entry.attempts || 0)) return 'Not started';
		const stateName = getEntrySchedulerState(entry);
		if (!entry.next) return 'No review scheduled';
		const due = formatRelativeDue(entry.next - now());
		if (stateName === 'learning') return `Learning step ${due}`;
		if (stateName === 'relearning') return `Relearning step ${due}`;
		if (isMasteredEntry(entry)) return `Mastered review ${due}`;
		return `Review ${due}`;
	}



	function formatFsrsDebugNumber(value, decimals = 2) {
		if (value == null || value === '') return '—';
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return '—';
		return numeric.toFixed(decimals).replace(/\.0+$|0+$/g, '');
	}


	function formatFsrsDebugDays(value) {
		if (value == null || value === '') return '—';
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return '—';
		if (numeric < 0.01) return '<0.01d';
		return `${formatFsrsDebugNumber(numeric, numeric >= 10 ? 1 : 2)}d`;
	}


	function formatFsrsDebugPercent(value) {
		if (value == null || value === '') return '—';
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return '—';
		return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`;
	}


	function formatFsrsDebugDate(ts) {
		if (!ts) return '—';
		try {
			return new Date(ts * 1000).toLocaleString();
		} catch (_) {
			return '—';
		}
	}


	function labelFsrsRating(rating) {
		return ({
			again: 'Again',
			hard: 'Hard',
			good: 'Good',
			easy: 'Easy'
		})[rating] || '—';
	}


	function labelFsrsState(stateName) {
		return ({
			new: 'New',
			learning: 'Learning',
			review: 'Review',
			relearning: 'Relearning'
		})[stateName] || 'New';
	}


	function getWordFsrsDebugHtml(word) {
		if (state.blacklist[word]) {
			return '<small class="fsrs-debug-empty">Blacklisted</small>';
		}
		const entry = state.vocabulary[word];
		if (!entry || !(entry.attempts || 0)) {
			return '<small class="fsrs-debug-empty">No FSRS state yet</small>';
		}

		const fsrs = ensureFsrsState(entry);
		const stateName = getEntrySchedulerState(entry);
		const retrievability = getFsrsRetrievability(entry);
		const stability = Number(fsrs.stability);
		const difficulty = Number(fsrs.difficulty);
		const intervalDays = entry.next && fsrs.lastReview
			? Math.max(0, (entry.next - fsrs.lastReview) / ONE_DAY)
			: null;
		const title = [
			`State: ${labelFsrsState(stateName)}`,
			`Difficulty: ${formatFsrsDebugNumber(difficulty, 4)}`,
			`Stability: ${formatFsrsDebugNumber(stability, 4)} days`,
			`Retrievability now: ${formatFsrsDebugPercent(retrievability)}`,
			`Interval: ${formatFsrsDebugDays(intervalDays)}`,
			`Reps: ${Number(fsrs.reps || 0)}`,
			`Lapses: ${Number(fsrs.lapses || 0)}`,
			`Last rating: ${labelFsrsRating(fsrs.lastRating)}`,
			`Last review: ${formatFsrsDebugDate(fsrs.lastReview)}`
		].join('\n');

		return `
			<small class="fsrs-debug" title="${escapeHtml(title)}">
				<span><strong>${escapeHtml(labelFsrsState(stateName))}</strong> · R ${escapeHtml(formatFsrsDebugPercent(retrievability))}</span>
				<span>D ${escapeHtml(formatFsrsDebugNumber(difficulty, 2))} · S ${escapeHtml(formatFsrsDebugDays(stability))} · I ${escapeHtml(formatFsrsDebugDays(intervalDays))}</span>
				<span>${Number(fsrs.reps || 0)} reps · ${Number(fsrs.lapses || 0)} lapses · ${escapeHtml(labelFsrsRating(fsrs.lastRating))}</span>
			</small>
		`;
	}


	async function updateWordLearningStatus(word, listId, status) {
		const entry = ensureVocabularyEntry(word, listId);
		const t = now();
		const hasRealFsrsHistory = Boolean(
			(entry.attempts || 0) || entry.fsrs?.lastReview
		);
		const requiresExistingHistory = [
			'due',
			'scheduled',
			'learning',
			'relearning',
			'mastered'
		].includes(status);
		if (requiresExistingHistory && !hasRealFsrsHistory) {
			return 'Study this word once before assigning a scheduler state. New words can only be reset or blacklisted.';
		}

		clearExternalWordStudyState(word);
		if (status !== 'blacklisted' && state.blacklist[word])
			setBlacklistedWord(word, false, null, { save: false });

		if (status === 'new') {
			await clearReviewLogsForCards([word]);
			entry.last = null;
			entry.next = null;
			entry.attempts = 0;
			entry.successes = 0;
			delete entry.fsrs;
		} else if (status === 'due') {
			entry.attempts = Math.max(1, entry.attempts || 0);
			entry.successes = Math.max(0, entry.successes || 0);
			entry.last = entry.last || t - ONE_DAY;
			entry.next = t - 1;
			ensureFsrsState(entry);
			setEntrySchedulerState(entry, 'review');
		} else if (status === 'scheduled') {
			entry.attempts = Math.max(1, entry.attempts || 0);
			entry.successes = Math.max(0, entry.successes || 0);
			entry.last = entry.last || t;
			entry.next = t + ONE_DAY;
			ensureFsrsState(entry);
			setEntrySchedulerState(entry, 'review');
		} else if (status === 'learning') {
			entry.attempts = Math.max(1, entry.attempts || 0);
			entry.successes = Math.max(0, entry.successes || 0);
			entry.last = entry.last || t;
			entry.next = t + learningStepInterval();
			ensureFsrsState(entry);
			setEntrySchedulerState(entry, 'learning');
		} else if (status === 'relearning') {
			entry.attempts = Math.max(1, entry.attempts || 0);
			entry.successes = Math.max(0, entry.successes || 0);
			entry.last = entry.last || t;
			entry.next = t + relearningStepInterval();
			ensureFsrsState(entry);
			setEntrySchedulerState(entry, 'relearning');
		} else if (status === 'mastered') {
			entry.attempts = Math.max(5, entry.attempts || 0);
			entry.successes = entry.attempts;
			entry.last = t;
			ensureFsrsState(entry);
			entry.fsrs = {
				...entry.fsrs,
				difficulty: 4,
				stability: Math.max(
					MASTERED_STABILITY_DAYS,
					Number(entry.fsrs?.stability || 0)
				),
				retrievability: fsrsDesiredRetention(),
				lastReview: t,
				state: 'review'
			};
			entry.next = t + fsrsIntervalSeconds(entry.fsrs.stability);
			setEntrySchedulerState(entry, 'review');
		} else if (status === 'blacklisted') {
			setBlacklistedWord(word, true, getEntryRow(word));
		}
		saveState();
		return '';
	}



	function setNextReviewFromControls(word, listId) {
		saveListEditorDraft(word, listId);
		const panel = $('#listWordEditor');
		const value = Math.max(
			0,
			Number(
				panel?.querySelector(
					`[data-next-value][data-word="${cssEscape(word)}"]`
				)?.value
			) || 0
		);
		const unit =
			panel?.querySelector(
				`[data-next-unit][data-word="${cssEscape(word)}"]`
			)?.value || 'days';
		const seconds =
			value *
			(unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : ONE_DAY);
		setWordNext(word, listId, seconds);
	}


	function prepareManualSchedulerEntry(
		word,
		listId,
		{ unblacklist = true } = {}
	) {
		clearExternalWordStudyState(word);
		const entry = ensureVocabularyEntry(word, listId);
		if (unblacklist && state.blacklist[word])
			setBlacklistedWord(word, false, null, { save: false });
		return entry;
	}


	function setWordDueNow(word, listId, { save = true } = {}) {
		const entry = prepareManualSchedulerEntry(word, listId);
		const t = now();
		entry.attempts = Math.max(1, entry.attempts || 0);
		entry.last = entry.last || t - ONE_DAY;
		entry.next = t - 1;
		ensureFsrsState(entry);
		if (getEntrySchedulerState(entry) === 'new')
			setEntrySchedulerState(entry, 'review');
		if (save) saveState();
	}


	function setWordNext(word, listId, secondsFromNow, { save = true } = {}) {
		const entry = prepareManualSchedulerEntry(word, listId);
		const t = now();
		entry.attempts = Math.max(1, entry.attempts || 0);
		entry.last = entry.last || t;
		entry.next = t + Math.max(0, Math.floor(secondsFromNow || 0));
		ensureFsrsState(entry);
		if (getEntrySchedulerState(entry) === 'new')
			setEntrySchedulerState(entry, 'review');
		if (save) saveState();
	}


	async function resetWordProgress(
		word,
		{ save = true, clearLogs = true } = {}
	) {
		clearExternalWordStudyState(word);
		const entry = state.vocabulary[word];
		if (!entry) {
			if (clearLogs) await clearReviewLogsForCards([word]);
			return false;
		}
		entry.last = null;
		entry.next = null;
		entry.attempts = 0;
		entry.successes = 0;
		delete entry.fsrs;
		if (clearLogs) await clearReviewLogsForCards([word]);
		if (save) saveState();
		return true;
	}



	function isWordScheduledForLater(word) {
		const entry = state.vocabulary[word];
		return !!entry &&
			!!(entry.attempts || 0) &&
			!state.blacklist[word] &&
			!isMasteredEntry(entry) &&
			!!entry.next &&
			entry.next > now() &&
			getEntrySchedulerState(entry) !== 'new';
	}


	function makeListDueNow(listId) {
		const list = lists[listId];
		if (!list) return 0;
		let changed = 0;
		for (const row of list.rows || []) {
			const word = rowCanonicalWord(row);
			const studyWord = rowWritten(row);
			if (
				!word ||
				!canStudyWord(studyWord) ||
				isWordQueuedForStage(word) ||
				!isWordScheduledForLater(word)
			) continue;
			setWordDueNow(word, listId, { save: false });
			changed += 1;
		}
		if (changed) saveState();
		return changed;
	}


	async function resetListProgress(listId) {
		const list = lists[listId];
		if (!list) return '';
		if (!confirm(`Reset progress for all words in ${list.name}?`)) return '';
		let changed = 0;
		const listWords = [];
		for (const row of list.rows || []) {
			const word = rowCanonicalWord(row);
			if (!word) continue;
			listWords.push(word);
			if (
				await resetWordProgress(word, {
					save: false,
					clearLogs: false
				})
			) {
				changed += 1;
			}
		}
		const deletedLogs = listWords.length
			? await clearReviewLogsForCards(listWords)
			: 0;
		if (changed) saveState();
		if (changed || deletedLogs) {
			return (
				`${changed} word${changed === 1 ? '' : 's'} reset; ` +
				`${deletedLogs} matching review-log row${deletedLogs === 1 ? '' : 's'} cleared.`
			);
		}
		return 'No progress or review logs to reset in this list.';
	}



	function renderBlacklist() {
		const container = $('#blacklistContainer');
		if (!container) return;
		state.blacklist = normalizeBlacklist(state.blacklist || {});
		const items = Object.values(state.blacklist).sort((a, b) =>
			a.word.localeCompare(b.word)
		);
		container.innerHTML = '';
		if (!items.length) {
			const empty = document.createElement('p');
			empty.className = 'feedback';
			empty.textContent = 'No blacklisted words.';
			container.appendChild(empty);
			return;
		}
		for (const item of items) {
			const displayWord = rowWritten(getEntryRow(item.word)) || item.word;
			const row = document.createElement('div');
			row.className = 'list-row blacklist-row';
			row.innerHTML = `
				<div>
					<strong>${escapeHtml(displayWord)}</strong>
					<small>
						${escapeHtml(item.reading || '')}
						${item.definition ? ' · ' + escapeHtml(item.definition) : ''}
					</small>
				</div>
				<button type="button">Restore</button>`;
			$('button', row).addEventListener('click', () => {
				setBlacklistedWord(item.word, false);
				playSound('restoreBlacklist');
				refreshVocabularyViews();
				nextCard();
			});
			container.appendChild(row);
		}
	}


	function refreshListEditorDueText() {
		const panel = $('#listWordEditor');
		if (!panel) return;
		panel.querySelectorAll('[data-due-label]').forEach((node) => {
			const nextText = getWordDueText(node.dataset.word);
			if (node.textContent !== nextText) node.textContent = nextText;
		});
	}


	return {
		setBlacklistedWord,
		refreshVocabularyViews,
		renderLists,
		refreshListEditorAfterAction,
		renderListEditor,
		renderBlacklist,
		refreshListEditorDueText
	};
}
