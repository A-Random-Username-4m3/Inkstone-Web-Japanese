'use strict';

// Matcher ported from the original Inkstone lib/matcher modules.
const kAngleThreshold = Math.PI / 5;
const kDistanceThreshold = 0.3;
const kLengthThreshold = 1.5;
const kMaxMissedSegments = 1;
const kMaxOutOfOrder = 2;
const kMinDistance = 1 / 16;
const kMissedSegmentPenalty = 1;
const kOutOfOrderPenalty = 2;
const kReversePenalty = 2;
const kEndpointTruncation = 1 / 64;
const kMinFirstSegmentFraction = 0.1;
const kMinLastSegmentFraction = 0.05;
const kHookShapes = [
	[
		[1, 3],
		[-3, -1]
	],
	[
		[3, 3],
		[0, -1]
	]
];
const kTerminalHookShapes = [
	[
		[4, 0],
		[0, 4],
		[4, 0],
		[0, -1]
	],
	[
		[0, 4],
		[4, 0],
		[0, -1]
	]
];

const range = (start, end = null) => {
	if (end === null) {
		end = start;
		start = 0;
	}
	return Array.from(
		{ length: Math.max(0, end - start) },
		(_, i) => start + i
	);
};

const geom = {
	distance2: (point1, point2) =>
		geom.norm2(geom.subtract(point1, point2)),
	clone: (point) => [point[0], point[1]],
	norm2: (point) => point[0] * point[0] + point[1] * point[1],
	subtract: (point1, point2) => [
		point1[0] - point2[0],
		point1[1] - point2[1]
	]
};

class Shortstraw {
	constructor() {
		this.DIAGONAL_INTERVAL = 100;
		this.STRAW_WINDOW = 3;
		this.MEDIAN_THRESHOLD = 0.95;
		this.LINE_THRESHOLDS = [0.95, 0.9, 0.8];
	}
	run(points) {
		if (!points || points.length < 2) return points || [];
		points = points.map((x) => ({ x: x[0], y: x[1] }));
		const spacing = this._determineResampleSpacing(points);
		if (!Number.isFinite(spacing) || spacing <= 0)
			return points.map((p) => [p.x, p.y]);
		const resampled = this._resamplePoints(points, spacing);
		if (resampled.length < 2) return resampled.map((p) => [p.x, p.y]);
		const corners = this._getCorners(resampled);
		return corners.map((i) => [resampled[i].x, resampled[i].y]);
	}
	_addAcuteAngles(points, corners) {
		const temp = corners.slice();
		corners.length = 1;
		for (let i = 1; i < temp.length; i++) {
			let bestIndex = null;
			let bestAngle = Math.PI / 2;
			const cutoff = Math.max(
				1,
				Math.round(0.1 * (temp[i] - temp[i - 1]))
			);
			for (let j = temp[i - 1] + cutoff; j <= temp[i] - cutoff; j++) {
				const angle = Math.abs(
					this._getAngle(points, temp[i - 1], j, temp[i])
				);
				if (angle > bestAngle) {
					bestAngle = angle;
					bestIndex = j;
				}
			}
			if (bestIndex !== null) corners.push(bestIndex);
			corners.push(temp[i]);
		}
	}
	_determineResampleSpacing(points) {
		const box = this._getBoundingBox(points);
		const p1 = { x: box.x, y: box.y };
		const p2 = { x: box.x + box.w, y: box.y + box.h };
		return this._getDistance(p1, p2) / this.DIAGONAL_INTERVAL;
	}
	_getAngle(points, i, j, k) {
		const d1 = [points[j].x - points[i].x, points[j].y - points[i].y];
		const d2 = [points[k].x - points[j].x, points[k].y - points[j].y];
		const a1 = Math.atan2(d1[1], d1[0]);
		const a2 = Math.atan2(d2[1], d2[0]);
		const a = Math.abs(a2 - a1);
		if (a < -Math.PI) return a + 2 * Math.PI;
		if (a >= Math.PI) return a - 2 * Math.PI;
		return a;
	}
	_getBoundingBox(points) {
		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		points.forEach((point) => {
			minX = Math.min(minX, point.x);
			maxX = Math.max(maxX, point.x);
			minY = Math.min(minY, point.y);
			maxY = Math.max(maxY, point.y);
		});
		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
	}
	_getCorners(points) {
		const corners = [0];
		const straws = new Array(points.length);
		const w = this.STRAW_WINDOW;
		if (points.length <= 2 * w + 1) return [0, points.length - 1];
		for (let i = w; i < points.length - w; i++) {
			straws[i] = this._getDistance(points[i - w], points[i + w]);
		}
		const t = this._median(straws) * this.MEDIAN_THRESHOLD;
		for (let i = w; i < points.length - w; i++) {
			if (straws[i] < t) {
				let localMin = Number.POSITIVE_INFINITY;
				let localMinIndex = i;
				while (i < straws.length && straws[i] < t) {
					if (straws[i] < localMin) {
						localMin = straws[i];
						localMinIndex = i;
					}
					i++;
				}
				corners.push(localMinIndex);
			}
		}
		corners.push(points.length - 1);
		this.LINE_THRESHOLDS.forEach((threshold) =>
			this._postProcessCorners(points, corners, straws, threshold)
		);
		this._addAcuteAngles(points, corners);
		return corners;
	}
	_getDistance(p1, p2) {
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		return Math.sqrt(dx * dx + dy * dy);
	}
	_halfwayCorner(straws, a, b) {
		const quarter = (b - a) / 4;
		let minValue = Number.POSITIVE_INFINITY;
		let minIndex = Math.floor((a + b) / 2);
		for (let i = Math.ceil(a + quarter); i < b - quarter; i++) {
			if (straws[i] < minValue) {
				minValue = straws[i];
				minIndex = i;
			}
		}
		return minIndex;
	}
	_isLine(points, a, b, threshold) {
		const dist = this._getDistance(points[a], points[b]);
		const pathDist = this._pathDistance(points, a, b);
		return pathDist === 0 || dist / pathDist > threshold;
	}
	_median(values) {
		const sorted = values
			.filter((x) => Number.isFinite(x))
			.concat()
			.sort((a, b) => a - b);
		if (!sorted.length) return 0;
		const i = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0
			? (sorted[i - 1] + sorted[i]) / 2
			: sorted[i];
	}
	_pathDistance(points, a, b) {
		let d = 0;
		for (let i = a; i < b; i++)
			d += this._getDistance(points[i], points[i + 1]);
		return d;
	}
	_postProcessCorners(points, corners, straws, threshold) {
		let go = false;
		while (!go) {
			go = true;
			for (let i = 1; i < corners.length; i++) {
				const c1 = corners[i - 1];
				const c2 = corners[i];
				if (!this._isLine(points, c1, c2, threshold)) {
					const newCorner = this._halfwayCorner(straws, c1, c2);
					if (newCorner > c1 && newCorner < c2) {
						corners.splice(i, 0, newCorner);
						go = false;
					}
				}
			}
		}
		for (let i = 1; i < corners.length - 1; i++) {
			const c1 = corners[i - 1];
			const c2 = corners[i + 1];
			if (this._isLine(points, c1, c2, threshold)) {
				corners.splice(i, 1);
				i--;
			}
		}
	}
	_resamplePoints(points, spacing) {
		const resampled = [points[0]];
		let dist = 0;
		for (let i = 1; i < points.length; i++) {
			const p1 = points[i - 1];
			const p2 = points[i];
			const d2 = this._getDistance(p1, p2);
			if (d2 === 0) continue;
			if (dist + d2 >= spacing) {
				const qx = p1.x + ((spacing - dist) / d2) * (p2.x - p1.x);
				const qy = p1.y + ((spacing - dist) / d2) * (p2.y - p1.y);
				const q = { x: qx, y: qy };
				resampled.push(q);
				points.splice(i, 0, q);
				dist = 0;
			} else {
				dist += d2;
			}
		}
		resampled.push(points[points.length - 1]);
		return resampled;
	}
}

function matcherAngleDiff(angle1, angle2) {
	const diff = Math.abs(angle1 - angle2);
	return Math.min(diff, 2 * Math.PI - diff);
}
function matcherGetAngle(median) {
	const diff = geom.subtract(median[median.length - 1], median[0]);
	return Math.atan2(diff[1], diff[0]);
}
function matcherGetBounds(median) {
	const low = [Infinity, Infinity];
	const high = [-Infinity, -Infinity];
	median.forEach((point) => {
		low[0] = Math.min(low[0], point[0]);
		low[1] = Math.min(low[1], point[1]);
		high[0] = Math.max(high[0], point[0]);
		high[1] = Math.max(high[1], point[1]);
	});
	return [low, high];
}
function matcherGetMidpoint(median) {
	const bounds = matcherGetBounds(median);
	return [
		(bounds[0][0] + bounds[1][0]) / 2,
		(bounds[0][1] + bounds[1][1]) / 2
	];
}
function matcherGetMinimumLength(pair) {
	return Math.sqrt(geom.distance2(pair[0], pair[1])) + kMinDistance;
}
function matcherShapeMatch(median, shape) {
	if (median.length !== shape.length + 1) return false;
	for (let i = 0; i < shape.length; i++) {
		const angle = matcherAngleDiff(
			matcherGetAngle(median.slice(i, i + 2)),
			matcherGetAngle([[0, 0], shape[i]])
		);
		if (angle >= kAngleThreshold) return false;
	}
	return true;
}
function matcherHasHook(median) {
	if (median.length < 3) return false;
	if (median.length > 3) return true;
	for (const shape of kHookShapes)
		if (matcherShapeMatch(median, shape)) return true;
	return false;
}
function scorePairing(source, target, isInitialSegment) {
	const angle = matcherAngleDiff(
		matcherGetAngle(source),
		matcherGetAngle(target)
	);
	const distanceScore = Math.sqrt(
		geom.distance2(
			matcherGetMidpoint(source),
			matcherGetMidpoint(target)
		)
	);
	const length = Math.abs(
		Math.log(
			matcherGetMinimumLength(source) /
				matcherGetMinimumLength(target)
		)
	);
	if (
		angle > (isInitialSegment ? 1 : 2) * kAngleThreshold ||
		distanceScore > kDistanceThreshold ||
		length > kLengthThreshold
	) {
		return -Infinity;
	}
	return -(angle + distanceScore + length);
}
function performAlignment(source, target) {
	source = source.map(geom.clone);
	target = target.map(geom.clone);
	if (source.length < 2 || target.length < 2)
		return {
			score: -Infinity,
			penalties: 0,
			source: null,
			target: null,
			warning: null
		};
	const memo = [range(source.length).map((j) => (j > 0 ? -Infinity : 0))];
	for (let i = 1; i < target.length; i++) {
		const row = [-Infinity];
		for (let j = 1; j < source.length; j++) {
			let bestValue = -Infinity;
			const start = Math.max(j - kMaxMissedSegments - 1, 0);
			for (let k = start; k < j; k++) {
				if (memo[i - 1][k] === -Infinity) continue;
				const score = scorePairing(
					[source[k], source[j]],
					[target[i - 1], target[i]],
					i === 1
				);
				const penalty = (j - k - 1) * kMissedSegmentPenalty;
				bestValue = Math.max(
					bestValue,
					score + memo[i - 1][k] - penalty
				);
			}
			row.push(bestValue);
		}
		memo.push(row);
	}
	const result = {
		score: -Infinity,
		penalties: 0,
		source: null,
		target: null,
		warning: null
	};
	const minMatched = target.length - (matcherHasHook(target) ? 1 : 0);
	for (let i = minMatched - 1; i < target.length; i++) {
		const penalty = (target.length - i - 1) * kMissedSegmentPenalty;
		const score = memo[i][source.length - 1] - penalty;
		if (score > result.score) {
			result.penalties = 0;
			result.score = score;
			result.source = [source[0], source[source.length - 1]];
			result.target = [target[0], target[i]];
			result.warning = i < target.length - 1 ? 'Should hook.' : null;
		}
	}
	return result;
}
function recognize(source, target, offset) {
	if (offset > kMaxOutOfOrder) return { score: -Infinity, penalties: 0 };
	let result = performAlignment(source, target);
	if (result.score === -Infinity) {
		const alternative = performAlignment(
			source.slice().reverse(),
			target
		);
		if (!alternative.warning) {
			result = alternative;
			result.penalties += 1;
			result.score -= kReversePenalty;
			result.warning = 'Stroke backward.';
		}
	}
	result.score -= Math.abs(offset) * kOutOfOrderPenalty;
	return result;
}

function medianDistance(point1, point2) {
	const diff = [point1[0] - point2[0], point1[1] - point2[1]];
	return Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
}
function pathLength(median) {
	let total = 0;
	for (let i = 0; i < median.length - 1; i++)
		total += medianDistance(median[i], median[i + 1]);
	return total;
}
function refine(median, n) {
	const total = pathLength(median);
	if (!total || median.length < 2) return median;
	const result = [];
	let index = 0;
	let position = median[0];
	let totalSoFar = 0;
	for (const i of range(n - 1)) {
		const target = (i * total) / (n - 1);
		while (totalSoFar < target && index < median.length - 1) {
			const step = medianDistance(position, median[index + 1]);
			if (totalSoFar + step < target) {
				index += 1;
				position = median[index];
				totalSoFar += step;
			} else {
				const t = (target - totalSoFar) / step;
				position = [
					(1 - t) * position[0] + t * median[index + 1][0],
					(1 - t) * position[1] + t * median[index + 1][1]
				];
				totalSoFar = target;
			}
		}
		result.push([position[0], position[1]]);
	}
	result.push(median[median.length - 1]);
	return result;
}
function truncate(median, truncation) {
	const n = 64;
	const length = pathLength(median);
	if (!length) return median;
	const index = Math.round(n * Math.min(truncation / length, 0.25));
	return refine(median, n).slice(index, n - index);
}
function dropDanglingHooks(median) {
	const n = median.length;
	if (n < 3) return median;
	const indicesToDrop = {};
	if (medianDistance(median[0], median[1]) < kMinFirstSegmentFraction)
		indicesToDrop[1] = true;
	if (
		medianDistance(median[n - 2], median[n - 1]) <
		kMinLastSegmentFraction
	)
		indicesToDrop[n - 2] = true;
	return median.filter((value, i) => !indicesToDrop[i]);
}
function dropTerminalHookCorner(median) {
	if (median.length === 2) return median;
	const indicesToDrop = {};
	for (const shape of kTerminalHookShapes) {
		if (matcherShapeMatch(median, shape))
			indicesToDrop[shape.length - 2] = true;
	}
	return median.filter((value, i) => !indicesToDrop[i]);
}
function normalizeReferenceMedians(medians) {
	return medians.map((median) => truncate(median, kEndpointTruncation));
}

function findCorners(medians) {
	const shortstraw = new Shortstraw();
	return normalizeReferenceMedians(medians)
		.map(shortstraw.run.bind(shortstraw))
		.map(dropDanglingHooks)
		.map(dropTerminalHookCorner);
}


export class Matcher {
	constructor(characterData) {
		this._medians = findCorners(characterData.medians || []);
		this._candidates = this._medians.map((median, index) => ({
			indices: [index],
			median
		}));
	}
	match(stroke, missing) {
		if (!missing.length) return { indices: [], score: -Infinity };
		stroke = new Shortstraw().run(stroke);
		let bestResult = { indices: [], score: -Infinity };
		this._candidates.forEach((candidate) => {
			const firstIndex = Math.min(...candidate.indices);
			const offset = firstIndex - missing[0];
			const result = recognize(stroke, candidate.median, offset);
			if (result.score > bestResult.score) {
				bestResult = {
					indices: candidate.indices,
					penalties: result.penalties || 0,
					score: result.score,
					source_segment: result.source,
					target_segment: result.target,
					warning: result.warning
				};
			}
		});
		return bestResult;
	}
}

export function distance(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
export function strokeLength(stroke) {
	let total = 0;
	for (let i = 0; i < stroke.length - 1; i++)
		total += distance(stroke[i], stroke[i + 1]);
	return total;
}