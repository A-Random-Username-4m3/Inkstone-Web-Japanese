// Per-kanji FSRS lives alongside vocabulary FSRS. A kanji is graded only
// after an actual unassisted (stage 5) handwritten completion, never from a
// guided stage or a manual word-level grade.
import { applyFsrsResult, ensureFsrsState, isFsrsDue } from './fsrs.js';
import { isSafeObjectKey } from './list-id.js';

export const isTrackableKanji = (value) =>
    typeof value === 'string' && Array.from(value).length === 1 &&
    /\p{Script=Han}/u.test(value) && isSafeObjectKey(value);

const finiteNonnegative = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function normalizeKanjiMastery(input) {
    const result = Object.create(null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
    for (const [kanji, value] of Object.entries(input)) {
        if (!isTrackableKanji(kanji) || !value || typeof value !== 'object' ||
            Array.isArray(value)) continue;
        const attempts = finiteNonnegative(value.attempts) ? Math.floor(value.attempts) : 0;
        const successes = finiteNonnegative(value.successes)
            ? Math.min(attempts, Math.floor(value.successes)) : 0;
        if (!attempts) continue; // No inferred mastery from legacy word history.
        const last = finiteNonnegative(value.last) ? value.last : null;
        const next = finiteNonnegative(value.next) ? value.next : null;
        const fsrs = value.fsrs && typeof value.fsrs === 'object' &&
            !Array.isArray(value.fsrs) ? value.fsrs : {};
        const safeFsrs = {};
        for (const field of ['difficulty', 'stability', 'retrievability', 'lastReview',
            'reps', 'lapses', 'step']) {
            if (finiteNonnegative(fsrs[field])) safeFsrs[field] = fsrs[field];
        }
        if (['new', 'learning', 'review', 'relearning'].includes(fsrs.state)) {
            safeFsrs.state = fsrs.state;
        }
        if (['again', 'hard', 'good', 'easy'].includes(fsrs.lastRating)) {
            safeFsrs.lastRating = fsrs.lastRating;
        }
        result[kanji] = { kanji, attempts, successes, last, next, fsrs: safeFsrs };
    }
    return result;
}

// One observation per distinct kanji per staged word attempt. Results are
// aligned to card.characters, not to the row's written form (kana is ignored).
// The same observation is never counted twice after guided recovery.
export function recordKanjiObservations(mastery, characters, grades, timestamp,
    recorded = [], reviewed = []) {
    const seen = new Set(recorded);
    const grouped = new Map();
    (characters || []).forEach((character, index) => {
        const kanji = character?.character;
        const grade = grades?.[index];
        if (!isTrackableKanji(kanji) || !Number.isInteger(grade) ||
            grade < 0 || grade > 3 || seen.has(kanji)) return;
        grouped.set(kanji, Math.max(grouped.get(kanji) ?? 0, grade));
    });
    const additions = [];
    for (const [kanji, grade] of grouped) {
        const entry = mastery[kanji] || { kanji, attempts: 0, successes: 0 };
        const schedule = applyFsrsResult(entry, grade, timestamp);
        entry.attempts = (entry.attempts || 0) + 1;
        entry.successes = (entry.successes || 0) + (grade < 3 ? 1 : 0);
        entry.last = timestamp;
        entry.next = timestamp + schedule.intervalSeconds;
        mastery[kanji] = entry;
        seen.add(kanji);
        if (!reviewed.includes(kanji)) reviewed.push(kanji);
        additions.push({ kanji, grade, next: entry.next });
    }
    return { recorded: [...seen], additions };
}

// A due kanji is practiced in a *single-character* card with one active
// vocabulary word supplying its reading/meaning as context. The vocabulary
// entry and its due time are never modified by these standalone drills.
export function dueKanjiDrills(mastery, activeWords, getWritten,
    getPracticeCharacter, timestamp, blockedWords = new Set(), reviewed = []) {
    const contexts = new Map();
    for (const entry of activeWords) {
        if (!(entry?.attempts > 0) || blockedWords.has(entry.word)) continue;
        const chars = Array.from(getWritten(entry) || '');
        chars.forEach((kanji, position) => {
            if (contexts.has(kanji) || !isTrackableKanji(kanji) ||
                !getPracticeCharacter(kanji)) return;
            contexts.set(kanji, { kanji, word: entry.word, entry,
                position, wordLength: chars.length });
        });
    }
    return Object.entries(mastery || {})
        .filter(([kanji, entry]) =>
            contexts.has(kanji) && !reviewed.includes(kanji) &&
            entry?.attempts > 0 && isFsrsDue(entry, timestamp))
        .sort((a, b) => Number(a[1].next || 0) - Number(b[1].next || 0))
        .map(([kanji]) => contexts.get(kanji));
}

export function kanjiMasterySummary(mastery, activeWords, getWritten, timestamp) {
    const active = new Set(activeWords.flatMap((entry) =>
        Array.from(getWritten(entry) || '').filter(isTrackableKanji)));
    let studied = 0, due = 0, strong = 0;
    for (const kanji of active) {
        const entry = mastery?.[kanji];
        if (!entry?.attempts) continue;
        studied++;
        if (isFsrsDue(entry, timestamp)) due++;
        if (ensureFsrsState(entry).state === 'review' &&
            Number(entry.fsrs.stability || 0) >= 21) strong++;
    }
    return { studied, due, strong };
}
