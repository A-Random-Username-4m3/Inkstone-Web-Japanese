'use strict';

import { ONE_DAY } from './constants.js';

const DEFAULT_FSRS_PARAMETERS = [
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
	0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
	1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542
];

export const DEFAULT_SCHEDULING = {
	sessionHours: 12,
	desiredRetention: 0.9,
	maximumIntervalDays: 36500,
	learningStepMinutes: 10,
	relearningStepMinutes: 10,
	newCardOrder: 'sequential',
	reviewOrder: 'retrievability',
	newCardsIgnoreReviewLimit: false,
	fsrsParameters: DEFAULT_FSRS_PARAMETERS.join(', '),
	debugNow: null
};

const FSRS_STABILITY_MIN = 0.001;
const FSRS_INITIAL_STABILITY_MIN = 0.1;
const FSRS_PARAMETER_LOWER_BOUNDS = [
	0.001, 0.001, 0.001, 0.001, 1.0, 0.001, 0.001,
	0.001, 0.0, 0.0, 0.001, 0.001, 0.001, 0.001,
	0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.1
];
const FSRS_PARAMETER_UPPER_BOUNDS = [
	100.0, 100.0, 100.0, 100.0, 10.0, 4.0, 4.0,
	0.75, 4.5, 0.8, 3.5, 5.0, 0.25, 0.9,
	4.0, 1.0, 6.0, 2.0, 2.0, 0.8, 0.8
];
const FSRS_FUZZ_RANGES = [
	{ start: 2.5, end: 7.0, factor: 0.15 },
	{ start: 7.0, end: 20.0, factor: 0.10 },
	{ start: 20.0, end: Infinity, factor: 0.05 }
];
const FSRS_CARD_STATES = new Set([
	'new',
	'learning',
	'review',
	'relearning'
]);

let environment = {
	getSettings: () => ({}),
	now: () => Math.floor(Date.now() / 1000),
	learningStepInterval: () => 10 * 60,
	relearningStepInterval: () => 10 * 60
};
let cachedFsrsParameterText = null;
let cachedFsrsParameters = null;

export function configureFsrs(options = {}) {
	environment = { ...environment, ...options };
	cachedFsrsParameterText = null;
	cachedFsrsParameters = null;
}

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const settings = () => environment.getSettings?.() || {};
const now = () => environment.now?.() ?? Math.floor(Date.now() / 1000);

export function fsrsDesiredRetention() {
	return clamp(
		Number(settings().desiredRetention) || DEFAULT_SCHEDULING.desiredRetention,
		0.7,
		0.97
	);
}

export function fsrsMaximumIntervalDays() {
	const value = Number(settings().maximumIntervalDays);
	return Math.max(
		1,
		Math.round(
			Number.isFinite(value)
				? value
				: DEFAULT_SCHEDULING.maximumIntervalDays
		)
	);
}

function parseFsrsParameters(value) {
	const numbers = String(value || '')
		.split(/[\s,]+/)
		.map((item) => Number(item.trim()))
		.filter((item) => Number.isFinite(item));
	if (numbers.length !== DEFAULT_FSRS_PARAMETERS.length) {
		return DEFAULT_FSRS_PARAMETERS.slice();
	}
	const valid = numbers.every((parameter, index) =>
		parameter >= FSRS_PARAMETER_LOWER_BOUNDS[index] &&
		parameter <= FSRS_PARAMETER_UPPER_BOUNDS[index]
	);
	return valid ? numbers : DEFAULT_FSRS_PARAMETERS.slice();
}

export function normalizeFsrsParametersText(value) {
	return parseFsrsParameters(value).join(', ');
}

export function fsrsParameters() {
	const text = String(settings().fsrsParameters || '');
	if (text !== cachedFsrsParameterText || !cachedFsrsParameters) {
		cachedFsrsParameterText = text;
		cachedFsrsParameters = parseFsrsParameters(text);
	}
	return cachedFsrsParameters.slice();
}

function fsrsConstants(w = fsrsParameters()) {
	const decay = -w[20];
	return { decay, factor: Math.pow(0.9, 1 / decay) - 1 };
}

function fsrsRatingFromResult(result) {
	if (result === 0) return 'easy';
	if (result === 1) return 'good';
	if (result === 2) return 'hard';
	return 'again';
}

export function fsrsRatingNumber(rating) {
	return { again: 1, hard: 2, good: 3, easy: 4 }[rating] || 1;
}

export function fsrsStateNumber(stateName) {
	return {
		new: 0,
		learning: 1,
		review: 2,
		relearning: 3
	}[String(stateName || '').toLowerCase()] ?? 0;
}

function constrainDifficulty(difficulty) {
	return clamp(Number(difficulty), 1, 10);
}

function constrainStability(stability) {
	return Math.max(FSRS_STABILITY_MIN, Number(stability));
}

function initFsrsDifficulty(
	rating,
	w = fsrsParameters(),
	shouldClamp = true
) {
	const value = w[4] - Math.exp(w[5] * (fsrsRatingNumber(rating) - 1)) + 1;
	return shouldClamp ? constrainDifficulty(value) : value;
}

function initFsrsStability(rating, w = fsrsParameters()) {
	return Math.max(
		FSRS_INITIAL_STABILITY_MIN,
		constrainStability(w[fsrsRatingNumber(rating) - 1])
	);
}

function linearDamping(delta, difficulty) {
	return delta * (10 - difficulty) / 9;
}

function meanReversion(initial, current, w = fsrsParameters()) {
	return w[7] * initial + (1 - w[7]) * current;
}

function nextFsrsDifficulty(difficulty, rating, w = fsrsParameters()) {
	const delta = -w[6] * (fsrsRatingNumber(rating) - 3);
	const next = difficulty + linearDamping(delta, difficulty);
	return constrainDifficulty(
		meanReversion(initFsrsDifficulty('easy', w, false), next, w)
	);
}

function fsrsForgettingCurve(elapsedDays, stability, w = fsrsParameters()) {
	const { decay, factor } = fsrsConstants(w);
	return Math.pow(1 + factor * elapsedDays / stability, decay);
}

function nextRecallStability(difficulty, stability, retrievability,
	rating, w = fsrsParameters()) {
	const hardPenalty = rating === 'hard' ? w[15] : 1;
	const easyBonus = rating === 'easy' ? w[16] : 1;
	const value = stability * (
		1 +
		Math.exp(w[8]) *
		(11 - difficulty) *
		Math.pow(stability, -w[9]) *
		(Math.exp((1 - retrievability) * w[10]) - 1) *
		hardPenalty *
		easyBonus
	);
	return constrainStability(value);
}

function nextForgetStability(difficulty, stability, retrievability,
	w = fsrsParameters()) {
	const minimum = stability / Math.exp(w[17] * w[18]);
	const value =
		w[11] *
		Math.pow(difficulty, -w[12]) *
		(Math.pow(stability + 1, w[13]) - 1) *
		Math.exp((1 - retrievability) * w[14]);
	return constrainStability(Math.min(value, minimum));
}

function nextShortTermStability(stability, rating, w = fsrsParameters()) {
	let increase =
		Math.exp(w[17] * (fsrsRatingNumber(rating) - 3 + w[18])) *
		Math.pow(stability, -w[19]);
	if (rating !== 'again') increase = Math.max(increase, 1);
	return constrainStability(stability * increase);
}

function fsrsIntervalDays(stability) {
	const w = fsrsParameters();
	const { decay, factor } = fsrsConstants(w);
	const interval = stability / factor *
		(Math.pow(fsrsDesiredRetention(), 1 / decay) - 1);
	return clamp(
		Math.round(interval),
		1,
		fsrsMaximumIntervalDays()
	);
}

function fuzzFsrsIntervalDays(intervalDays, elapsedDays = 0) {
	elapsedDays = Math.max(0, Math.floor(Number(elapsedDays) || 0));
	if (intervalDays < 2.5) return intervalDays;
	let delta = 1;
	for (const range of FSRS_FUZZ_RANGES) {
		delta += range.factor * Math.max(
			Math.min(intervalDays, range.end) - range.start,
			0
		);
	}
	let minimum = Math.round(intervalDays - delta);
	let maximum = Math.round(intervalDays + delta);
	minimum = Math.max(2, minimum);
	maximum = Math.min(maximum, fsrsMaximumIntervalDays());
	if (intervalDays > elapsedDays) {
		minimum = Math.max(minimum, elapsedDays + 1);
	}
	minimum = Math.min(minimum, maximum);
	return Math.min(
		Math.floor(Math.random() * (maximum - minimum + 1)) + minimum,
		fsrsMaximumIntervalDays()
	);
}

export function fsrsIntervalSeconds(
	stability,
	fuzz = false,
	elapsedDays = 0
) {
	let days = fsrsIntervalDays(stability);
	if (fuzz) days = fuzzFsrsIntervalDays(days, elapsedDays);
	return days * ONE_DAY;
}

function normalizeFsrsCardState(entry, fsrs = entry?.fsrs) {
	const stateName = String(fsrs?.state || '').toLowerCase();
	if (FSRS_CARD_STATES.has(stateName)) {
		if (stateName === 'new' && (entry?.attempts || 0)) return 'review';
		return stateName;
	}
	return (entry?.attempts || 0) ? 'review' : 'new';
}

export function ensureFsrsState(entry) {
	entry.fsrs = entry.fsrs && typeof entry.fsrs === 'object'
		? entry.fsrs
		: {};
	entry.fsrs.reps = Number(entry.fsrs.reps || 0);
	entry.fsrs.lapses = Number(entry.fsrs.lapses || 0);

	let stateName = normalizeFsrsCardState(entry, entry.fsrs);
	if (!(entry.attempts || 0)) {
		entry.fsrs.state = 'new';
		return entry.fsrs;
	}
	if (stateName === 'new') stateName = 'review';

	const hasState =
		Number.isFinite(Number(entry.fsrs.difficulty)) &&
		Number.isFinite(Number(entry.fsrs.stability));
	if (hasState) {
		entry.fsrs.stability = constrainStability(entry.fsrs.stability);
		entry.fsrs.difficulty = constrainDifficulty(entry.fsrs.difficulty);
		entry.fsrs.state = stateName;
		return entry.fsrs;
	}

	const intervalDays = entry.last && entry.next
		? Math.max(FSRS_STABILITY_MIN, Math.abs(entry.next - entry.last) / ONE_DAY)
		: 1;
	entry.fsrs.difficulty = 5;
	entry.fsrs.stability = constrainStability(intervalDays);
	entry.fsrs.lastReview = entry.last || null;
	entry.fsrs.retrievability = entry.next && entry.next > now()
		? fsrsDesiredRetention()
		: getFsrsRetrievability(entry);
	entry.fsrs.state = stateName;
	return entry.fsrs;
}

export function getEntrySchedulerState(entry) {
	if (!entry || !(entry.attempts || 0)) return 'new';
	const fsrs = ensureFsrsState(entry);
	return normalizeFsrsCardState(entry, fsrs);
}

export function setEntrySchedulerState(entry, stateName) {
	const normalized = FSRS_CARD_STATES.has(stateName) ? stateName : 'review';
	entry.fsrs = entry.fsrs && typeof entry.fsrs === 'object'
		? entry.fsrs
		: {};
	entry.fsrs.state = normalized;
	return normalized;
}

export function isFsrsDue(entry, t = now()) {
	if (!entry || !(entry.attempts || 0)) return false;
	const stateName = getEntrySchedulerState(entry);
	return stateName !== 'new' && (!entry.next || (entry.next || 0) <= t);
}

function fsrsElapsedDays(ts, lastReview) {
	if (!lastReview) return 0;
	return Math.max(0, (ts - lastReview) / ONE_DAY);
}

function fsrsElapsedReviewDays(ts, lastReview) {
	return Math.floor(fsrsElapsedDays(ts, lastReview));
}

export function getFsrsRetrievability(entry, ts = now()) {
	if (!entry || !(entry.attempts || 0)) return 0;
	const fsrs = ensureFsrsState(entry);
	if (!fsrs.stability || !fsrs.lastReview) return 0;
	const elapsedDays = fsrsElapsedDays(ts, fsrs.lastReview);
	return fsrsForgettingCurve(elapsedDays, Number(fsrs.stability));
}

export function applyFsrsResult(entry, result, ts = now()) {
	const rating = fsrsRatingFromResult(result);
	const fsrs = ensureFsrsState(entry);
	const w = fsrsParameters();
	const hasMemory =
		Number.isFinite(Number(fsrs.difficulty)) &&
		Number.isFinite(Number(fsrs.stability)) &&
		!!fsrs.lastReview;
	const previousState = fsrs.state || (hasMemory ? 'review' : 'learning');
	let difficulty;
	let stability;
	let retrievability;
	let elapsedDays = 0;

	if (!hasMemory) {
		difficulty = initFsrsDifficulty(rating, w);
		stability = initFsrsStability(rating, w);
		retrievability = 1;
	} else {
		const oldDifficulty = Number(fsrs.difficulty);
		const oldStability = constrainStability(fsrs.stability);
		elapsedDays = fsrsElapsedReviewDays(ts, fsrs.lastReview);
		retrievability = fsrsForgettingCurve(elapsedDays, oldStability, w);
		difficulty = nextFsrsDifficulty(oldDifficulty, rating, w);
		stability = elapsedDays < 1
			? nextShortTermStability(oldStability, rating, w)
			: rating === 'again'
				? nextForgetStability(
					oldDifficulty,
					oldStability,
					retrievability,
					w
				)
				: nextRecallStability(
					oldDifficulty,
					oldStability,
					retrievability,
					rating,
					w
				);
	}

	let nextState = 'review';
	let intervalSeconds = fsrsIntervalSeconds(
		stability,
		true,
		elapsedDays
	);
	if (rating === 'again') {
		if (!hasMemory || previousState === 'learning') {
			nextState = 'learning';
			intervalSeconds = environment.learningStepInterval?.() ?? 10 * 60;
		} else {
			nextState = 'relearning';
			intervalSeconds = environment.relearningStepInterval?.() ?? 10 * 60;
		}
	}

	entry.fsrs = {
		...fsrs,
		version: 'fsrs-6.1.1-compatible',
		difficulty,
		stability,
		retrievability,
		lastReview: ts,
		reps: Number(fsrs.reps || 0) + 1,
		lapses: Number(fsrs.lapses || 0) + (
			hasMemory && previousState === 'review' && rating === 'again' ? 1 : 0
		),
		lastRating: rating,
		state: nextState,
		step: nextState === 'review' ? null : 0
	};

	return {
		rating,
		difficulty,
		stability,
		retrievability,
		state: nextState,
		intervalSeconds
	};
}