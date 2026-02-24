/**
 * Priority Queue System for CPU-Optimized API Call Management
 * 
 * This system manages API calls in priority-ordered batches to optimize CPU usage
 * and prevent UI freezing during heavy analysis operations.
 * 
 * Features:
 * - Priority levels 0-9 (0 = highest priority, 9 = lowest priority)
 * - CPU-aware concurrency (based on navigator.hardwareConcurrency)
 * - Batch processing to prevent queue starvation
 * - Progress tracking and observability
 * 
 * Default Priorities:
 * - Save operations: 9 (highest priority)
 * - Load operations: 8 (high priority)
 * - Analysis operations: 1 (low priority, background work)
 * 
 * Usage:
 * const result = await PriorityQueue.enqueue(apiFunction, args, 8); // Load call
 * const result = await PriorityQueue.enqueue(apiFunction, args, 1); // Analysis call
 */

class PriorityQueueManager {
    constructor() {
        // Priority buckets: 0-9 where 0 is highest priority
        this.queues = Array.from({ length: 10 }, () => []);
        
        // Detect CPU cores (default to 4 if unavailable)
        this.cpuCount = typeof navigator !== 'undefined' && navigator.hardwareConcurrency 
            ? navigator.hardwareConcurrency 
            : 4;
        
        // Active concurrent calls (tracks Promises in flight)
        this.activeCount = 0;
        
        // Maximum concurrent calls = cpuCount - 1 (leave one core for UI thread)
        this.maxConcurrent = Math.max(1, this.cpuCount - 1);
        
        // Statistics
        this.stats = {
            totalEnqueued: 0,
            totalCompleted: 0,
            totalErrors: 0,
            byPriority: Array.from({ length: 10 }, () => ({ enqueued: 0, completed: 0, errors: 0 }))
        };
        
        // Processing state
        this.isProcessing = false;
        this.processingIntervalId = null;
        this.isDisabled = false; // Permanently disabled during logout
        
        console.log(`[PriorityQueue] Initialized with ${this.cpuCount} CPU cores, max concurrent: ${this.maxConcurrent}`);
    }
    
    /**
     * Enqueue an API call with priority
     * @param {Function} apiFunction - The async function to execute
     * @param {Array} args - Arguments to pass to the function
     * @param {number} priority - Priority level 0-9 (0 = highest)
     * @param {Object} metadata - Optional metadata for tracking (label, storeId, etc.)
     * @returns {Promise} - Resolves with function result or rejects with error
     */
    enqueue(apiFunction, args = [], priority = 5, metadata = {}) {
        // If queue is disabled (during logout), silently reject
        if (this.isDisabled) {
            return Promise.resolve(null); // Return resolved promise with null instead of rejecting
        }
        
        // Validate priority
        priority = Math.max(0, Math.min(9, priority));

        // Create a unique key for deduplication (function ref + JSON args)
        const fnKey = apiFunction && apiFunction._methodName ? apiFunction._methodName : apiFunction.toString();
        const argsKey = JSON.stringify(args);
        const dedupeKey = `${fnKey}:${argsKey}`;

        // Create a deferred promise for the new call
        let resolveCallback, rejectCallback;
        const promise = new Promise((resolve, reject) => {
            resolveCallback = resolve;
            rejectCallback = reject;
        });

        // Create queue entry with subscribers array
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            apiFunction,
            args,
            priority,
            metadata,
            resolve: resolveCallback,
            reject: rejectCallback,
            enqueuedAt: Date.now(),
            dedupeKey,
            subscribers: [] // Will hold resolve/reject callbacks from cancelled calls
        };

        // Find and cancel any pending identical calls in this priority bucket
        // Cancelled calls will subscribe to the new call's result
        const queue = this.queues[priority];
        let subscriberCount = 0;
        for (let i = queue.length - 1; i >= 0; i--) {
            const oldEntry = queue[i];
            const entryFnKey = oldEntry.apiFunction && oldEntry.apiFunction._methodName ? oldEntry.apiFunction._methodName : oldEntry.apiFunction.toString();
            const entryArgsKey = JSON.stringify(oldEntry.args);
            const entryDedupeKey = `${entryFnKey}:${entryArgsKey}`;
            if (entryDedupeKey === dedupeKey) {
                // Transfer the old call's promise callbacks to the new call's subscribers
                entry.subscribers.push({
                    resolve: oldEntry.resolve,
                    reject: oldEntry.reject
                });
                // Also transfer any subscribers the old call had accumulated
                if (oldEntry.subscribers && oldEntry.subscribers.length > 0) {
                    entry.subscribers.push(...oldEntry.subscribers);
                }
                queue.splice(i, 1);
                subscriberCount++;
            }
        }
        
        if (subscriberCount > 0) {
            const totalSubscribers = entry.subscribers.length;
            console.log(`[PriorityQueue] ${subscriberCount} older call(s) subscribed to newer call (${totalSubscribers} total subscribers, priority ${priority})`);
        }

        // Add to appropriate priority queue
        queue.push(entry);

        // Update statistics
        this.stats.totalEnqueued++;
        this.stats.byPriority[priority].enqueued++;

        // Start processing if not already running
        if (!this.isProcessing) {
            this.startProcessing();
        }

        return promise;
    }
    
    /**
     * Start the queue processing loop
     */
    startProcessing() {
        if (this.isProcessing) return;
        
        this.isProcessing = true;
        console.log('[PriorityQueue] Starting queue processor');
        
        // Process queue continuously
        this.processQueue();
    }
    
    /**
     * Stop the queue processing loop
     */
    stopProcessing() {
        this.isProcessing = false;
        if (this.processingIntervalId) {
            clearTimeout(this.processingIntervalId);
            this.processingIntervalId = null;
        }
        console.log('[PriorityQueue] Stopped queue processor');
    }
    
    /**
     * Disable the queue (for logout)
     * Prevents new tasks from being enqueued
     */
    disable() {
        this.isDisabled = true;
        this.stopProcessing();
        this.clearAll();
        console.log('[PriorityQueue] Queue disabled');
    }
    
    /**
     * Re-enable the queue (for login)
     * Allows tasks to be enqueued again
     */
    enable() {
        this.isDisabled = false;
        console.log('[PriorityQueue] Queue enabled');
    }
    
    /**
     * Main queue processing logic
     * Processes entries in priority order, respecting concurrency limits
     */
    async processQueue() {
        if (!this.isProcessing) return;
        
        // Check if we can process more calls
        while (this.activeCount < this.maxConcurrent) {
            const entry = this.dequeueNext();
            
            if (!entry) {
                // No more entries, check again after a short delay
                break;
            }
            
            // Execute the call (non-blocking)
            this.executeEntry(entry);
        }
        
        // Schedule next processing cycle
        // Use setTimeout to yield to event loop
        if (this.isProcessing) {
            this.processingIntervalId = setTimeout(() => {
                this.processQueue();
            }, 10); // Check every 10ms
        }
    }
    
    /**
     * Dequeue the next entry to process (highest priority first)
     * @returns {Object|null} - Next entry or null if queue is empty
     */
    dequeueNext() {
        // Iterate through priorities from highest (0) to lowest (9)
        for (let priority = 0; priority < 10; priority++) {
            const queue = this.queues[priority];
            if (queue.length > 0) {
                return queue.shift(); // FIFO within priority level
            }
        }
        
        // All queues empty
        return null;
    }
    
    /**
     * Execute a queued entry
     * @param {Object} entry - Queue entry to execute
     */
    async executeEntry(entry) {
        this.activeCount++;
        
        const startTime = Date.now();
        
        try {
            // Execute the API function
            const result = await entry.apiFunction(...entry.args);
            
            // Resolve the main promise
            entry.resolve(result);
            
            // Resolve all subscriber promises (cancelled calls)
            if (entry.subscribers && entry.subscribers.length > 0) {
                entry.subscribers.forEach(subscriber => {
                    subscriber.resolve(result);
                });
                console.log(`[PriorityQueue] Notified ${entry.subscribers.length} subscriber(s) with result`);
            }
            
            // Update statistics
            this.stats.totalCompleted++;
            this.stats.byPriority[entry.priority].completed++;
            
            const duration = Date.now() - startTime;
            //console.log(`[PriorityQueue] Completed priority ${entry.priority} call in ${duration}ms (${entry.metadata.label || entry.id})`);
            
        } catch (error) {
            // Reject the main promise
            entry.reject(error);
            
            // Reject all subscriber promises (cancelled calls)
            if (entry.subscribers && entry.subscribers.length > 0) {
                entry.subscribers.forEach(subscriber => {
                    subscriber.reject(error);
                });
            }
            
            // Update statistics
            this.stats.totalErrors++;
            this.stats.byPriority[entry.priority].errors++;
            
            console.error(`[PriorityQueue] Error in priority ${entry.priority} call:`, error, entry.metadata);
        } finally {
            this.activeCount--;
        }
    }
    
    /**
     * Get current queue statistics
     * @returns {Object} - Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            currentQueueSize: this.queues.reduce((sum, q) => sum + q.length, 0),
            activeCount: this.activeCount,
            maxConcurrent: this.maxConcurrent,
            cpuCount: this.cpuCount,
            queueSizesByPriority: this.queues.map(q => q.length)
        };
    }
    
    /**
     * Get current queue lengths by priority
     * @returns {Array<number>} - Array of queue lengths
     */
    getQueueLengths() {
        return this.queues.map(q => q.length);
    }
    
    /**
     * Clear all queues (for testing/debugging)
     */
    clearAll() {
        this.queues.forEach(q => {
            q.forEach(entry => {
                entry.reject(new Error('Queue cleared'));
            });
            q.length = 0;
        });
        console.log('[PriorityQueue] All queues cleared');
    }
    
    /**
     * Get total pending calls across all priorities
     * @returns {number} - Total pending calls
     */
    getPendingCount() {
        return this.queues.reduce((sum, q) => sum + q.length, 0);
    }
}

// Create singleton instance
export const PriorityQueue = new PriorityQueueManager();

// Export priority constants for convenience
export const Priority = {
    CRITICAL: 0,      // Immediate user actions (clicks, navigation)
    SAVE: 9,          // Save operations (high priority)
    LOAD: 8,          // Load operations (high priority)
    USER_ACTION: 7,   // User-initiated actions
    REFRESH: 6,       // Data refresh operations
    NORMAL: 5,        // Default priority
    PREFETCH: 3,      // Background prefetching
    ANALYSIS: 1,      // Analysis operations (low priority background work)
    BACKGROUND: 0     // Lowest priority background tasks
};

// Make PriorityQueue available globally for debugging
if (typeof window !== 'undefined') {
    window.PriorityQueue = PriorityQueue;
}
