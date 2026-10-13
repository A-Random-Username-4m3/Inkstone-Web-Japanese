const CACHE_PREFIX = 'inkstone-japanese-';
const CACHE_NAME = `${CACHE_PREFIX}a0.13.0-learning1-${dataRevision()}`;
const JMDICT_BASE_URL = './data/jmdict';
const JMDICT_MANIFEST_URL = `${JMDICT_BASE_URL}/manifest.json`;
const CORE_ASSETS = [
	'./',
	'./index.html',
	'./styles.css',
	'./js/app.js',
	'./js/dom-utils.js',
	'./js/time-format.js',
	'./js/state-store.js',
	'./js/constants.js',
	'./js/fsrs.js',
	'./js/practice-canvas.js',
	'./js/learning-policy.js',
	'./js/kanji-data.js',
	'./js/jmdict-data.js',
	'./js/jmdict-id.js',
	'./js/list-id.js',
	'./js/sample-data.js',
	'./js/stroke-matcher.js',
	'./js/lists-ui.js',
	'./js/study-flow.js',
	'./js/session-queue.js',
	'./js/vocabulary.js',
	'./js/settings-ui.js',
	'./js/parent-lock.js',
	'./js/lookup-ui.js',
	'./js/word-examples.js',
	'./js/backup.js',
	'./js/review-log-store.js',
	'./js/storage-migration.js',
	'./js/word-data.js',
	'./manifest.webmanifest',
	'./data/kanji.json',
	'./data/lists.json',
	'./data/lists/jlpt-n5.tsv',
	'./data/lists/jlpt-n4.tsv',
	'./data/lists/jlpt-n3.tsv',
	'./data/lists/jlpt-n2.tsv',
	'./data/lists/jlpt-n1.tsv',
	'./data/lists/common-japanese.tsv',
	'./data/lists/SOURCES.json'
];

const OPTIONAL_ASSETS = [
	'./icons/brand-mark.png',
	'./icons/icon-72.png',
	'./icons/icon-96.png',
	'./icons/icon-128.png',
	'./icons/icon-144.png',
	'./icons/icon-152.png',
	'./icons/icon-192.png',
	'./icons/icon-384.png',
	'./icons/icon-512.png',
	'./wav/blacklist.wav',
	'./wav/correctstroke.wav',
	'./wav/fairresult.wav',
	'./wav/goodjob.wav',
	'./wav/repeatnext.wav',
	'./wav/restore.wav',
	'./wav/tabchange.wav',
	'./wav/wrongstroke.wav'
];

function validJmdictManifest(manifest) {
	return Boolean(
		manifest &&
		manifest.schemaVersion === 3 &&
		Number.isInteger(manifest.shardCount) &&
		manifest.shardCount > 0 &&
		Array.isArray(manifest.entryShards) &&
		manifest.entryShards.length === manifest.shardCount &&
		Array.isArray(manifest.lookupShards) &&
		manifest.lookupShards.length === manifest.shardCount
	);
}

async function cacheReload(cache, url) {
	const request = new Request(url, { cache: 'reload' });
	const response = await fetch(request);
	if (!response.ok) {
		throw new Error(`Could not cache ${url} (${response.status})`);
	}
	await cache.put(request, response.clone());
	return response;
}

async function cacheInBatches(cache, urls, batchSize = 8) {
	for (let start = 0; start < urls.length; start += batchSize) {
		const batch = urls.slice(start, start + batchSize);
		await Promise.all(batch.map((url) => cacheReload(cache, url)));
	}
}

async function cacheJmdict(cache) {
	const manifestResponse = await cacheReload(cache, JMDICT_MANIFEST_URL);
	const manifest = await manifestResponse.json();
	if (!validJmdictManifest(manifest)) {
		throw new Error('Invalid JMdict shard manifest');
	}
	const filenames = [...manifest.entryShards, ...manifest.lookupShards];
	const urls = filenames.map((filename) => `${JMDICT_BASE_URL}/${filename}`);
	await cacheInBatches(cache, urls);
}

function dataRevision() {
	return '20261012T204915Z-38baf0'; // INKSTONE_DATA_REVISION
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then(async (cache) => {
				await cache.addAll(
					CORE_ASSETS.map((url) => new Request(
						url, { cache: 'reload' }
					))
				);
				await cacheJmdict(cache);
				await Promise.allSettled(
					OPTIONAL_ASSETS.map((url) =>
						cache.add(new Request(url, { cache: 'reload' }))
					)
				);
			})
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then(
				(keys) => Promise.all(
					keys.filter(
						(key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME
					).map((key) => caches.delete(key))
				)
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
	const cached = await caches.match(
		request,
		{ ignoreSearch: true }
	);

	if (cached) return cached;

	try {
		const response = await fetch(request);

		if (response && response.ok) {
			try {
				const cache = await caches.open(CACHE_NAME);
				await cache.put(request, response.clone());
			} catch (error) {
				console.warn(
					'Inkstone service worker cache update failed:',
					error
				);
			}
		}

		return response;
	} catch (error) {
		if (request.mode === 'navigate') {
			return caches.match('./index.html');
		}

		return new Response(
			'Offline and not cached.',
			{
				status: 503,
				statusText: 'Offline',
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8'
				}
			}
		);
	}
}
