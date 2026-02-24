/**
 * Default cache expiration in milliseconds
 */
const DEFAULT_CACHE_EXPIRATION_MS = 20 * 60 * 1000;

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
    
    /**
     * Gets a value from cache with expiration check
     * @param {string} key - Cache key
     * @returns {*|null} - Cached value or null if not found/expired
     */
    static get(key) {
        const entry = CacheManager.cache.get(key);
        if (!entry) {
            return null;
        }
        
        // Check expiration
        if (entry.expire && entry.expire < Date.now()) {
            CacheManager.invalidate(key); // Invalidate the cache entry before deletion
            return null;
        }
        
        return entry.value;
    }
    
    /**
     * Sets a value in cache with default timeout
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     * @param {number} expirationMs - Expiration time in milliseconds (defaults to DEFAULT_CACHE_EXPIRATION_MS)
     */
    static set(key, value, expirationMs = DEFAULT_CACHE_EXPIRATION_MS) {
        // Skip caching empty results, null values, or booleans
        if (
            value === null ||
            value === undefined ||
            (Array.isArray(value) && value.length === 0) ||
            (typeof value === 'object' && value !== null && Object.keys(value).length === 0) ||
            (typeof value === 'boolean')
        ) {
            return;
        }
        
        CacheManager.cache.set(key, {
            value,
            expire: expirationMs ? Date.now() + expirationMs : null
        });
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
     * Invalidates a cache entry and all dependent entries
     * @param {string} key - Cache key to invalidate
     * @param {Set} invalidationStack - Set of keys currently being invalidated (to prevent recursion)
     */
    static invalidate(key, invalidationStack = new Set()) {        
        // Prevent infinite recursion - if this key is already being invalidated, skip it
        if (invalidationStack.has(key)) {
            return;
        }
        
        // Add this key to the invalidation stack
        invalidationStack.add(key);
        
        // Remove the cache entry
        CacheManager.cache.delete(key);
        
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
        
        // Clean up dependency registration
        CacheManager.dependencies.delete(key);
        
        
        // Emit invalidation event for reactive stores (only for 'api' namespace)
        // THIS MUST HAPPEN LAST to avoid incorrect cache hits during cascading invalidation
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
     * Invalidates all cache entries that start with a given prefix
     * @param {string} prefix - Cache key prefix to match
     */
    static invalidateByPrefix(prefix) {
        // Find all cache keys that start with the prefix
        const keysToInvalidate = [];
        for (const key of CacheManager.cache.keys()) {
            if (key.startsWith(prefix)) {
                keysToInvalidate.push(key);
            }
        }
        
        // Invalidate each matching key (this will also handle dependents)
        for (const key of keysToInvalidate) {
            CacheManager.invalidate(key);
        }
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
        return `${namespace}:${methodName}:${argsString}`;
    }

    /**
     * Invalidates specific cache entries
     * @param {Array<{namespace: string, methodName: string, args: Array}>} cacheEntries - Array of cache entries to invalidate
     * @param {boolean} invalidateByPrefix - If true, invalidates all caches that start with the cache key prefix
     */
    static invalidateCache(cacheEntries, invalidateByPrefix = false) {
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
     * @returns {Object} - Wrapped class with caching and dependency tracking
     */
    static wrapMethods(targetClass, namespace, mutationKeys = [], infiniteCacheMethods = [], customCacheDurations = {}) {
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
            
            wrappedClass[methodName] = async function(...args) {
                const cacheKey = CacheManager.generateCacheKey(namespace, methodName, args);
                
                // Check cache first
                const cached = CacheManager.get(cacheKey);
                if (cached !== null) {
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
                
                // Store the promise IMMEDIATELY before any async work starts (atomic)
                CacheManager.pendingCalls.set(cacheKey, pendingPromise);
                
                // Now execute the actual async work
                try {
                    // Create dependency decorator for this function call
                    const deps = CacheManager.createDependencyDecorator(cacheKey);
                    
                    // Execute method with dependency decorator as first parameter
                    const result = await targetClass[methodName](deps, ...args);
                    
                    // Determine expiration time:
                    // 1. Custom duration if specified for this method
                    // 2. Infinite cache (null) if in infiniteCacheMethods
                    // 3. Default duration otherwise (undefined = use DEFAULT_CACHE_EXPIRATION_MS)
                    let expirationMs;
                    if (customCacheDurations[methodName] !== undefined) {
                        expirationMs = customCacheDurations[methodName];
                    } else if (infiniteCacheMethods.includes(methodName)) {
                        expirationMs = null;
                    } else {
                        expirationMs = undefined;
                    }
                    
                    CacheManager.set(cacheKey, result, expirationMs);
                    
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
export { CacheInvalidationBus };