import { DEFAULT_STUDY_EXAMPLE_LIMIT } from './constants.js';
import { readingRevealsWritten, rowDefinition, rowReading, rowWords, textValue } from './word-data.js';

function chars(text) {
	return Array.from(String(text || ''));
}

function isCompoundWord(word) {
	return chars(word).length >= 2;
}

function chooseDisplayWord(row, character) {
	const ch = String(character || '');
	const words = rowWords(row);
	if (!ch) return words[0] || '';
	return words.find((word) => chars(word).includes(ch)) || words[0] || '';
}

function rowContainsCharacter(row, character) {
	const ch = String(character || '');
	if (!ch) return false;
	return rowWords(row).some((word) => chars(word).includes(ch));
}

function rowHasSeenWord(row, seenWords) {
	return rowWords(row).some((word) => seenWords.has(word));
}

function markRowWordsSeen(row, seenWords, displayWord = '') {
	for (const word of rowWords(row)) seenWords.add(word);
	if (displayWord) seenWords.add(displayWord);
}

function shuffle(items) {
	const shuffled = items.slice();
	for (let i = shuffled.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

function blankWord(word) {
	return chars(word).map(() => '＿').join('');
}

function excludedWordsForCard(card) {
	return [
		card?.word,
		card?.studyWord,
		...rowWords(card?.row)
	].map(textValue).filter(Boolean);
}

export function createWordExamples(ctx) {
	const lists = ctx.liveLists();
	const state = ctx.liveState();
	const $ = (...args) => ctx.$(...args);
	const escapeHtml = (...args) => ctx.escapeHtml(...args);
	const listCharacterIndexCache = new WeakMap();

	function getListCharacterIndex(list) {
		const rows = Array.isArray(list?.rows) ? list.rows : [];
		const cached = list && typeof list === 'object'
			? listCharacterIndexCache.get(list)
			: null;
		if (cached && cached.rows === rows && cached.length === rows.length) {
			return cached.index;
		}

		const index = new Map();
		for (const row of rows) {
			const words = rowWords(row);
			const characters = new Set(
				words
					.filter(isCompoundWord)
					.flatMap((word) => chars(word))
			);
			for (const character of characters) {
				if (!index.has(character)) index.set(character, []);
				index.get(character).push({ row, words });
			}
		}
		if (list && typeof list === 'object') {
			listCharacterIndexCache.set(list, { rows, length: rows.length, index });
		}
		return index;
	}

	function getCharacterExamples(character, options = {}) {
		const {
			excludeWords = [],
			max = DEFAULT_STUDY_EXAMPLE_LIMIT
		} = options;

		const excludedWords = new Set(
			excludeWords.map(textValue).filter(Boolean)
		);
		const targetCharacter = String(character || '');
		const examples = [];
		const seenWords = new Set();
		const activeListsOnly = !!state.settings?.examplesActiveListsOnly;

		for (const [listId, list] of Object.entries(lists || {})) {
			if (activeListsOnly && !state.enabledLists?.[listId]) continue;

			const candidates = getListCharacterIndex(list).get(targetCharacter) || [];
			for (const candidate of candidates) {
				const { row, words } = candidate;

				if (!words.length) continue;
				if (words.some((word) => seenWords.has(word))) continue;
				if (words.some((word) => excludedWords.has(textValue(word)))) continue;

				const displayWord =
					words.find((word) => chars(word).includes(targetCharacter)) ||
					words[0] ||
					'';

				if (
					!displayWord ||
					!chars(displayWord).includes(targetCharacter) ||
					!isCompoundWord(displayWord)
				) {
					continue;
				}

				for (const word of words) {
					seenWords.add(word);
				}
				seenWords.add(displayWord);

				examples.push({
					word: displayWord,
					reading: rowReading(row),
					readingRevealsWord: readingRevealsWritten(row),
					definition: rowDefinition(row)
				});
			}
		}

		const randomized = shuffle(examples);
		const limit = Number(max);

		return Number.isFinite(limit) && limit > 0 && randomized.length > limit
			? randomized.slice(0, Math.floor(limit))
			: randomized;
	}

	function examplesHtml(examples, options = {}) {
		const { showWritten = true } = options;
		if (!examples.length) return '';
		return `
			<div class="example-heading">Used in other words</div>
			<ul class="example-list">
				${examples.map((example) => {
					const displayWord = showWritten
						? example.word
						: blankWord(example.word);
					return `
						<li>
							<span class="example-word${showWritten ? '' : ' example-word-blank'}">${escapeHtml(displayWord)}</span>
							<span class="example-detail">
								${example.reading && (showWritten || !example.readingRevealsWord) ? `<span class="example-reading">${escapeHtml(example.reading)}</span>` : ''}
								${example.definition ? `<span class="example-definition">${escapeHtml(example.definition)}</span>` : ''}
							</span>
						</li>
					`;
				}).join('')}
			</ul>
		`;
	}

	function renderStudyExamples(card, currentIndex = 0, options = {}) {
		const container = $('#promptExamples');
		if (!container) return;
		const character = card?.characters?.[currentIndex]?.character ||
			chars(card?.studyWord || card?.word)[currentIndex] || '';
		if (!card || !character) {
			container.innerHTML = '';
			container.classList.add('hidden');
			return;
		}
		const examples = getCharacterExamples(character, {
			excludeWords: excludedWordsForCard(card),
			max: state.settings?.studyExampleLimit ||
				DEFAULT_STUDY_EXAMPLE_LIMIT
		});
		if (!examples.length) {
			container.innerHTML = '';
			container.classList.add('hidden');
			return;
		}
		container.innerHTML = examplesHtml(examples, {
			showWritten: options.showWritten ?? (card.stage || 1) === 1
		});
		container.classList.remove('hidden');
	}

	function renderLookupExamples(character) {
		const container = $('#lookupExamples');
		if (!container) return;
		const examples = getCharacterExamples(character, {
			excludeWords: [],
			max: null
		});
		if (!character || !examples.length) {
			container.innerHTML = '';
			container.classList.add('hidden');
			return;
		}
		container.innerHTML = examplesHtml(examples, { showWritten: true });
		container.classList.remove('hidden');
	}

	function clearStudyExamples() {
		const container = $('#promptExamples');
		if (!container) return;
		container.innerHTML = '';
		container.classList.add('hidden');
	}

	function clearLookupExamples() {
		const container = $('#lookupExamples');
		if (!container) return;
		container.innerHTML = '';
		container.classList.add('hidden');
	}

	return {
		getCharacterExamples,
		renderStudyExamples,
		renderLookupExamples,
		clearStudyExamples,
		clearLookupExamples
	};
}
