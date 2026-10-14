import { REVIEW_STAGE_MAX } from './constants.js';
import { dueKanjiDrills, isTrackableKanji } from './kanji-mastery.js';
import { rowWritten } from './word-data.js';
import {
	getEntrySchedulerState,
	isFsrsDue,
	getFsrsRetrievability
} from './fsrs.js';

export function createSessionQueue(ctx) {
	const state = ctx.liveState();
	const clamp = (...args) => ctx.clamp(...args);
	const sample = (...args) => ctx.sample(...args);
	const now = (...args) => ctx.now(...args);
	const freshSession = (...args) => ctx.freshSession(...args);
	const sessionDuration = (...args) => ctx.sessionDuration(...args);
	const saveState = (...args) => ctx.saveState(...args);
	const disposeTrainer = (...args) => ctx.disposeTrainer(...args);
	const isActiveStudyWord = (...args) => ctx.isActiveStudyWord(...args);
	const getActiveVocabulary = (...args) => ctx.getActiveVocabulary(...args);
	const orderNewItemsByListPosition = (...args) => ctx.orderNewItemsByListPosition(...args);
	function stageItemFromCard(card = ctx.currentCard) {
		if (!card?.word || !isActiveStudyWord(card.word)) return null;
		return {
			word: card.word,
			deck: card.deck,
			stage: card.stage,
			attemptResult: card.attemptResult ?? null,
			forceSequential: !!card.forceSequential,
			sawAgain: !!card.sawAgain,
            kanji: card.deck === 'kanji' ? card.kanji : null,
            position: card.deck === 'kanji' ? card.position : null,
            recordedKanji: Array.isArray(card.recordedKanji) ? card.recordedKanji.slice() : [],
            failedCharacters: Array.isArray(card.failedCharacters) ? card.failedCharacters.slice() : [],
			delay: 0
		};
	}


	function normalizeStageQueueItem(item) {
        if (!item?.word || !isActiveStudyWord(item.word)) return null;
        // Older saves can omit a deck; those were ordinary reviews.
        const deck = item.deck || 'reviews';
        if (!['adds', 'reviews', 'steps', 'kanji'].includes(deck)) return null;
        const savedStage = Number(item.stage);
        const stage = Number.isFinite(savedStage)
            ? clamp(Math.floor(savedStage), 1, REVIEW_STAGE_MAX) : 1;
        const savedResult = item.attemptResult == null
            ? null : Number(item.attemptResult);
        if (savedResult !== null && (!Number.isInteger(savedResult) ||
            savedResult < 0 || savedResult > 3)) return null;
        const written = Array.from(rowWritten(ctx.getEntryRow?.(item.word)) || item.word);
        if (deck === 'kanji') {
            if (!isTrackableKanji(item.kanji) ||
                !ctx.getKanjiPracticeCharacter(item.kanji) ||
                !written.includes(item.kanji)) return null;
        }
        const practiced = deck === 'kanji' ? [item.kanji] : written;
		return {
			word: item.word,
			deck,
			stage,
			attemptResult: savedResult,
			forceSequential: !!item.forceSequential,
			sawAgain: !!item.sawAgain,
            kanji: deck === 'kanji' ? item.kanji : null,
            position: deck === 'kanji' ? written.indexOf(item.kanji) : null,
            recordedKanji: Array.isArray(item.recordedKanji)
                ? [...new Set(item.recordedKanji.filter((kanji) =>
                    isTrackableKanji(kanji) && practiced.includes(kanji)))] : [],
            failedCharacters: stage === REVIEW_STAGE_MAX
                ? [...new Set((Array.isArray(item.failedCharacters)
                    ? item.failedCharacters : []).filter((index) =>
                    Number.isInteger(index) && index >= 0 &&
                    index < practiced.length))]
                : [],
			delay: Math.max(0, Math.floor(Number(item.delay) || 0))
		};
	}


	function syncStageQueueToSession() {
		if (!state.session) state.session = freshSession();
		ctx.stagedQueue = ctx.stagedQueue
			.map(normalizeStageQueueItem)
			.filter(Boolean);
		state.session.stageQueue = ctx.stagedQueue.slice();
		// Apply the same validation to the active saved card as queued cards.
		// Otherwise a stale kanji drill may be restored as an unfinishable
		// exercise (or accidentally fall back to a whole-word review).
		state.session.currentStageCard = normalizeStageQueueItem(
			state.session.currentStageCard
		);
		const activeCard = normalizeStageQueueItem(
            stageItemFromCard(ctx.currentCard)
        );
		if (activeCard) {
			state.session.currentStageCard = activeCard;
		} else if (ctx.currentCard && !activeCard) {
			state.session.currentStageCard = null;
		}
	}


	function lastShownWord() {
		return state.session?.lastWord || null;
	}


	function rememberShownWord(word) {
		if (!word) return;
		if (!state.session) state.session = freshSession();
		state.session.lastWord = word;
	}


	function clearCurrentStageCard() {
		if (state.session) state.session.currentStageCard = null;
	}


	function pruneStagedState() {
		ctx.stagedQueue = ctx.stagedQueue
			.map(normalizeStageQueueItem)
			.filter(Boolean);
		if (ctx.currentCard && !isActiveStudyWord(ctx.currentCard.word)) {
			disposeTrainer();
			ctx.currentCard = null;
		}
		syncStageQueueToSession();
	}


	function isWordQueuedForStage(word) {
		return (
			ctx.currentCard?.word === word ||
			ctx.stagedQueue.some((item) => item.word === word)
		);
	}


	function clearStagedWord(word) {
		ctx.stagedQueue = ctx.stagedQueue.filter((item) => item.word !== word);
		syncStageQueueToSession();
	}


	function stagedWorkCounts() {
		const counts = { adds: 0, reviews: 0, steps: 0, kanji: 0, total: 0 };
		const countItem = (item) => {
			if (!item?.word || !isActiveStudyWord(item.word)) return;
			counts.total += 1;
			if (item.deck === 'kanji') counts.kanji += 1;
			else if (item.deck === 'adds') counts.adds += 1;
			else if (item.deck === 'steps') counts.steps += 1;
			else counts.reviews += 1;
		};
		for (const item of ctx.stagedQueue || []) countItem(item);
		countItem(stageItemFromCard(ctx.currentCard));
		return counts;
	}


	function getDueSets() {
		resetExpiredSession();
		pruneStagedState();
		const t = now();
		const active = getActiveVocabulary();
		const available = [];
		const newItems = [];
		const learning = [];
		const relearning = [];
		const reviews = [];
		const extras = [];

		for (const entry of active) {
			if (isWordQueuedForStage(entry.word)) continue;
			available.push(entry);
			const schedulerState = getEntrySchedulerState(entry);
			const due = schedulerState !== 'new' && isFsrsDue(entry, t);
			if (schedulerState === 'new') {
				newItems.push(entry);
				extras.push(entry);
			} else if (due) {
				extras.push(entry);
				if (schedulerState === 'learning') learning.push(entry);
				else if (schedulerState === 'relearning') relearning.push(entry);
				else if (schedulerState === 'review') reviews.push(entry);
			}
		}

        const blockedWords = new Set([
            ...ctx.stagedQueue.map((item) => item.word),
            ctx.currentCard?.word
        ]);
        const kanji = dueKanjiDrills(
            state.kanjiMastery, active,
            (entry) => rowWritten(ctx.getEntryRow(entry.word)) || entry.word,
            ctx.getKanjiPracticeCharacter, t, blockedWords,
            state.session.kanjiReviewed || []
        );
		const orderedLearning = orderReviewItems(learning);
		const orderedRelearning = orderReviewItems(relearning);
		return {
			active,
			available,
			newItems: orderNewItemsByListPosition(newItems),
            kanji,
			learning: orderedLearning,
			reviews: orderReviewItems(reviews),
			relearning: orderedRelearning,
			steps: orderedLearning.concat(orderedRelearning),
			extras
		};
	}

	function resetExpiredSession() {
		const t = now();
		const started = Number(state.session?.started);
		if (
			!state.session ||
			!Number.isFinite(started) ||
			t - started > sessionDuration() ||
			started - t > 60
		) {
			const savedCurrentStageCard = ctx.currentCard
				? stageItemFromCard(ctx.currentCard)
				: state.session?.currentStageCard;
			const hasCurrentStageCard = Boolean(
				savedCurrentStageCard?.word &&
				isActiveStudyWord(savedCurrentStageCard.word)
			);
				const preservedQueue = ctx.stagedQueue
				.map(normalizeStageQueueItem)
				.filter(Boolean);
			const hasActiveStagedReview = Boolean(
				hasCurrentStageCard || preservedQueue.length
			);
			state.session = freshSession(t);
			if (hasActiveStagedReview) {
				ctx.stagedQueue = preservedQueue;
				state.session.stageQueue = preservedQueue.slice();
				state.session.currentStageCard = hasCurrentStageCard
					? savedCurrentStageCard
					: null;
			} else {
				ctx.stagedQueue = [];
				ctx.currentCard = null;
			}
			saveState();
		}
	}


	function getRemainder(sets = getDueSets()) {
		const counts = state.session;
		const staged = stagedWorkCounts();
		const addsLimitSetting = Math.max(
			0,
			Math.floor(Number(state.settings.maxAdds) || 0)
		);
		const reviewLimitSetting = Math.max(
			0,
			Math.floor(Number(state.settings.maxReviews) || 0)
		);
		const addsLimit = Math.max(
			0,
			addsLimitSetting - (counts.adds || 0) - staged.adds
		);
		const reviewCapacity = Math.max(
			0,
			reviewLimitSetting -
				(counts.reviews || 0) -
				(counts.steps || 0) -
				staged.reviews -
				staged.steps -
                (counts.kanji || 0) -
                staged.kanji
		);
		const steps = Math.min(sets.steps.length, reviewCapacity);
		const reviews = Math.min(
			sets.reviews.length,
			Math.max(0, reviewCapacity - steps)
		);
		const reviewRoomAfterDue = Math.max(
			0,
			reviewCapacity - steps - reviews
		);
        const kanji = Math.min(sets.kanji.length, reviewRoomAfterDue);
		const effectiveAddsLimit = state.settings.newCardsIgnoreReviewLimit
			? addsLimit
			: Math.min(addsLimit, Math.max(0, reviewRoomAfterDue - kanji));
		const adds = Math.min(sets.newItems.length, effectiveAddsLimit);

		const planned =
			(counts.adds || 0) +
			(counts.reviews || 0) +
			(counts.steps || 0) +
            (counts.kanji || 0) +
			staged.total +
			adds +
			reviews +
			steps + kanji;
		const neededExtras = Math.max(0, (counts.minCards || 0) - planned);
		const extras = neededExtras > 0
			? Math.min(sets.extras.length, neededExtras)
			: 0;
		return { adds, reviews, extras, steps, kanji };
	}



	function ageQueuedStageCards() {
		if (!ctx.stagedQueue.length) return;
		ctx.stagedQueue = ctx.stagedQueue.map((item) => ({
			...item,
			delay: Math.max(0, Math.floor(Number(item.delay) || 0) - 1)
		}));
		syncStageQueueToSession();
	}


	function getQueuedStageCandidates({ readyOnly = false } = {}) {
		ctx.stagedQueue = ctx.stagedQueue
			.map(normalizeStageQueueItem)
			.filter(Boolean);
		syncStageQueueToSession();
		return ctx.stagedQueue
			.map((item, index) => ({ item, index }))
			.filter(
				({ item }) =>
					!readyOnly || Math.max(0, Number(item.delay) || 0) <= 0
			);
	}


	function filterBucketsByLastWord(buckets) {
		const previous = lastShownWord();
		if (!previous) return buckets.filter((bucket) => bucket.candidates.length);
		const hasAlternative = buckets.some((bucket) =>
			bucket.candidates.some((candidate) => bucket.word(candidate) !== previous)
		);
		if (!hasAlternative) return buckets.filter((bucket) => bucket.candidates.length);
		return buckets
			.map((bucket) => ({
				...bucket,
				candidates: bucket.candidates.filter(
					(candidate) => bucket.word(candidate) !== previous
				)
			}))
			.filter((bucket) => bucket.candidates.length);
	}


	function chooseAvailableBucket(buckets) {
		const available = filterBucketsByLastWord(buckets);
		return available.length ? sample(available) : null;
	}


	function bucketCandidatesForDeck(deck, sets, left) {
		if (deck === 'kanji') return sets.kanji.slice(0, left.kanji);
		if (deck === 'adds') return sets.newItems.slice(0, left.adds);
		if (deck === 'reviews') return orderReviewItems(sets.reviews).slice(0, left.reviews);
		if (deck === 'steps') return orderReviewItems(sets.steps).slice(0, left.steps);
		if (deck === 'staged') return getQueuedStageCandidates({ readyOnly: true });
		return [];
	}


	function buildPrimaryBuckets(sets, left) {
		const buckets = [];
		const staged = bucketCandidatesForDeck('staged', sets, left);
		if (staged.length) {
			buckets.push({
				deck: 'staged',
				candidates: staged,
				word: (candidate) => candidate.item.word
			});
		}
		if (left.kanji > 0) {
            buckets.push({ deck: 'kanji',
                candidates: bucketCandidatesForDeck('kanji', sets, left),
                word: (item) => item.word });
        }
		if (left.steps > 0) {
			buckets.push({
				deck: 'steps',
				candidates: bucketCandidatesForDeck('steps', sets, left),
				word: (entry) => entry.word
			});
		}
		if (left.reviews > 0) {
			buckets.push({
				deck: 'reviews',
				candidates: bucketCandidatesForDeck('reviews', sets, left),
				word: (entry) => entry.word
			});
		}
		if (left.adds > 0) {
			buckets.push({
				deck: 'adds',
				candidates: bucketCandidatesForDeck('adds', sets, left),
				word: (entry) => entry.word
			});
		}
		return buckets.filter((bucket) => bucket.candidates.length);
	}


	function orderReviewItems(items) {
		const t = now();
		return items
			.map((entry) => ({
				entry,
				next: Number(entry.next || 0),
				retrievability: state.settings.reviewOrder === 'retrievability'
					? getFsrsRetrievability(entry, t)
					: 0
			}))
			.sort((a, b) =>
				state.settings.reviewOrder === 'retrievability'
					? a.retrievability - b.retrievability || a.next - b.next
					: a.next - b.next
			)
			.map((item) => item.entry);
	}



	return {
		normalizeStageQueueItem,
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
	};
}
