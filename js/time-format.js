import { ONE_DAY } from './constants.js';

export function formatDateTimeLocal(seconds) {
	if (!Number.isFinite(Number(seconds))) return '';
	const date = new Date(Number(seconds) * 1000);
	if (!Number.isFinite(date.getTime())) return '';
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
	return local.toISOString().slice(0, 16);
}

export function parseDateTimeLocalSeconds(value) {
	if (!value) return null;
	const date = new Date(value);
	const time = date.getTime();
	return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

export function formatDebugClockDisplay(seconds) {
	if (!Number.isFinite(Number(seconds))) return 'real browser time';
	return new Date(Number(seconds) * 1000).toLocaleString([], {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function formatDebugTimeStatus(debugNow, realNow) {
	if (debugNow == null) return 'Using real browser time.';
	const delta = debugNow - realNow;
	const relation = delta >= 0
		? `${formatCompactDuration(delta)} ahead of real time`
		: `${formatCompactDuration(-delta)} behind real time`;
	return `Debug app time active: ${formatDebugClockDisplay(debugNow)} (${relation}).`;
}

export function formatDuration(seconds, includeSeconds = false) {
	seconds = Math.max(0, Math.floor(seconds || 0));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (includeSeconds)
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
	return `${hours}:${String(minutes).padStart(2, '0')}`;
}

export function formatRelativeDue(seconds) {
	seconds = Math.floor(seconds || 0);
	if (seconds <= 0)
		return seconds < -60
			? `Overdue by ${formatCompactDuration(-seconds)}`
			: 'Due now';
	return `in ${formatCompactDuration(seconds)}`;
}

function formatCompactDuration(seconds) {
	seconds = Math.max(0, Math.floor(seconds || 0));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < ONE_DAY)
		return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
	return `${Math.floor(seconds / ONE_DAY)}d ${Math.floor((seconds % ONE_DAY) / 3600)}h`;
}

export function formatClockDuration(seconds) {
	seconds = Math.max(0, Math.floor(seconds || 0));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0)
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
	return `${minutes}:${String(secs).padStart(2, '0')}`;
}
