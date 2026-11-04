import { networkState } from './networkState.js';

/**
 * Cache Management System with CPU-Aware Operations
 * 
 * This system manages caching with automatic TTL expiry, dependency tracking,
 * and CPU-optimized cleanup to prevent UI blocking.
 * 
 * Performance Optimizations:
 * - Cleanup runs during idle time via requestIdleCallback (lowest priority)
 * - Large invalidation cascades (>20 keys) process in batches with yields
 * - Batches of 50 deletions at a time to prevent long synchronous operations
 * - Respects network state (preserves cache while offline)
 * 
 * Priority Levels:
 * - Explicit invalidations (saves): Immediate, synchronous (correctness required)
 * - Small prefix invalidations (<20 keys): Synchronous
 * - Large prefix invalidations (>=20 keys): Batched with yields
 * - Expired entry cleanup: Idle-time async batching (lowest priority)
 */

/**
 * Default cache expiration in milliseconds.
 * Reduced from 20 min to 4 min to limit stale memory accumulation.
 * Dependency chains are preserved through expiry — only the cached value
 * is dropped, so invalidation still fires correctly after a refill.
 */
const DEFAULT_CACHE_EXPIRATION_MS = 4 * 60 * 1000;

/**
 * Lightweight event bus for cache invalidation notifications
 */
class CacheInvalidationBus {
    static listeners = new Map();
    
    /**
     * Subscribe to cache invalidation events for specific patterns
     * @param {string} pattern - Pattern to match (e.g., 'api:getPackList' or 'api:extractItemNumber')
     * @param {Function} callback - Function to call with {key, namespace, methodName, args}
     */
    static on(pattern, callback) {
        if (!CacheInvalidationBus.listeners.has(pattern)) {
            CacheInvalidationBus.listeners.set(pattern, []);
        }
        CacheInvalidationBus.listeners.get(pattern).push(callback);
    }

    static off(pattern, callback) {
        const callbacks = CacheInvalidationBus.listeners.get(pattern);
        if (!callbacks) return;
        const idx = callbacks.indexOf(callback);
        if (idx !== -1) callbacks.splice(idx, 1);
    }
    
    /**
     * Emit cache invalidation event
     * @param {string} key - Full cache key that was invalidated
     * @param {string} namespace - Namespace (e.g., 'api')
     * @param {string} methodName - Method name (e.g., 'getPackList')
     * @param {string} argsString - Serialized arguments
     */
    static emit(key, namespace, methodName, argsString) {
        const eventData = { key, namespace, methodName, argsString };
        
        // Emit to exact pattern matches: 'namespace:methodName'
        const pattern = `${namespace}:${methodName}`;
        const callbacks = CacheInvalidationBus.listeners.get(pattern) || [];
        
        if (callbacks.length > 0) {
            callbacks.forEach(cb => cb(eventData));
        }
        
        // Also emit to wildcard namespace listeners
        const wildcardCallbacks = CacheInvalidationBus.listeners.get(namespace) || [];
        if (wildcardCallbacks.length > 0) {
            wildcardCallbacks.forEach(cb => cb(eventData));
        }
    }
}

class CacheManager {
    static cache = new Map();
    static dependencies = new Map();
    static pendingCalls = new Map(); // Maps cache keys to pending promises to prevent duplicate concurrent calls
    static CACHE_MISS = Symbol('CACHE_MISS');
    static _timestampWriter = null;
    // Tracks the last time each key was populated, regardless of TTL expiry.
    // The main cache entry is deleted silently on TTL expiry without firing the bus;
    // filledAt persists so the poller can still detect remote changes after the cache
    // entry is gone. Cleared only on explicit invalidation (not on TTL expiry).
    static filledAt = new Map();
    // ── Frontend cooperative yield scheduler ──────────────────────────────────
    // NOTE: Only needed while the abstraction layer runs on the browser main thread.
    // Remove _yieldCallCount, _lastYieldTime, and _maybeYield() when refactoring
    // to a real backend API — server-side execution has no event loop to protect.
    static _yieldCallCount = 0;
    static _lastYieldTime = 0;
    // ── Persisted results (opt-in per method: wrapMethods persistentMethods) ──
    // Injected by application-utils: { read(key), write(entry), readSourceTimestamps() }
    static _persistentStore = null;
    // Keys whose saved row was already tried this session; later misses recompute and re-save
    static _restoreTried = new Set();

    /**
     * Gets a value from cache with expiration check
     * @param {string} key - Cache key
     * @returns {*} - Cached value, or CacheManager.CACHE_MISS if not found/expired
     */
    static get(key) {
        const entry = CacheManager.cache.get(key);
        if (!entry) {
            return CacheManager.CACHE_MISS;
        }
        
        // While offline, serve stale-but-valid cache entries regardless of expiry.
        // The freeze prevents reloads that would fail anyway, and data is recovered
        // on connectivity restore via reloadErrorStores().
        if (networkState.isOffline) {
            return entry.value;
        }

        // Check expiration
        if (entry.expire && entry.expire < Date.now()) {
            // Silently remove the expired entry without firing the CacheInvalidationBus.
            // Calling invalidate() here would emit bus events that trigger reactive store
            // reloads — during auth transitions this causes cascading 403 failures.
            // Natural TTL expiry should return CACHE_MISS and let the next access re-populate;
            // only explicit mutation-driven invalidations (stampDataChange / invalidateCache)
            // should fire the bus so stores know actual data has changed.
            CacheManager.cache.delete(key);
            return CacheManager.CACHE_MISS;
        }
        
        return entry.value;
    }
    
    /**
     * Sets a value in cache with default timeout
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     * @param {number} expirationMs - Expiration time in milliseconds (defaults to DEFAULT_CACHE_EXPIRATION_MS)
     * @param {boolean} [keepEmpty] - Cache empty arrays and objects too (persisted methods: "nothing
     *        found" is a result worth keeping)
     */
    static set(key, value, expirationMs = DEFAULT_CACHE_EXPIRATION_MS, keepEmpty = false) {
        // Skip caching null, undefined, empty results, or booleans
        if (
            value === null ||
            value === undefined ||
            (!keepEmpty && Array.isArray(value) && value.length === 0) ||
            (!keepEmpty && typeof value === 'object' && Object.keys(value).length === 0) ||
            (typeof value === 'boolean')
        ) {
            return;
        }
        
        const now = Date.now();
        CacheManager.cache.set(key, {
            value,
            expire: expirationMs ? now + expirationMs : null,
            filled: now
        });
        CacheManager.filledAt.set(key, now);
    }

    /**
     * Yields to the browser event loop if the current call chain has been running too long.
     * Prevents deeply nested deps.call() chains from flooding microtask queues and locking the UI.
     * NOTE: Only needed while the abstraction layer runs on the browser main thread.
     * Remove this method and its call site when refactoring to a real backend API.
     */
    static async _maybeYield() {
        // Only check every 64 invocations to keep per-call overhead negligible.
        if (++CacheManager._yieldCallCount % 64 !== 0) return;
        const now = Date.now();
        if (now - CacheManager._lastYieldTime > 8) {
            CacheManager._lastYieldTime = now;
            await new Promise(r => setTimeout(r, 0));
        }
    }

    /**
     * Creates a dependency decorator that explicitly tracks function calls as dependencies
     * @param {string} callerKey - Cache key of the calling function
     * @returns {Function} - Decorator function
     */
    static createDependencyDecorator(callerKey) {
        return {
            /**
             * Calls a wrapped function and registers it as a dependency
             * @param {Function} wrappedFunction - The wrapped function to call
             * @param {...any} args - Arguments to pass to the function
             * @returns {Promise} - Function result
             */
            call: async (wrappedFunction, ...args) => {
                // Cooperative yield — prevents long nested call chains from blocking the event loop.
                // NOTE: Only needed while the abstraction layer runs on the browser main thread.
                await CacheManager._maybeYield();

                // Generate the cache key for the called function
                const calledKey = CacheManager.generateCacheKey(wrappedFunction._namespace, wrappedFunction._methodName, args);

                // Atomic check-and-set: if pending call exists, await it; otherwise create and store new promise
                let result;
                let promise = CacheManager.pendingCalls.get(calledKey);
                if (promise) {
                    result = await promise;
                } else {
                    // Execute the wrapped function
                    result = await wrappedFunction(...args);
                }

                
                if (calledKey) {
                    // Register the called function as a dependency of the caller
                    CacheManager.addDependency(callerKey, calledKey);
                }

                return result;
            }
        };
    }
    
    /**
     * Adds a dependency relationship between two cache entries
     * @param {string} dependentKey - The cache key that depends on another
     * @param {string} dependencyKey - The cache key that is depended upon
     */
    static addDependency(dependentKey, dependencyKey) {
        if (!CacheManager.dependencies.has(dependentKey)) {
            CacheManager.dependencies.set(dependentKey, new Set());
        }
        CacheManager.dependencies.get(dependentKey).add(dependencyKey);
    }

    /**
     * The source keys a cached result was computed from: every key reachable through the
     * recorded dependencies that has none of its own (data reads such as database:getData,
     * and the clock, app_utils:getToday).
     * @param {string} key - Cache key of the result
     * @returns {string[]}
     */
    static collectSourceKeys(key) {
        const sources = new Set();
        const seen = new Set();
        const walk = (k) => {
            if (seen.has(k)) return;
            seen.add(k);
            const deps = CacheManager.dependencies.get(k);
            if (!deps || deps.size === 0) {
                if (k !== key) sources.add(k);
                return;
            }
            deps.forEach(walk);
        };
        walk(key);
        return [...sources];
    }

    /**
     * Save a computed result for later sessions. The row is dated by the oldest source read it
     * used, so a change stamped on the Caching tab after that read marks the row stale.
     * @param {string} key - Cache key
     * @param {*} value - The result
     * @param {number} startedAt - When the computation started (ms)
     */
    static async persist(key, value, startedAt) {
        const store = CacheManager._persistentStore;
        if (!store || networkState.isOffline) return;
        const sources = CacheManager.collectSourceKeys(key);
        const asOf = Math.min(startedAt, ...sources.map(s => CacheManager.filledAt.get(s) ?? startedAt));
        try {
            await store.write({ key, value, savedAt: new Date(asOf).toISOString(), sources });
        } catch (err) {
            console.warn('[cache] Failed to save result for', key, err);
        }
    }

    /**
     * Restore a saved result on the first miss of the session, if none of its sources has a
     * Caching tab timestamp newer than the row. The sources are linked back as dependencies and
     * marked filled at the row's date, so local saves and the poller invalidate the restored
     * value exactly as if it had been computed here.
     * @param {string} key - Cache key
     * @returns {Promise<*>} The value, or CacheManager.CACHE_MISS
     */
    static async restorePersisted(key) {
        const store = CacheManager._persistentStore;
        if (!store || networkState.isOffline || CacheManager._restoreTried.has(key)) return CacheManager.CACHE_MISS;
        CacheManager._restoreTried.add(key);
        try {
            const [row, stamps] = await Promise.all([store.read(key), store.readSourceTimestamps()]);
            if (!row || !Array.isArray(stamps)) return CacheManager.CACHE_MISS;
            const savedAt = new Date(row.savedAt).getTime();
            if (isNaN(savedAt)) return CacheManager.CACHE_MISS;
            const stale = row.sources.some(source => stamps.some(({ key: prefix, timestamp }) =>
                source.startsWith(prefix) && new Date(timestamp).getTime() > savedAt
            ));
            if (stale) return CacheManager.CACHE_MISS;
            for (const source of row.sources) {
                CacheManager.addDependency(key, source);
                if (!CacheManager.filledAt.has(source)) CacheManager.filledAt.set(source, savedAt);
            }
            return row.value;
        } catch (err) {
            console.warn('[cache] Failed to restore saved result for', key, err);
            return CacheManager.CACHE_MISS;
        }
    }

    /**
     * Invalidates a cache entry and all dependent entries.
     *
     * ═══════════════════════════════════════════════════════════════
     * CRITICAL — DO NOT REORDER THESE STEPS
     *
     * The invalidation sequence must be:
     *   1. Delete the cache entry
     *   2. Reverse-scan dependencies to find callers (dependents)
     *   3. Recursively invalidate each dependent (step 2–5 for each)
     *   4. Delete THIS key's own dependency record
     *   5. Emit the CacheInvalidationBus event (MUST be last)
     *
     * Step 4 (dependencies.delete) MUST come after step 3 so that the
     * recursive calls can still find and walk the full chain. Moving it
     * before step 3 would silently break the cascade for every caller.
     *
     * Step 5 (bus emit) MUST come last so that reactive store listeners
     * that fire synchronously on the event see a fully-cleared cache with
     * no stale entries for any part of the chain. Emitting earlier would
     * allow a listener to read a partially-valid cache.
     *
     * Dependency records are destroyed after each invalidation. They are
     * re-registered the next time the chain is executed (on reload). Any
     * code path that calls invalidate() but does NOT trigger a subsequent
     * reload MUST separately repopulate the cache (e.g., via apiCall())
     * to restore the dependency chain before the next external change
     * can be detected.
     * ═══════════════════════════════════════════════════════════════
     *
     * @param {string} key - Cache key to invalidate
     * @param {Set} invalidationStack - Set of keys currently being invalidated (to prevent recursion)
     */
    static invalidate(key, invalidationStack = new Set()) {
        // While offline, preserve cached data — nothing can be re-fetched to replace it.
        if (networkState.isOffline) return;

        // Prevent infinite recursion - if this key is already being invalidated, skip it
        if (invalidationStack.has(key)) {
            return;
        }
        
        // Add this key to the invalidation stack
        invalidationStack.add(key);
        
        // Remove the cache entry and its fill-time record
        CacheManager.cache.delete(key);
        CacheManager.filledAt.delete(key);
        
        // Also clean up any pending calls for this key DO NOT CLEAR PENDING CALLS HERE
        //if (CacheManager.pendingCalls.has(key)) {
        //    CacheManager.pendingCalls.delete(key);
        //}
        
        // Find and invalidate all dependent entries
        const dependents = [];
        for (const [depKey, deps] of CacheManager.dependencies.entries()) {
            if (deps.has && deps.has(key)) {
                dependents.push(depKey);
            }
        }
        
        // Recursively invalidate dependents with the same invalidation stack
        for (const depKey of dependents) {
            CacheManager.invalidate(depKey, invalidationStack);
        }
        
        // Clean up dependency registration — MUST come after recursive invalidation above
        // so that the full chain is walked before any records are removed.
        CacheManager.dependencies.delete(key);
        
        
        // Emit invalidation event for reactive stores (only for 'api' namespace)
        // THIS MUST HAPPEN LAST — all cache entries and dependency records for the entire
        // chain must be cleared before any listener callback fires.
        // Extract namespace, methodName, and argsString from key
        // Key format: "namespace:methodName:argsString"
        // Note: argsString may contain colons (e.g., JSON with {"type":"value"})
        // So we need to split only on the first two colons
        const firstColonIndex = key.indexOf(':');
        const secondColonIndex = key.indexOf(':', firstColonIndex + 1);
        const namespace = key.substring(0, firstColonIndex);
        const methodName = key.substring(firstColonIndex + 1, secondColonIndex);
        const argsString = key.substring(secondColonIndex + 1);
        
        if (namespace === 'api') {
            CacheInvalidationBus.emit(key, namespace, methodName, argsString);
        }

        // Remove from invalidation stack when done
        invalidationStack.delete(key);
    }
    
    /**
     * Invalidates all cache entries that start with a given prefix.
     * For large sets of keys (>20), processes in batches with yields to prevent blocking.
     * @param {string} prefix - Cache key prefix to match
     */
    static invalidateByPrefix(prefix) {
        // Collect keys from both the live cache and filledAt.
        // filledAt may contain keys whose cache entry has already expired (silently removed
        // on TTL), but whose dependency records are still intact. Calling invalidate() on
        // those keys still walks the dependency chain and fires the bus for api:* dependents.
        const keysToInvalidate = [];
        const seen = new Set();
        for (const key of CacheManager.cache.keys()) {
            if (key.startsWith(prefix)) {
                keysToInvalidate.push(key);
                seen.add(key);
            }
        }
        for (const key of CacheManager.filledAt.keys()) {
            if (key.startsWith(prefix) && !seen.has(key)) {
                keysToInvalidate.push(key);
            }
        }
        //console.log('[cache] invalidateByPrefix:', prefix, '| matched:', keysToInvalidate);
        
        // For small sets, invalidate synchronously (must complete before listeners fire)
        if (keysToInvalidate.length <= 20) {
            for (const key of keysToInvalidate) {
                CacheManager.invalidate(key);
            }
            return;
        }
        
        // For large sets, batch invalidations with yields to prevent UI freezing
        // This is safe because all matched keys are independent (same prefix = parallel invalidation)
        const BATCH_SIZE = 20;
        let processed = 0;
        
        const processBatch = () => {
            const batch = keysToInvalidate.slice(processed, processed + BATCH_SIZE);
            for (const key of batch) {
                CacheManager.invalidate(key);
            }
            processed += batch.length;
            
            if (processed < keysToInvalidate.length) {
                // Yield control and process next batch
                setTimeout(processBatch, 0);
            }
        };
        
        processBatch();
    }
    
    /**
     * Generates a consistent cache key
     * @param {string} namespace - Cache namespace
     * @param {string} methodName - Method name
     * @param {Array} args - Method arguments
     * @returns {string} - Formatted cache key
     */
    static generateCacheKey(namespace, methodName, args) {
        // Remove brackets to make prefix matching work for custom mapped data
        const argsString = JSON.stringify(args).replace(/^\[|\]$/g, '');
        //console.log('[cache] generateCacheKey:', `${namespace}:${methodName}:${argsString}`);
        return `${namespace}:${methodName}:${argsString}`;
    }

    /**
     * Invalidates specific cache entries
     * @param {Array<{namespace: string, methodName: string, args: Array}>} cacheEntries - Array of cache entries to invalidate
     * @param {boolean} invalidateByPrefix - If true, invalidates all caches that start with the cache key prefix
     */
    static invalidateCache(cacheEntries, invalidateByPrefix = false) {
        //console.log('[cache] invalidateCache called with entries:', cacheEntries, '| invalidateByPrefix:', invalidateByPrefix);
        
        if (!Array.isArray(cacheEntries)) return;
        cacheEntries.forEach(({ namespace, methodName, args }) => {
            if (namespace && methodName && args) {
                if (invalidateByPrefix) {
                    // Generate prefix that matches the actual cache key format
                    // Use the same format as generateCacheKey but only with the first two args
                    const prefixArgs = args.slice(0, 2); // Take first two args (tableId, tabName)
                    const argsString = JSON.stringify(prefixArgs).replace(/^\[|\]$/g, '');
                    const prefix = `${namespace}:${methodName}:${argsString}`;
                    CacheManager.invalidateByPrefix(prefix);
                } else {
                    // Exact key invalidation
                    const fullKey = CacheManager.generateCacheKey(namespace, methodName, args);
                    CacheManager.invalidate(fullKey);
                }
            }
        });
    }

    /**
     * Wraps all static methods of a class with caching and automatic dependency decorator
     * 
     * CRITICAL: Mutation methods must be excluded from wrapping to avoid circular dependencies.
     * Mutation methods trigger cache invalidation through Database.setData() and must NOT:
     * 1. Accept 'deps' as first parameter
     * 2. Use deps.call() to invoke sub-functions
     * 3. Be cached or wrapped by this method
     * 
     * Mutation methods are passed through directly without modification, preserving their
     * original signatures and allowing them to trigger cache invalidation independently.
     * 
     * @param {Object} targetClass - The class to wrap
     * @param {string} namespace - Cache namespace
     * @param {Array<string>} [mutationKeys] - Array of method names to skip wrapping (mutation methods)
     * @param {Array<string>} [infiniteCacheMethods] - Array of method names that should have infinite cache (no expiration)
     * @param {Object} [customCacheDurations] - Method name → ms, null, or (args) => ms | null
     * @param {Array<string>} [persistentMethods] - Methods whose results are saved for later sessions
     *        (setPersistentStore). Their results must be JSON and depend only on database reads and
     *        ApplicationUtils.getToday, since only those sources are checked when a saved row is
     *        restored. In memory they never expire; their sources invalidate them.
     * @returns {Object} - Wrapped class with caching and dependency tracking
     */
    static wrapMethods(targetClass, namespace, mutationKeys = [], infiniteCacheMethods = [], customCacheDurations = {}, persistentMethods = []) {
        const wrappedClass = {};
        wrappedClass._namespace = namespace;
        
        // Get all static methods
        const methods = Object.getOwnPropertyNames(targetClass)
            .filter(name => typeof targetClass[name] === 'function' && name !== 'constructor');
        
        methods.forEach(methodName => {
            // Skip wrapping for mutation methods - pass them through directly without modification
            // This preserves their original signatures (no deps parameter) and prevents circular dependencies
            if (mutationKeys.includes(methodName)) {
                wrappedClass[methodName] = targetClass[methodName];
                // Store method name for extractMethodName to retrieve
                wrappedClass[methodName]._namespace = namespace;
                wrappedClass[methodName]._methodName = methodName;
                return;
            }
            
            const persistent = persistentMethods.includes(methodName);
            wrappedClass[methodName] = async function(...args) {
                const cacheKey = CacheManager.generateCacheKey(namespace, methodName, args);
                
                // Check cache first
                const cached = CacheManager.get(cacheKey);
                if (cached !== CacheManager.CACHE_MISS) {
                    return cached;
                }
                
                // Check if there's already a pending call - if so, wait for it
                let promise = CacheManager.pendingCalls.get(cacheKey);
                if (promise) {
                    return await promise;
                }
                
                // Create promise resolver/rejecter that we can store synchronously
                let promiseResolve, promiseReject;
                const pendingPromise = new Promise((resolve, reject) => {
                    promiseResolve = resolve;
                    promiseReject = reject;
                });
                
                // Store the promise IMMEDIATELY before any async work starts (atomic).
                // Attach a no-op catch so the stored promise never triggers an unhandled
                // rejection warning — callers receive the error via the re-thrown exception.
                pendingPromise.catch(() => {});
                CacheManager.pendingCalls.set(cacheKey, pendingPromise);
                
                // Now execute the actual async work
                try {
                    if (persistent) {
                        const restored = await CacheManager.restorePersisted(cacheKey);
                        if (restored !== CacheManager.CACHE_MISS) {
                            CacheManager.set(cacheKey, restored, null, true);
                            promiseResolve(restored);
                            return restored;
                        }
                    }
                    const startedAt = Date.now();

                    // Create dependency decorator for this function call
                    const deps = CacheManager.createDependencyDecorator(cacheKey);
                    
                    // Execute method with dependency decorator as first parameter
                    const result = await targetClass[methodName](deps, ...args);
                    
                    // Determine expiration time:
                    // 1. Custom duration if specified for this method — value may be a number, null, or
                    //    a function (args) => number | null for per-argument control
                    // 2. Infinite cache (null) if in infiniteCacheMethods
                    // 3. Default duration otherwise (undefined = use DEFAULT_CACHE_EXPIRATION_MS)
                    let expirationMs;
                    if (customCacheDurations[methodName] !== undefined) {
                        const durValue = customCacheDurations[methodName];
                        expirationMs = typeof durValue === 'function' ? durValue(args) : durValue;
                    } else if (persistent || infiniteCacheMethods.includes(methodName)) {
                        expirationMs = null;
                    } else {
                        expirationMs = undefined;
                    }

                    CacheManager.set(cacheKey, result, expirationMs, persistent);
                    if (persistent) CacheManager.persist(cacheKey, result, startedAt);

                    // Resolve the promise for all waiters
                    promiseResolve(result);
                    return result;
                } catch (error) {
                    // Reject the promise for all waiters
                    promiseReject(error);
                    throw error;
                } finally {
                    // Always clean up the pending call when done
                    CacheManager.pendingCalls.delete(cacheKey);
                }
            };
            
            // Store the method name on the wrapped function for extractMethodName to retrieve
            wrappedClass[methodName]._methodName = methodName;
            // Store the cache key info on the function for dependency tracking
            wrappedClass[methodName]._namespace = namespace;
            wrappedClass[methodName]._methodName = methodName;
        });
        
        return wrappedClass;
    }
}

export const wrapMethods = CacheManager.wrapMethods;
export const invalidateCache = CacheManager.invalidateCache;

/**
 * Write a "data changed" timestamp to the CACHE/Caching sheet for the given prefix.
 *
 * ═══════════════════════════════════════════════════════════════
 * CRITICAL — TIMESTAMP ORDERING CONTRACT
 *
 * stampDataChange must be called BEFORE the corresponding local cache
 * entry is repopulated. The current write sequence in Database.setData
 * is:
 *   1. GoogleSheetsService.setSheetData  (data written to sheet)
 *   2. stampDataChange                   (timestamp captured & written — async, fire-and-forget)
 *   3. invalidateCache                   (local cache cleared — synchronous)
 *   4. store.save() → apiCall()          (local cache repopulated — async)
 *
 * Because the timestamp value is captured at step 2 (before the cache
 * refill at step 4), the Caching tab timestamp is always earlier than
 * the local cache's `entry.filled`. This guarantees that the local
 * session's own poller never spuriously re-invalidates its freshly-
 * saved data, while other sessions (whose caches were filled before
 * step 1) correctly detect the change.
 *
 * DO NOT move stampDataChange after invalidateCache or after the cache
 * repopulation — doing so would break detection in the local session.
 * ═══════════════════════════════════════════════════════════════
 */
export function stampDataChange(prefix) {
    if (CacheManager._timestampWriter) {
        CacheManager._timestampWriter(prefix);
    }
}
export function clearCache() {
    // While offline, the cache is the only copy of the data — don't wipe it.
    if (networkState.isOffline) return;
    CacheManager.cache.clear();
    CacheManager.pendingCalls.clear();
    CacheManager.filledAt.clear();
    // Saved results may be restored again; each is still checked against its sources
    CacheManager._restoreTried.clear();
}
export { CacheInvalidationBus };

/**
 * Event bus for function progress notifications.
 * Allows long-running API functions to emit progress updates to subscribers
 * (e.g., reactive stores showing a loading message) using the same topic
 * convention as CacheInvalidationBus: 'namespace:methodName'.
 *
 * Usage in an API function:
 *   ProgressBus.emit('api:myMethod', { current: 5, total: 120, message: 'Processing 5 of 120...' });
 *
 * The reactive store's load() subscribes automatically for the function it calls.
 */
class ProgressBus {
    static listeners = new Map();

    /**
     * Subscribe to progress events for a topic
     * @param {string} topic - 'namespace:methodName'
     * @param {Function} callback - ({ current, total, message }) => void
     */
    static on(topic, callback) {
        if (!ProgressBus.listeners.has(topic)) {
            ProgressBus.listeners.set(topic, []);
        }
        ProgressBus.listeners.get(topic).push(callback);
    }

    /**
     * Unsubscribe from a topic
     * @param {string} topic
     * @param {Function} callback
     */
    static off(topic, callback) {
        const callbacks = ProgressBus.listeners.get(topic);
        if (!callbacks) return;
        const idx = callbacks.indexOf(callback);
        if (idx !== -1) callbacks.splice(idx, 1);
    }

    /**
     * Emit a progress event
     * @param {string} topic - 'namespace:methodName'
     * @param {{ current: number, total: number, message: string }} data
     */
    static emit(topic, data) {
        const callbacks = ProgressBus.listeners.get(topic) || [];
        callbacks.forEach(cb => cb(data));
    }
}

export { ProgressBus };

// Expired cache cleanup with CPU-aware batching
//
// Uses requestIdleCallback to run cleanup during browser idle time, preventing
// interference with user operations. Processes deletions in small batches with
// yields to avoid blocking the main thread.
let _cacheCleanupInterval = null;
let _isCleanupRunning = false;

/**
 * Process cache cleanup in batches during idle time
 * Runs as lowest-priority background work to avoid CPU contention
 */
async function performCacheCleanup() {
    if (_isCleanupRunning || networkState.isOffline) return;
    _isCleanupRunning = true;
    
    try {
        const now = Date.now();
        const expiredKeys = [];
        
        // Collect expired keys (fast scan, no deletions yet)
        for (const [key, entry] of CacheManager.cache.entries()) {
            if (entry.expire && entry.expire < now) {
                expiredKeys.push(key);
            }
        }
        
        if (expiredKeys.length === 0) {
            _isCleanupRunning = false;
            return;
        }
        
        // Process deletions in batches of 50 with idle-time yielding
        const BATCH_SIZE = 50;
        let deleted = 0;
        
        for (let i = 0; i < expiredKeys.length; i += BATCH_SIZE) {
            const batch = expiredKeys.slice(i, i + BATCH_SIZE);
            
            // Wait for idle time before processing next batch
            // Falls back to setTimeout if requestIdleCallback unavailable
            await new Promise(resolve => {
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(resolve, { timeout: 1000 });
                } else {
                    setTimeout(resolve, 0);
                }
            });
            
            // Delete batch
            for (const key of batch) {
                CacheManager.cache.delete(key);
                deleted++;
            }
        }
        
        if (deleted > 0) {
            //console.log(`[CacheCleanup] Removed ${deleted} expired entries (${expiredKeys.length - deleted} remain)`);
        }
    } catch (error) {
        console.warn('[CacheCleanup] Cleanup failed:', error);
    } finally {
        _isCleanupRunning = false;
    }
}

export function startCacheCleanup(intervalMs = 2 * 60 * 1000) { // Default: 2 minutes
    if (_cacheCleanupInterval) return;
    _cacheCleanupInterval = setInterval(() => {
        performCacheCleanup(); // Non-blocking async call
    }, intervalMs);
}

export function stopCacheCleanup() {
    if (_cacheCleanupInterval) {
        clearInterval(_cacheCleanupInterval);
        _cacheCleanupInterval = null;
    }
}

// Remote cache timestamp synchronization
//
// ═══════════════════════════════════════════════════════════════
// HOW EXTERNAL CHANGE DETECTION WORKS
//
// When this app (or an external app) writes data, it also writes a
// timestamp to the CACHE sheet's "Caching" tab:
//   Key                                       | Timestamp
//   database:getData:"INVENTORY","FURNITURE"  | 2026-07-07T12:00:00Z
//
// This poller reads that tab every 30 s (prod) / 10 s (localhost) and
// compares each entry's timestamp against the local in-memory cache:
//
//   FOR INVALIDATION TO FIRE, ALL OF THE FOLLOWING MUST BE TRUE:
//   1. A cache entry exists whose key STARTS WITH the Caching tab key.
//      If no entry exists (data not loaded, or TTL already expired and
//      not yet refilled), the poller silently skips that key.
//   2. remoteTs (Caching tab) > entry.filled (local cache fill time).
//      The external write timestamp must be strictly newer than when
//      this session last loaded the data.
//
// EXTERNAL APP REQUIREMENTS:
//   - Write the data to the sheet FIRST, then write the Caching tab.
//   - The Caching tab key must exactly match the prefix format:
//       database:getData:"<TABLE_ID>","<TAB_NAME>"
//   - TABLE_ID values: INVENTORY, PACK_LISTS, PRODUCTION_SCHEDULE, CACHE
//
// DEBUGGING: On localhost, use the browser console test helper:
//   window.__tsliTestExternalChange('database:getData:"INVENTORY","FURNITURE"')
// ═══════════════════════════════════════════════════════════════
let _cacheTimestampPollerInterval = null;
let _pollerReadFn = null;
let _pollerIntervalMs = 60 * 1000;

export function setTimestampWriter(fn) {
    CacheManager._timestampWriter = fn;
}

/**
 * Set where persisted results are kept (see wrapMethods persistentMethods).
 * @param {{ read: (key: string) => Promise<{value: *, savedAt: string, sources: string[]}|null>,
 *           write: (entry: {key: string, value: *, savedAt: string, sources: string[]}) => Promise,
 *           readSourceTimestamps: () => Promise<Array<{key: string, timestamp: string}>|null> }} store
 */
export function setPersistentStore(store) {
    CacheManager._persistentStore = store;
}

/**
 * Check for application updates by fetching the deployed version.
 * App compares against its lastKnownVersion baseline set on mount.
 * Cache-busting query param ensures version.json is always fresh from server.
 */
async function checkAppVersion() {
    try {
        // Use cache-busting query param to ensure fresh version from server
        const response = await fetch('./version.json?v=' + Date.now());
        const versionData = await response.json();
        const deployedVersion = versionData.version;
        
        // console.log('[VersionCheck] Deployed version:', deployedVersion);
        
        // Dispatch event with the deployed version so app can compare against its baseline
        window.dispatchEvent(new CustomEvent('versionCheckResult', { 
            detail: { deployedVersion } 
        }));
    } catch (err) {
        console.warn('[VersionCheck] Error:', err.message);
        // Silently ignore errors (network issues, version.json not found)
    }
}

export function startCacheTimestampPoller(readFn, intervalMs = 60 * 1000) {
    if (_cacheTimestampPollerInterval) return;
    _pollerReadFn = readFn;
    _pollerIntervalMs = intervalMs;
    _cacheTimestampPollerInterval = setInterval(async () => {
        // Check for application updates
        checkAppVersion();
        
        try {
            const entries = await readFn();
            if (entries === null) {
                // readFn signaled auth is unavailable — pause the poller until re-auth
                stopCacheTimestampPoller();
                stopCacheCleanup();
                return;
            }
            if (!Array.isArray(entries) || entries.length === 0) return;
            for (const { key, timestamp } of entries) {
                if (!key || !timestamp) continue;
                const remoteTs = new Date(timestamp).getTime();
                if (isNaN(remoteTs)) continue;
                // CRITICAL: Poller can only invalidate cache entries that exist in CacheManager.cache.
                // If data hasn't been loaded yet (user never navigated to that page), the cache entry
                // won't exist and invalidation is silently skipped. This is by design - no point
                // invalidating data that hasn't been loaded.
                let shouldInvalidate = false;
                for (const [cacheKey, entry] of CacheManager.cache.entries()) {
                    if (cacheKey.startsWith(key) && entry.filled && remoteTs > entry.filled) {
                        shouldInvalidate = true;
                        break;
                    }
                }
                // Fallback: if no live cache entry exists (TTL expired and entry was silently
                // removed), check filledAt which persists beyond TTL expiry. This prevents the
                // poller from going blind to external changes after the 4-minute cache TTL.
                if (!shouldInvalidate) {
                    for (const [filledKey, filledTs] of CacheManager.filledAt.entries()) {
                        if (filledKey.startsWith(key) && remoteTs > filledTs) {
                            shouldInvalidate = true;
                            break;
                        }
                    }
                }
                if (shouldInvalidate) {
                    //console.log('[CacheTimestampPoller] Remote change detected for', key, '- invalidating');
                    CacheManager.invalidateByPrefix(key);
                }
            }
        } catch (err) {
            // Handle authentication errors by stopping the poller
            // The poller will restart after successful re-authentication
            const isAuthError = err && (
                err.status === 401 ||
                err.status === 403 ||
                err.result?.error?.code === 401 ||
                err.result?.error?.code === 403 ||
                err.result?.error?.status === 'UNAUTHENTICATED' ||
                err.result?.error?.status === 'PERMISSION_DENIED'
            );
            if (isAuthError) {
                console.warn('[CacheTimestampPoller] Authentication error detected, stopping poller:', err);
                stopCacheTimestampPoller();
                stopCacheCleanup();
                return;
            }
            console.warn('[CacheTimestampPoller] Poll failed:', err);
        }
    }, intervalMs);
}

export function stopCacheTimestampPoller() {
    if (_cacheTimestampPollerInterval) {
        clearInterval(_cacheTimestampPollerInterval);
        _cacheTimestampPollerInterval = null;
    }
}

export function restartCacheTimestampPoller() {
    if (!_cacheTimestampPollerInterval && _pollerReadFn) {
        startCacheTimestampPoller(_pollerReadFn, _pollerIntervalMs);
        startCacheCleanup(2 * 60 * 1000); // Also restart cleanup timer
    }
}

/**
 * Run the cache-timestamp poll cycle immediately (outside of the normal interval).
 * Reads the Caching tab, compares timestamps against in-memory cache entries,
 * and fires CacheInvalidationBus events for any stale entries found.
 *
 * Usage from the browser console:
 *   import('/docs/js/data_management/utils/caching.js').then(m => m.triggerCachePoll())
 * Or via the TSLI test helper (available on localhost):
 *   window.__tsliTestExternalChange('database:getData:"INVENTORY","FURNITURE"')
 */
export async function triggerCachePoll() {
    if (!_pollerReadFn) {
        console.warn('[CachePoll] No poll function configured — call startCacheTimestampPoller first.');
        return;
    }
    try {
        const entries = await _pollerReadFn();
        if (entries === null) {
            console.warn('[CachePoll] Auth unavailable, poll aborted.');
            return;
        }
        if (!Array.isArray(entries) || entries.length === 0) {
            console.log('[CachePoll] Caching tab is empty — no entries to check.');
            return;
        }
        console.log(`[CachePoll] Found ${entries.length} entries in Caching tab:`, entries.map(e => e.key));
        for (const { key, timestamp } of entries) {
            if (!key || !timestamp) continue;
            const remoteTs = new Date(timestamp).getTime();
            if (isNaN(remoteTs)) continue;
            let shouldInvalidate = false;
            let matchedCacheKey = null;
            for (const [cacheKey, entry] of CacheManager.cache.entries()) {
                if (cacheKey.startsWith(key) && entry.filled && remoteTs > entry.filled) {
                    shouldInvalidate = true;
                    matchedCacheKey = cacheKey;
                    break;
                }
            }
            // Fallback: check filledAt when live cache entry is absent (TTL expired)
            if (!shouldInvalidate) {
                for (const [filledKey, filledTs] of CacheManager.filledAt.entries()) {
                    if (filledKey.startsWith(key) && remoteTs > filledTs) {
                        shouldInvalidate = true;
                        matchedCacheKey = `(filledAt) ${filledKey}`;
                        break;
                    }
                }
            }
            if (shouldInvalidate) {
                console.log(`[CachePoll] Stale entry detected for "${key}" (matched: "${matchedCacheKey}") — invalidating.`);
                CacheManager.invalidateByPrefix(key);
            } else {
                const hasEntry = [...CacheManager.cache.keys()].some(k => k.startsWith(key)) ||
                                 [...CacheManager.filledAt.keys()].some(k => k.startsWith(key));
                if (!hasEntry) {
                    console.log(`[CachePoll] No cache entry found matching prefix "${key}" — nothing to invalidate.`);
                } else {
                    console.log(`[CachePoll] Cache for "${key}" is newer than remote timestamp — already up to date.`);
                }
            }
        }
    } catch (err) {
        console.warn('[CachePoll] Poll failed:', err);
    }
}