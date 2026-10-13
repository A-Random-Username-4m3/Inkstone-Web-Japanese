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
