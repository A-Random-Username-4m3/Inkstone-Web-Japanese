const DB_VERSION = 1;
const STORE_NAME = 'reviewLogs';
const CARD_ID_INDEX = 'card_id';

function openDatabase(dbName) {
	return new Promise((resolve, reject) => {
		if (!('indexedDB' in window)) {
			reject(new Error('IndexedDB is not available in this browser.'));
			return;
		}
		const request = indexedDB.open(dbName, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			let store;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				store = db.createObjectStore(STORE_NAME, {
					autoIncrement: true
				});
			} else {
				store = request.transaction.objectStore(STORE_NAME);
			}
			if (!store.indexNames.contains(CARD_ID_INDEX)) {
				store.createIndex(CARD_ID_INDEX, CARD_ID_INDEX, {
					unique: false
				});
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () =>
			reject(
				new Error(
					'IndexedDB upgrade was blocked by another open Inkstone tab.'
				)
			);
	});
}

function runTransaction(db, mode, callback) {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, mode);
		const store = transaction.objectStore(STORE_NAME);
		let result;
		transaction.oncomplete = () => resolve(result);
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () =>
			reject(transaction.error || new Error('IndexedDB transaction aborted.'));
		result = callback(store, transaction);
	});
}

function requestToPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function normalizeReviewLog(log) {
	if (!log || typeof log !== 'object') return null;
	const cardId = String(log.card_id || '').trim();
	const reviewTime = Number(log.review_time);
	const reviewRating = Number(log.review_rating);
	const reviewState = Number(log.review_state);
	if (!cardId) return null;
	if (!Number.isFinite(reviewTime) || reviewTime <= 0) return null;
	if (!Number.isInteger(reviewRating) || reviewRating < 1 || reviewRating > 4)
		return null;
	if (!Number.isInteger(reviewState) || reviewState < 0 || reviewState > 3)
		return null;
	return {
		card_id: cardId,
		review_time: Math.floor(reviewTime),
		review_rating: reviewRating,
		review_state: reviewState
	};
}

export function createReviewLogStore({
	dbName = 'inkstone-japanese-review-logs',
	migrateFromDbName = null,
	onLegacyMigrationComplete = null,
	setStatus
} = {}) {
	let dbPromise = null;

	async function migrateLegacyLogs(targetDb) {
		if (!migrateFromDbName || migrateFromDbName === dbName) return;
		const existingCount = await runTransaction(
			targetDb,
			'readonly',
			(store) => requestToPromise(store.count())
		);
		if (Number(existingCount) > 0) return;

		const legacyDb = await openDatabase(migrateFromDbName);
		try {
			const legacyLogs = await runTransaction(
				legacyDb,
				'readonly',
				(store) => requestToPromise(store.getAll())
			);
			const normalizedLogs = (Array.isArray(legacyLogs) ? legacyLogs : [])
				.map(normalizeReviewLog)
				.filter(Boolean);
			if (!normalizedLogs.length) return;
			await runTransaction(targetDb, 'readwrite', (store) => {
				for (const log of normalizedLogs) store.add(log);
				return normalizedLogs.length;
			});
		} finally {
			legacyDb.close();
		}
	}

	function getDb() {
		if (!dbPromise) {
			dbPromise = openDatabase(dbName)
				.then(async (db) => {
					await migrateLegacyLogs(db);
					onLegacyMigrationComplete?.();
					return db;
				})
				.catch((error) => {
					dbPromise = null;
					throw error;
				});
		}
		return dbPromise;
	}

	async function withDb(operation, fallback, userMessage = null) {
		try {
			return await operation(await getDb());
		} catch (error) {
			console.error('Review log storage failed:', error);
			if (userMessage) setStatus?.(userMessage);
			return fallback;
		}
	}

	async function add(log) {
		const normalized = normalizeReviewLog(log);
		if (!normalized) return false;
		return withDb(
			(db) =>
				runTransaction(db, 'readwrite', (store) => {
					store.add(normalized);
					return true;
				}),
			false,
			'Review log could not be saved. Export a backup soon.'
		);
	}

	async function replaceAll(logs) {
		const normalizedLogs = (Array.isArray(logs) ? logs : [])
			.map(normalizeReviewLog)
			.filter(Boolean);
		return withDb(
			(db) =>
				runTransaction(db, 'readwrite', (store) => {
					store.clear();
					for (const log of normalizedLogs) store.add(log);
					return normalizedLogs.length;
				}),
			null,
			'Review logs could not be replaced in IndexedDB.'
		);
	}

	async function getAll() {
		return withDb(
			(db) => runTransaction(db, 'readonly', (store) => requestToPromise(store.getAll())),
			null,
			'Review logs could not be read from IndexedDB.'
		);
	}

	async function count() {
		return withDb(
			(db) => runTransaction(db, 'readonly', (store) => requestToPromise(store.count())),
			0
		);
	}

	async function clear() {
		return withDb(
			(db) =>
				runTransaction(db, 'readwrite', (store) => {
					store.clear();
					return true;
				}),
			false,
			'Review logs could not be cleared from IndexedDB.'
		);
	}

	async function remapCardIds(migrations) {
		const mapping = migrations instanceof Map
			? migrations
			: new Map(Object.entries(migrations || {}));
		if (!mapping.size) return 0;
		return withDb(
			(db) => new Promise((resolve, reject) => {
				const transaction = db.transaction(STORE_NAME, 'readwrite');
				const store = transaction.objectStore(STORE_NAME);
				let updated = 0;
				transaction.oncomplete = () => resolve(updated);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(
					transaction.error || new Error('IndexedDB transaction aborted.')
				);
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) return;
					const value = cursor.value;
					const cardId = String(value?.card_id || '');
					const migrated = mapping.get(cardId);
					if (migrated && migrated !== cardId) {
						cursor.update({ ...value, card_id: migrated });
						updated += 1;
					}
					cursor.continue();
				};
				request.onerror = () => reject(request.error);
			}),
			0,
			'Review-log card IDs could not be migrated.'
		);
	}

	async function deleteByCardIds(cardIds) {
		const uniqueIds = [
			...new Set((cardIds || []).map((id) => String(id)).filter(Boolean))
		];
		if (!uniqueIds.length) return 0;
		return withDb(
			(db) =>
				new Promise((resolve, reject) => {
					const transaction = db.transaction(STORE_NAME, 'readwrite');
					const store = transaction.objectStore(STORE_NAME);
					const index = store.index(CARD_ID_INDEX);
					let deleted = 0;
					transaction.oncomplete = () => resolve(deleted);
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () =>
						reject(
							transaction.error ||
								new Error('IndexedDB transaction aborted.')
						);
					for (const cardId of uniqueIds) {
						const request = index.openCursor(IDBKeyRange.only(cardId));
						request.onsuccess = () => {
							const cursor = request.result;
							if (!cursor) return;
							cursor.delete();
							deleted += 1;
							cursor.continue();
						};
						request.onerror = () => reject(request.error);
					}
				}),
			0,
			'Review logs could not be cleared for the reset word(s).'
		);
	}


	return {
		add,
		replaceAll,
		getAll,
		count,
		clear,
		remapCardIds,
		deleteByCardIds
	};
}
