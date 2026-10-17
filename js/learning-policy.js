// Learning feedback and review scheduling are deliberately separate:
// completion after a failed recall teaches the character, but does not turn
// the original memory test into a success for vocabulary-level FSRS.
export function gradeCharacterAttempt({ stage, penalties = 0, assisted = false, failed = false }) {
    const count = Math.max(0, Number(penalties) || 0);
    const penaltyGrade = count <= 2 ? 1 : count <= 4 ? 2 : 3;
    if (failed) return 3; // Again, even after a successful guided retry.
    if (assisted && stage > 1) return Math.max(2, penaltyGrade);
    return penaltyGrade;
}

// Gap is measured in *other cards shown*, not elapsed time or FSRS days.
// Smaller decks still need the queue's fallback to avoid getting stuck.
export function stagedSpacingTurns(nextStage, result, minimum = 1) {
    if (result === 3) return 1;
    if (result === 2) return 2;
    const gaps = [0, 1, 2, 3, 5, 8];
    return Math.max(minimum, gaps[nextStage] ?? minimum);
}

// Excellent can skip one introductory step, but not every assisted stage:
// the last stage must always be an independent recall attempt.
export function nextStageAfterResult(stage, result, forceSequential = false, maxStage = 5) {
    if (result === 3) return 1;
    if (result === 2) return stage;
    if (!forceSequential && result === 0 && stage === 1) return Math.min(3, maxStage);
    return stage + 1;
}

// Kana require no teaching ladder. Keep this logic independent from KanjiVG
// availability: we identify glyphs, not whether a stroke record is loaded.
export function isKana(value) {
    return typeof value === 'string' && Array.from(value).length === 1 &&
        (/^[\p{Script=Hiragana}\p{Script=Katakana}\uFF66-\uFF9F]$/u.test(value) ||
         value === '\u30FC' || value === '\uFF70');
}

// A *prior* successful unaided kanji observation can shorten the introduction
// of that glyph in a newly added vocabulary word. Don't infer mastery from
// vocabulary history, and don't infer it from the current word's first pass.
export function familiarCharacterIndices(characters, mastery) {
    return (characters || []).flatMap((item, index) => {
        const entry = mastery?.[item?.character];
        return typeof item?.character === 'string' &&
            /^\p{Script=Han}$/u.test(item.character) &&
            entry?.successes > 0 && entry.fsrs?.lastRating !== 'again'
            ? [index] : [];
    });
}

// Stage is per character *within* a word. Previously tested kanji use the
// existing timed Stage 2 preview on the initial word pass; successful preview
// unlocks Stage 5 on the remaining passes. Any failed shortcut falls back to
// the normal stage ladder. Kana always use Stage 5.
export function characterPracticeStage(card, index, wordStage = card?.stage || 1) {
    if (isKana(card?.characters?.[index]?.character)) return 5;
    if (!card?.fastTrackCandidates?.includes(index) ||
        card?.fastTrackRejected?.includes(index)) return wordStage;
    if (wordStage === 1) return 2;
    if (card?.fastTrackReady?.includes(index)) return 5;
    return wordStage;
}
