import { Requests, getReactiveStore, appSettings } from '../index.js';

/**
 * Thumbnail cache for item images (ItemImageComponent).
 *
 * Pipeline:
 *   1. Records: the CACHE/Thumbnails table (itemNumber → Drive file ID) is loaded once into a shared,
 *      read-only reactive store and indexed into a Map. Components look up their file ID in the index,
 *      so each one depends on a single computed instead of scanning the whole table.
 *   2. Images: a file is fetched only when a component asks for it (i.e. it scrolled into view).
 *      Lookups go memory → IndexedDB → Drive download. Downloads run in their own small queue,
 *      outside the app-wide PriorityQueue, so thumbnails are never starved by page analysis work.
 *   3. Downloads are downscaled to THUMB_MAX_DIM before display and storage. Tables render images at
 *      32–96px; decoding full-size originals for those cells is what made Chrome slow.
 *
 * Drive file IDs are content-stable: uploadItemImage always creates a new file and deletes the old
 * one, so a stored thumbnail never goes stale and is keyed by file ID with no invalidation needed.
 * Stored thumbnails whose file ID is no longer referenced by any record are pruned in the background.
 */

const THUMB_MAX_DIM = 192;              // Largest table display is 96px; 2x for high-DPI screens
const MAX_CONCURRENT_DOWNLOADS = 4;
const FAILURE_RETRY_MS = 60 * 1000;     // Don't re-download a file that just failed on every scroll
const PRUNE_DELAY_MS = 15 * 1000;
const DB_NAME = 'tsli-thumbnails';
const DB_STORE = 'thumbnails';

const _urls = new Map();        // fileId → object URL (owned here; components must never revoke these)
const _jobs = new Map();        // fileId → in-flight job
const _queue = [];              // jobs waiting for a download slot (FIFO)
const _failedAt = new Map();    // fileId → time of last failed download
let _activeDownloads = 0;

let _recordsStore = null;
let _recordIndex = null;        // Vue computed: Map<itemNumber, fileId>
let _pruneTimer = null;

function normalizeItemNumber(value) {
    return value === null || value === undefined ? '' : String(value).trim();
}

// ─── Records ─────────────────────────────────────────────────────────────────

function getRecordsStore() {
    // Called on every component creation (not cached locally) so an evicted or errored
    // store goes through getReactiveStore's normal reload path.
    const store = getReactiveStore(
        Requests.getAllThumbnailRecords,
        null,   // read-only
        [],
        null,   // no analysis — images are fetched on demand below
        true,   // autoLoad
        null,   // priorityConfig
        true    // exemptFromEviction — every image component depends on this store
    );
    if (!_recordIndex) {
        _recordsStore = store;
        _recordIndex = Vue.computed(() => {
            const index = new Map();
            for (const record of _recordsStore.data) {
                const itemNumber = normalizeItemNumber(record?.itemNumber);
                const fileId = normalizeItemNumber(record?.file);
                if (itemNumber && fileId) index.set(itemNumber, fileId);
            }
            return index;
        });
        Vue.watch(_recordIndex, schedulePrune);
    }
    return store;
}

// ─── Downloads ───────────────────────────────────────────────────────────────

function createJob(fileId) {
    const job = { fileId, waiters: 0, started: false, resolve: null, promise: null };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    _jobs.set(fileId, job);

    readStoredThumbnail(fileId).then(blob => {
        if (blob) {
            finishJob(job, blob);
        } else if (job.waiters <= 0 || appSettings.onlyRunEssentialAnalysis) {
            // Every requester cancelled during the IndexedDB read, or downloads are disabled.
            // Thumbnails are nonessential: in essential-only mode only already-stored ones are shown.
            finishJob(job, null);
        } else {
            _queue.push(job);
            pumpDownloads();
        }
    });
    return job;
}

function pumpDownloads() {
    while (_activeDownloads < MAX_CONCURRENT_DOWNLOADS && _queue.length > 0) {
        const job = _queue.shift();
        job.started = true;
        _activeDownloads++;
        downloadThumbnail(job.fileId)
            .then(blob => finishJob(job, blob))
            .finally(() => {
                _activeDownloads--;
                pumpDownloads();
            });
    }
}

async function downloadThumbnail(fileId) {
    try {
        const original = await Requests.getDriveFileBlob(fileId);
        if (!original) {
            _failedAt.set(fileId, Date.now());
            return null;
        }
        const thumbnail = await downscaleImage(original);
        storeThumbnail(fileId, thumbnail);
        return thumbnail;
    } catch (err) {
        console.warn(`[icons] Thumbnail download failed for ${fileId}:`, err);
        _failedAt.set(fileId, Date.now());
        return null;
    }
}

function finishJob(job, blob) {
    _jobs.delete(job.fileId);
    let url = null;
    if (blob) {
        url = URL.createObjectURL(blob);
        _urls.set(job.fileId, url);
        _failedAt.delete(job.fileId);
    }
    job.resolve(url);
}

/**
 * Downscale an image blob to fit within THUMB_MAX_DIM × THUMB_MAX_DIM.
 * Decoding and resizing go through createImageBitmap, which runs off the main thread in Chromium.
 * Returns the original blob if it is already small or can't be decoded here (the <img> may still
 * manage, e.g. SVG).
 */
async function downscaleImage(blob) {
    if (typeof createImageBitmap !== 'function') return blob;
    let bitmap;
    try {
        bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
        return blob;
    }
    try {
        const scale = THUMB_MAX_DIM / Math.max(bitmap.width, bitmap.height);
        if (scale >= 1) return blob;
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        // Resize off-thread where supported; otherwise let the canvas scale it.
        let source = bitmap;
        try {
            source = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
        } catch { /* fall back to drawImage scaling */ }

        const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, width, height);
        if (source !== bitmap) source.close();

        // WebP keeps transparency (product cutouts) at a fraction of PNG size.
        // Browsers that can't encode WebP fall back to PNG.
        const resized = canvas.convertToBlob
            ? await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
            : await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
        return resized || blob;
    } catch (err) {
        console.warn('[icons] Thumbnail downscale failed, using original:', err);
        return blob;
    } finally {
        bitmap.close();
    }
}

// ─── IndexedDB persistence ───────────────────────────────────────────────────
// Every operation fails soft: private windows, blocked storage, or quota errors just mean
// thumbnails are re-downloaded next session.

let _dbPromise = null;

function openDb() {
    if (!_dbPromise) {
        _dbPromise = new Promise(resolve => {
            try {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
    return _dbPromise;
}

async function withStore(mode, fn) {
    const db = await openDb();
    if (!db) return null;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(DB_STORE, mode);
            const request = fn(tx.objectStore(DB_STORE));
            tx.oncomplete = () => resolve(request?.result ?? null);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function readStoredThumbnail(fileId) {
    const result = await withStore('readonly', store => store.get(fileId));
    return result instanceof Blob ? result : null;
}

function storeThumbnail(fileId, blob) {
    withStore('readwrite', store => store.put(blob, fileId));
}

function deleteStoredThumbnail(fileId) {
    withStore('readwrite', store => store.delete(fileId));
}

function schedulePrune() {
    clearTimeout(_pruneTimer);
    _pruneTimer = setTimeout(pruneStoredThumbnails, PRUNE_DELAY_MS);
}

async function pruneStoredThumbnails() {
    // Only prune against a successfully loaded, non-empty table — an error or an empty
    // result must never wipe the device cache.
    const store = _recordsStore;
    if (!store || store.isLoading || store.error || !_recordIndex.value.size) return;
    const referenced = new Set(_recordIndex.value.values());
    const storedIds = await withStore('readonly', s => s.getAllKeys());
    if (!Array.isArray(storedIds)) return;
    const stale = storedIds.filter(id => !referenced.has(id));
    if (stale.length === 0) return;
    await withStore('readwrite', s => {
        stale.forEach(id => s.delete(id));
        return null;
    });
}

// ─── Shared visibility observer ──────────────────────────────────────────────
// One IntersectionObserver for every image on the page instead of one per component.

const _visibilityCallbacks = new Map(); // element → callback(isVisible)
let _observer = null;

function getObserver() {
    if (!_observer) {
        _observer = new IntersectionObserver(
            entries => entries.forEach(entry => _visibilityCallbacks.get(entry.target)?.(entry.isIntersecting)),
            { rootMargin: '200px', threshold: 0 }
        );
    }
    return _observer;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const ThumbnailCache = {
    /**
     * Ensure the shared records store exists. Call from a component's created() hook —
     * before any computed reads resolve(), and never from inside a computed.
     */
    connect() {
        getRecordsStore();
    },

    /** True once the Thumbnails table has loaded (reactive). */
    isReady() {
        return !!_recordsStore && !_recordsStore.initialLoad;
    },

    /**
     * Which Drive file to show for an item: its own record, or else its category prefix record
     * (e.g. "CHAIR" for "CHAIR-001"). Reactive on the records table.
     * @returns {{ fileId: string, isOwn: boolean } | null}
     */
    resolve(itemNumber) {
        const key = normalizeItemNumber(itemNumber);
        if (!key || !_recordIndex) return null;
        const index = _recordIndex.value;
        const ownFileId = index.get(key);
        if (ownFileId) return { fileId: ownFileId, isOwn: true };
        const prefix = key.split(/[\s\-_]+/)[0];
        const prefixFileId = prefix && prefix !== key ? index.get(prefix) : null;
        return prefixFileId ? { fileId: prefixFileId, isOwn: false } : null;
    },

    /** Synchronous memory lookup — lets already-loaded images render without a placeholder frame. */
    peek(fileId) {
        return _urls.get(fileId) || null;
    },

    /**
     * Get a displayable URL for a file, fetching it if needed. Concurrent requests share one job.
     * Pair every call that hasn't resolved yet with cancel() when the requester goes away.
     * @returns {Promise<string|null>} Object URL, or null if unavailable
     */
    load(fileId) {
        if (!fileId) return Promise.resolve(null);
        const cached = _urls.get(fileId);
        if (cached) return Promise.resolve(cached);
        const failedAt = _failedAt.get(fileId);
        if (failedAt && Date.now() - failedAt < FAILURE_RETRY_MS) return Promise.resolve(null);
        const job = _jobs.get(fileId) || createJob(fileId);
        job.waiters++;
        return job.promise;
    },

    /** Withdraw a pending load() request. Drops the download if nobody else is waiting and it hasn't started. */
    cancel(fileId) {
        const job = _jobs.get(fileId);
        if (!job) return;
        job.waiters--;
        if (job.waiters > 0 || job.started) return;
        const queued = _queue.indexOf(job);
        if (queued !== -1) {
            _queue.splice(queued, 1);
            finishJob(job, null);
        }
        // Not queued yet means the IndexedDB read is still running; createJob drops it when that finishes.
    },

    /**
     * Add an image the app already has (a fresh upload) under its Drive file ID, so neither this
     * session nor the next one downloads it back from Drive.
     * @returns {Promise<string|null>} Object URL for the stored thumbnail
     */
    async seed(fileId, blob) {
        if (!fileId || !blob) return null;
        const cached = _urls.get(fileId);
        if (cached) return cached;
        const thumbnail = await downscaleImage(blob);
        storeThumbnail(fileId, thumbnail);
        if (!_urls.has(fileId)) {
            _urls.set(fileId, URL.createObjectURL(thumbnail));
            _failedAt.delete(fileId);
        }
        return _urls.get(fileId);
    },

    /** Forget a file whose image failed to decode so the next load() downloads it fresh. */
    discard(fileId) {
        _urls.delete(fileId);
        _failedAt.delete(fileId);
        deleteStoredThumbnail(fileId);
    },

    observeVisibility(el, callback) {
        _visibilityCallbacks.set(el, callback);
        getObserver().observe(el);
    },

    unobserveVisibility(el) {
        if (_visibilityCallbacks.delete(el)) getObserver().unobserve(el);
    }
};
