import { Requests, getReactiveStore, appSettings } from '../index.js';

/**
 * Thumbnail image cache (thumbnail cells, components/interface/thumbnails.js).
 *
 * Which file an item shows is data: its Thumbnail cell (a JSON array of Drive file IDs, see
 * thumbnail-values.js), or else its category image from the inventory INDEX. This module only
 * turns a file ID into a displayable image, and supplies the category images.
 *
 * Pipeline:
 *   1. A file is fetched only when a component asks for it (i.e. it scrolled into view).
 *      Lookups go memory → IndexedDB → Drive download. Downloads run in their own small queue,
 *      outside the app-wide PriorityQueue, so thumbnails are never starved by page analysis work.
 *   2. Downloads are downscaled to THUMB_MAX_DIM before display and storage. Tables render images at
 *      32–96px; decoding full-size originals for those cells is what made Chrome slow.
 *
 * Drive file IDs are content-stable: an upload always creates a new file (or reuses an identical
 * one), so a stored thumbnail never goes stale and is keyed by file ID with no invalidation needed.
 * Stored thumbnails not used for STORED_MAX_AGE_MS are pruned in the background.
 */

const THUMB_MAX_DIM = 192;              // Largest table display is 96px; 2x for high-DPI screens
const MAX_CONCURRENT_DOWNLOADS = 4;
const FAILURE_RETRY_MS = 60 * 1000;     // Don't re-download a file that just failed on every scroll
const PRUNE_DELAY_MS = 15 * 1000;
const STORED_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;   // Re-download a thumbnail unused for ~6 months
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;          // Refresh a stored thumbnail's age at most daily
const DB_NAME = 'tsli-thumbnails';
const DB_STORE = 'thumbnails';

const _urls = new Map();        // fileId → object URL (owned here; components must never revoke these)
const _jobs = new Map();        // fileId → in-flight job
const _queue = [];              // jobs waiting for a download slot (FIFO)
const _failedAt = new Map();    // fileId → time of last failed download
let _activeDownloads = 0;

let _categoryStore = null;
let _categoryIndex = null;      // Vue computed: Map<prefix, fileId>
let _pruneScheduled = false;

function normalizeItemNumber(value) {
    return value === null || value === undefined ? '' : String(value).trim();
}

// ─── Category images ─────────────────────────────────────────────────────────

function getCategoryStore() {
    // Called on every component creation (not cached locally) so an evicted or errored
    // store goes through getReactiveStore's normal reload path.
    _categoryStore = getReactiveStore(
        Requests.getCategoryThumbnails,
        null,   // read-only
        [],
        null,   // no analysis
        true,   // autoLoad
        null,   // priorityConfig
        true    // exemptFromEviction — every thumbnail cell may fall back to it
    );
    if (!_categoryIndex) {
        _categoryIndex = Vue.computed(() => new Map((_categoryStore.data || []).map(entry => [entry.prefix, entry.file])));
    }
    return _categoryStore;
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

// Stored entries are { blob, t } (t: last use); entries from before ages were kept are bare Blobs.
async function readStoredThumbnail(fileId) {
    const result = await withStore('readonly', store => store.get(fileId));
    const blob = result instanceof Blob ? result : (result?.blob instanceof Blob ? result.blob : null);
    // Keep used thumbnails young (at most one write per day per file)
    if (blob && !(Date.now() - (result.t || 0) < TOUCH_INTERVAL_MS)) storeThumbnail(fileId, blob);
    return blob;
}

function storeThumbnail(fileId, blob) {
    withStore('readwrite', store => store.put({ blob, t: Date.now() }, fileId));
}

function deleteStoredThumbnail(fileId) {
    withStore('readwrite', store => store.delete(fileId));
}

function schedulePrune() {
    if (_pruneScheduled) return;
    _pruneScheduled = true;
    setTimeout(pruneStoredThumbnails, PRUNE_DELAY_MS);
}

// Delete stored thumbnails not used for STORED_MAX_AGE_MS (they are downloaded again if needed)
async function pruneStoredThumbnails() {
    const cutoff = Date.now() - STORED_MAX_AGE_MS;
    await withStore('readwrite', store => {
        const request = store.openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const t = cursor.value instanceof Blob ? Date.now() : (cursor.value?.t || 0);
            if (t < cutoff) cursor.delete();
            cursor.continue();
        };
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
     * Ensure the shared category-image store exists. Call from a component's created() hook —
     * before any computed reads categoryFallback(), and never from inside a computed.
     */
    connect() {
        getCategoryStore();
        schedulePrune();
    },

    /**
     * The category image for an item without one of its own: the INDEX Thumbnail of its prefix
     * (e.g. "CHAIR" for "CHAIR-001"). Reactive on the index.
     * @returns {string|null} Drive file ID
     */
    categoryFallback(itemNumber) {
        const key = normalizeItemNumber(itemNumber);
        if (!key || !_categoryIndex) return null;
        const prefix = key.split(/[\s\-_]+/)[0];
        return (prefix && _categoryIndex.value.get(prefix)) || null;
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
