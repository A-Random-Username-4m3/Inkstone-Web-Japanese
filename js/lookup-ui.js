import { rowCanonicalWord, rowWritten } from './word-data.js';
import { drawCanvasBase, drawCharacterPaths } from './practice-canvas.js';
import { JmDictStore } from './jmdict-data.js';
import { normalizeCustomListId } from './list-id.js';

const MAX_LOOKUP_ENTRIES = 24;

export function japaneseCharacterScript(character) {
	const value = Array.from(String(character || '').normalize('NFKC'));
	if (value.length !== 1) return 'Japanese character';
	const ch = value[0];
	const code = ch.codePointAt(0);
	if (code >= 0x3040 && code <= 0x309f) return 'Hiragana';
	if (
		(code >= 0x30a0 && code <= 0x30ff) ||
		(code >= 0x31f0 && code <= 0x31ff)
	) return 'Katakana';
	if (/\p{Script=Han}/u.test(ch)) return 'Kanji';
	return 'Japanese character';
}

function hasDictionaryMetadata(dictionary) {
	if (!dictionary || typeof dictionary !== 'object') return false;
	return [
		...(dictionary.meanings || []),
		...(dictionary.on || []),
		...(dictionary.kun || []),
		...(dictionary.nameReadings || [])
	].some(Boolean);
}

function uniqueStrings(values = []) {
	return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function jmdictStudyId(record) {
	return `jmdict:${record.id}`;
}

export function makeJmdictListRow(record) {
	const definitions = uniqueStrings(record.definitions || []);
	const definition = definitions.join('; ');
	return {
		studyId: jmdictStudyId(record),
		source: 'JMdict',
		jmdictId: record.id,
		written: record.written,
		reading: record.reading,
		definitions,
		common: !!record.common,
		definition
	};
}

function sortJmdictEntries(entries, query) {
	return entries.slice().sort((a, b) => {
		const aWritten = a.written === query ? 0 : 1;
		const bWritten = b.written === query ? 0 : 1;
		if (aWritten !== bWritten) return aWritten - bWritten;
		const aCommon = a.common ? 0 : 1;
		const bCommon = b.common ? 0 : 1;
		if (aCommon !== bCommon) return aCommon - bCommon;
		return Number(a.sequence || 0) - Number(b.sequence || 0);
	});
}

export function createLookupUi(ctx) {
	const state = ctx.liveState();
	const lists = ctx.liveLists();
	const $ = (...args) => ctx.$(...args);
	const escapeHtml = (...args) => ctx.escapeHtml(...args);
	const metaRow = (...args) => ctx.metaRow(...args);
	const parseTsvRows = (...args) => ctx.parseTsvRows(...args);
	const canStudyWord = (...args) => ctx.canStudyWord(...args);
	const syncVocabularyWithEnabledLists = (...args) => ctx.syncVocabularyWithEnabledLists(...args);
	const renderLists = (...args) => ctx.renderLists(...args);
	const renderProgress = (...args) => ctx.renderProgress(...args);
	const setText = (...args) => ctx.setText(...args);
	const clearLookupExamples = (...args) => ctx.clearLookupExamples(...args);
	const jmdictStore = ctx.jmdictStore || new JmDictStore();
	const loadPracticeCharacter = (...args) =>
		ctx.loadKanjiPracticeCharacter?.(...args) ?? Promise.resolve(null);
	let lookupRequestId = 0;

	function stopLookupAnimation() {
		if (!ctx.lookupAnimator) return;
		clearInterval(ctx.lookupAnimator);
		ctx.lookupAnimator = null;
	}

	function clearLookupCanvas() {
		const canvas = $('#lookupCanvas');
		if (!canvas) return;
		drawCanvasBase(canvas.getContext('2d'), canvas.width);
	}

	function characterSummaryHtml(characterData) {
		if (!characterData) return '';
		const dictionary = characterData.dictionary || {};
		const hasDictionary = hasDictionaryMetadata(dictionary);
		const script = japaneseCharacterScript(characterData.character);
		const strokeTypes = characterData.strokeTypes.filter(Boolean).join(' ');
		const components = Array.from(new Set(
			characterData.strokeMetadata
				.flatMap((stroke) => stroke.components || [])
				.map((component) => component.element)
				.filter(Boolean)
		));
		const kanjiVgStrokeCount = characterData.strokes.length;
		const dictionaryStrokeCount = Number(dictionary.strokeCount);
		const strokeText = Number.isFinite(dictionaryStrokeCount) &&
			dictionaryStrokeCount !== kanjiVgStrokeCount
			? `KanjiVG ${kanjiVgStrokeCount} · KANJIDIC2 ${dictionaryStrokeCount}`
			: String(kanjiVgStrokeCount);

		return `
			<section class="lookup-kanji-summary">
				<div class="big-char">${escapeHtml(characterData.character)}</div>
				${metaRow('Script', script)}
				${hasDictionary ? metaRow('Meanings', uniqueStrings(dictionary.meanings).join('; ') || '—') : ''}
				${hasDictionary ? metaRow('On readings', uniqueStrings(dictionary.on).join('、') || '—') : ''}
				${hasDictionary ? metaRow('Kun readings', uniqueStrings(dictionary.kun).join('、') || '—') : ''}
				${hasDictionary && dictionary.nameReadings?.length ? metaRow('Name readings', uniqueStrings(dictionary.nameReadings).join('、')) : ''}
				${metaRow('Strokes', strokeText)}
				${hasDictionary && dictionary.grade != null ? metaRow('Grade', String(dictionary.grade)) : ''}
				${hasDictionary && dictionary.frequency != null ? metaRow('Frequency rank', String(dictionary.frequency)) : ''}
				${hasDictionary && dictionary.classicalRadical != null ? metaRow('Radical no.', String(dictionary.classicalRadical)) : ''}
				${strokeTypes ? metaRow('Stroke types', strokeTypes) : ''}
				${components.length ? metaRow('Components', components.join(' · ')) : ''}
				${metaRow('Stroke source', 'KanjiVG')}
			</section>
		`;
	}

	function vocabularyEntriesHtml(entries, query) {
		if (!entries.length) {
			return `
				<section class="lookup-vocabulary">
					<h3>Vocabulary</h3>
					<p class="feedback">No exact JMdict spelling or reading match for <strong>${escapeHtml(query)}</strong>.</p>
				</section>
			`;
		}

		const sorted = sortJmdictEntries(entries, query);
		const visible = sorted.slice(0, MAX_LOOKUP_ENTRIES);
		return `
			<section class="lookup-vocabulary">
				<div class="lookup-section-heading">
					<h3>Vocabulary</h3>
					<small>${entries.length}${entries.length > MAX_LOOKUP_ENTRIES ? ` results · showing ${MAX_LOOKUP_ENTRIES}` : ' exact result' + (entries.length === 1 ? '' : 's')}</small>
				</div>
				<div class="dictionary-entry-list">
					${visible.map((entry) => {
						const studyable = canStudyWord(entry.written);
						const definitions = uniqueStrings(entry.definitions).slice(0, 6);
						return `
							<article class="dictionary-entry">
								<div class="dictionary-entry-main">
									<div class="dictionary-entry-title">
										<strong>${escapeHtml(entry.written)}</strong>
										<span class="dictionary-reading">【${escapeHtml(entry.reading)}】</span>
										${entry.common ? '<span class="dictionary-badge">common</span>' : ''}
									</div>
									<div class="dictionary-definitions">${definitions.map((definition) => `<span>${escapeHtml(definition)}</span>`).join('')}</div>
									${!studyable ? '<small class="dictionary-study-note">Saved entries containing unsupported characters will become studyable after their stroke data is added.</small>' : ''}
								</div>
								<button type="button" data-add-jmdict="${escapeHtml(entry.id)}">Add to personal study</button>
							</article>
						`;
					}).join('')}
				</div>
			</section>
		`;
	}

	async function lookupCharacter(value, options = {}) {
		const requestId = ++lookupRequestId;
		const query = String(value || '').trim();
		const { syncInput = true } = options;
		const result = $('#lookupResult');
		if (!query) {
			stopLookupAnimation();
			clearLookupExamples();
			clearLookupCanvas();
			if (result) result.innerHTML = '<p>Enter a kanji, Japanese spelling, or kana reading.</p>';
			return;
		}
		if (syncInput && $('#lookupInput')) $('#lookupInput').value = query;
		stopLookupAnimation();
		clearLookupExamples();
		clearLookupCanvas();
		if (result) {
			result.innerHTML = `<p>Searching the local Japanese dictionary for <strong>${escapeHtml(query)}</strong>…</p>`;
		}

		let entries = [];
		let kanjiData = null;
		const singleCharacter = Array.from(query).length === 1;
		const [jmdictResult, kanjiResult] = await Promise.allSettled([
			jmdictStore.lookup(query),
			singleCharacter
				? loadPracticeCharacter(query)
				: Promise.resolve(null)
		]);
		if (requestId !== lookupRequestId) return;

		const errors = [];
		if (jmdictResult.status === 'fulfilled') entries = jmdictResult.value;
		else {
			console.warn('Could not load JMdict lookup data:', jmdictResult.reason);
			errors.push(`JMdict: ${jmdictResult.reason?.message || jmdictResult.reason}`);
		}
		if (kanjiResult.status === 'fulfilled') kanjiData = kanjiResult.value;
		else {
			console.warn('Could not load KanjiVG/KANJIDIC2 lookup data:', kanjiResult.reason);
			errors.push(`Kanji data: ${kanjiResult.reason?.message || kanjiResult.reason}`);
		}

		if (result) {
			result.innerHTML = `
				${characterSummaryHtml(kanjiData)}
				${jmdictResult.status === 'fulfilled' ? vocabularyEntriesHtml(entries, query) : ''}
				${errors.length ? `<p class="feedback">Some local data could not be loaded: ${escapeHtml(errors.join(' · '))}</p>` : ''}
				<p id="lookupStatus" class="feedback"></p>
			`;
		}
		if (kanjiData) animateLookup(kanjiData);
	}

	function animateLookup(data) {
		stopLookupAnimation();
		const canvas = $('#lookupCanvas');
		if (!canvas) return;
		const ctx2d = canvas.getContext('2d');
		let index = 0;
		const draw = () => {
			drawCanvasBase(ctx2d, canvas.width);
			drawCharacterPaths(
				ctx2d,
				data,
				Array.from({ length: index }, (_, i) => i),
				'rgba(0,0,0,.86)'
			);
			index = (index + 1) % (data.strokes.length + 1);
		};
		draw();
		ctx.lookupAnimator = setInterval(draw, 650);
	}

	async function addLookupToPersonalList(entryId, button = null) {
		const idValue = String(entryId || '').trim();
		if (!idValue) return;
		let record;
		try {
			record = await jmdictStore.get(idValue);
		} catch (error) {
			setText('#lookupStatus', `Could not load JMdict entry: ${error.message}`);
			return;
		}
		if (!record) {
			setText('#lookupStatus', 'That JMdict entry is no longer available.');
			return;
		}

		const id = 'personal';
		if (!state.customLists[id]) {
			state.customLists[id] = {
				category: 'Custom',
				name: 'Personal vocabulary',
				rows: []
			};
		}
		const rows = state.customLists[id].rows;
		const newRow = makeJmdictListRow(record);
		const existing = rows.find((row) =>
			rowCanonicalWord(row) === newRow.studyId || row.jmdictId === record.id
		);
		if (!existing) rows.push(newRow);

		state.enabledLists[id] = true;
		ctx.selectedListId = id;
		lists[id] = state.customLists[id];
		syncVocabularyWithEnabledLists();
		renderLists();
		renderProgress();

		if (button) {
			button.disabled = true;
			button.textContent = 'Added';
		}
		const studyable = canStudyWord(record.written);
		setText(
			'#lookupStatus',
			existing
				? `${record.written}【${record.reading}】 is already in Personal vocabulary.`
				: studyable
					? `Added ${record.written}【${record.reading}】 to Personal vocabulary.`
					: `Added ${record.written}【${record.reading}】 to Personal vocabulary. It is saved, but handwriting study needs stroke data for every character.`
		);
	}

	function handleLookupResultClick(event) {
		const button = event.target.closest?.('[data-add-jmdict]');
		if (!button) return;
		void addLookupToPersonalList(button.dataset.addJmdict, button);
	}

	function pasteDemoList() {
		if ($('#customListText')) {
			$('#customListText').value = [
				['今', 'いま', 'now'],
				['日本', 'にほん', 'Japan'],
				['学生', 'がくせい', 'student']
			].map((row) => row.join('\t')).join('\n');
		}
		if ($('#customListId')) $('#customListId').value = 'my-demo';
		if ($('#customListName')) $('#customListName').value = 'My Japanese demo list';
	}

	function importCustomList() {
		const rawId = $('#customListId')?.value || '';
		const id = normalizeCustomListId(rawId);
		const name = ($('#customListName')?.value || id).trim();
		if (!id) {
			return setText(
				'#listImportStatus',
				String(rawId).trim()
					? 'That list id is reserved. Choose another id.'
					: 'Please enter a list id.'
			);
		}
		if (lists[id] && !state.customLists[id])
			return setText(
				'#listImportStatus',
				`List id "${id}" is reserved by a built-in list. Choose another id.`
			);
		try {
			const rows = parseTsvRows($('#customListText')?.value || '');
			const usable = rows.filter((row) =>
				canStudyWord(rowWritten(row))
			);
			state.customLists[id] = { category: 'Custom', name, rows };
			lists[id] = state.customLists[id];
			state.enabledLists[id] = true;
			ctx.selectedListId = id;
			syncVocabularyWithEnabledLists();
			renderLists();
			renderProgress();
			setText(
				'#listImportStatus',
				`Imported ${rows.length} rows. ${usable.length} are studyable with current stroke data.`
			);
		} catch (error) {
			setText('#listImportStatus', `Import failed: ${error.message}`);
		}
	}

	return {
		lookupCharacter,
		stopLookupAnimation,
		addLookupToPersonalList,
		handleLookupResultClick,
		pasteDemoList,
		importCustomList
	};
}
