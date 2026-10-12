export const JAPANESE_STORAGE_KEY = 'inkstone.japanese.web.state.v1';
export const LEGACY_SHARED_STORAGE_KEY = 'inkstone.web.state.v1';
export const JAPANESE_REVIEW_DB_NAME = 'inkstone-japanese-review-logs';
export const LEGACY_SHARED_REVIEW_DB_NAME = 'inkstone-review-logs';
export const LEGACY_REVIEW_MIGRATION_PENDING_KEY =
	'inkstone.japanese.review-log-migration.pending.v1';

function isJapaneseState(raw) {
	if (!raw) return false;
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed?.version === 'string' &&
			parsed.version.startsWith('inkstone-japanese-');
	} catch (_error) {
		return false;
	}
}

export function migrateLegacyJapaneseStorage(storage) {
	const current = storage.getItem(JAPANESE_STORAGE_KEY);
	const pending = storage.getItem(LEGACY_REVIEW_MIGRATION_PENDING_KEY) === '1';
	if (current !== null) {
		return {
			stateMigrated: false,
			shouldMigrateReviewLogs: pending
		};
	}

	const legacy = storage.getItem(LEGACY_SHARED_STORAGE_KEY);
	if (!isJapaneseState(legacy)) {
		return {
			stateMigrated: false,
			shouldMigrateReviewLogs: false
		};
	}

	storage.setItem(JAPANESE_STORAGE_KEY, legacy);
	storage.removeItem(LEGACY_SHARED_STORAGE_KEY);
	storage.setItem(LEGACY_REVIEW_MIGRATION_PENDING_KEY, '1');
	return {
		stateMigrated: true,
		shouldMigrateReviewLogs: true
	};
}

export function finishLegacyReviewLogMigration(storage) {
	storage.removeItem(LEGACY_REVIEW_MIGRATION_PENDING_KEY);
}
