import { CacheInvalidationBus, ProgressBus, Requests, authState, Auth, resolveInventoryNoteMaxLength, resolveInventoryTabList } from '../index.js';
import { PriorityQueue, Priority } from './priorityQueue.js';

// Re-export Priority for component use
export { Priority };

/**
 * Global application settings for reactive stores and analysis
 */
export const appSettings = Vue.reactive({
    onlyRunEssentialAnalysis: localStorage.getItem('essentialAnalysisOnly') === 'true', // When true, only run analysis marked as essential
    showDashboardHeaders: localStorage.getItem('showDashboardHeaders') !== 'false' // When false, hide dashboard card headers (defaults to true)
});

/**
 * Reactive Store System with Configurable Analysis and Auto-Save
 * 
 * This system provides Vue 3 reactive data stores with optional automatic analysis
 * and automatic backup to user data.
 * 
 * Example usage with analysis:
 * 
 * // Define analysis steps
 * const analysisConfig = [
 *     createAnalysisConfig(
 *         Requests.getItemInfo,     // API function
 *         'itemInfo',               // Result key in AppData  
 *         'Loading item info...',   // UI label
 *         'itemId',                 // Source column (or null for entire item)
 *         ['details'],              // Additional parameters
 *         'Items'                   // Also process nested 'Items' arrays
 *     ),
 *     createAnalysisConfig(
 *         Requests.checkQuantity,
 *         'quantityStatus', 
 *         'Checking quantities...',
 *         'itemId'
 *     )
 * ];
 * 
 * // Create store with analysis
 * const store = getReactiveStore(
 *     Requests.getPackList,      // Load function
 *     Requests.savePackList,     // Save function
 *     [tabName],                 // API arguments
 *     analysisConfig             // Analysis configuration
 * );
 * 
 * // Results will be stored in item.AppData[resultKey] automatically after data loads
 * 
 * Key Features:
 * - Automatic analysis execution when data loads/reloads
 * - Results cleared and re-analyzed on each data load
 * - Support for nested data processing (e.g., Items within Crates)
 * - Progress tracking with meaningful UI labels
 * - Error isolation - individual analysis failures don't stop the process
 * - Declarative configuration - no manual step creation needed
 * 
 * Auto-Save Features:
 * - Dirty stores automatically backed up to user data every 20 minutes
 * - Backups restored on store initialization if present
 * - Backups removed automatically after successful save
 * - Auto-save timer starts when first store is created
 * - Auto-save timer stops when all stores are cleared (logout)
 * 
 * Cache Invalidation & Analysis Flow:
 * - When main data is invalidated (e.g., after save):
 *   1. isReloadingMainData lock is set to prevent concurrent analysis
 *   2. Data is reloaded from server
 *   3. Analysis runs automatically after load completes
 *   4. Lock is released
 * - When analysis data is invalidated:
 *   1. 50ms delay allows main reload to register if happening simultaneously
 *   2. If main reload is active, analysis is skipped (will run after reload)
 *   3. Otherwise, specific analysis step is cleared and re-run
 * - This prevents analysis from running on empty/stale data during reload
 * 
 * Preemptive Eviction Optimization:
 * - On cache invalidation, before reloading, check store's priority score
 * - If score is in bottom 30% of all active stores (low priority):
 *   1. Evict the store instead of reloading it
 *   2. Saves API call and CPU for data that would be evicted soon anyway
 *   3. Store will reload if actually accessed again (lazy loading)
 * - Never preemptively evicts: exempt stores, modified stores, or when under capacity
 * - This optimization reduces unnecessary network/CPU usage during invalidation cascades
 */

/**
 * Generate a clean identifier for a function, using cache metadata when available
 * @param {Function} fn - The function to identify
 * @returns {string} A clean identifier string
 */
function getMethodIdentifier(fn) {
    if (!fn) return '';
    // If function has cache wrapper metadata, use it for a clean identifier
    if (fn._namespace && fn._methodName) {
        return `${fn._namespace}.${fn._methodName}`;
    }
    // Otherwise fall back to toString (for unwrapped functions)
    return fn.toString();
}

/**
 * Create a concise identifier for an analysis configuration
 * @param {Array} analysisConfig - Analysis configuration array
 * @returns {string} A compact identifier string
 */
function getAnalysisIdentifier(analysisConfig) {
    if (!analysisConfig || !Array.isArray(analysisConfig) || analysisConfig.length === 0) {
        return '';
    }
    
    // Create a compact representation: functionName(sourceColumns)[additionalParams]->resultKey
    return analysisConfig.map(config => {
        const funcName = getMethodIdentifier(config.apiFunction);
        const sources = Array.isArray(config.sourceColumns) && config.sourceColumns.length > 0 
            ? `(${config.sourceColumns.join(',')})` 
            : '';
        const params = Array.isArray(config.additionalParams) && config.additionalParams.length > 0 
            ? `[${JSON.stringify(config.additionalParams)}]` 
            : '';
        const target = config.resultKey ? `->${config.resultKey}` : '';
        return `${funcName}${sources}${params}${target}`;
    }).join('|');
}

/**
 * Generate a store key from API calls and parameters
 * @param {Function} apiCall - The API load function
 * @param {Function} saveCall - The API save function
 * @param {Array} apiArgs - Arguments for the API call
 * @param {Array} analysisConfig - Analysis configuration
 * @returns {string} The generated store key
 */
export function generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig) {
    return getMethodIdentifier(apiCall) + ':' + getMethodIdentifier(saveCall) + ':' + JSON.stringify(apiArgs) + ':' + getAnalysisIdentifier(analysisConfig);
}

/**
 * Build a set of columns that should be excluded from comparisons and saves
 * @param {Array} analysisConfig - Analysis configuration
 * @returns {Set} Set of column names to exclude
 */
function getExcludedColumns(analysisConfig = null) {
    const excludedColumns = new Set(['AppData']); // edithistory should persist, only AppData is ephemeral
    if (analysisConfig && Array.isArray(analysisConfig)) {
        analysisConfig.forEach(config => {
            if (config.targetColumn) {
                excludedColumns.add(config.targetColumn);
            }
        });
    }
    return excludedColumns;
}

/**
 * Check if a key should be excluded from data operations
 * @param {string} key - The key to check
 * @param {Set} excludedColumns - Set of excluded column names
 * @returns {boolean} True if should be excluded
 */
function shouldExcludeColumn(key, excludedColumns) {
    return excludedColumns.has(key);
}

/**
 * Check if an item is marked for deletion
 * @param {Object} obj - The object to check
 * @returns {boolean} True if marked for deletion
 */
export function isMarkedForDeletion(obj) {
    if (!isValidObject(obj) || !obj.metadata) return false;
    try {
        const metadata = typeof obj.metadata === 'string' ? JSON.parse(obj.metadata) : obj.metadata;
        return metadata?.deletion?.marked === true;
    } catch (e) {
        return false;
    }
}

/**
 * Compare two values for equality using JSON serialization
 * @param {*} value1 - First value
 * @param {*} value2 - Second value
 * @returns {boolean} True if values are equal
 */
function areValuesEqual(value1, value2) {
    return JSON.stringify(value1) === JSON.stringify(value2);
}

/**
 * Deep clone a value using JSON serialization
 * @param {*} value - Value to clone
 * @returns {*} Deep cloned value
 */
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Check if a value is a valid object (not null, not an array)
 * @param {*} value - Value to check
 * @returns {boolean} True if value is an object
 */
function isValidObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Store an analysis result on an item based on configuration
 * @param {Object} item - The item to store the result on
 * @param {Object} config - The analysis configuration
 * @param {*} result - The result to store
 */
function storeAnalysisResult(item, config, result) {
    // Store result based on return value:
    // - undefined: preserve existing value (do nothing)
    // - null: explicitly clear the value
    // - any other value: update with new value
    if (result !== undefined) {
        if (config.targetColumn) {
            item[config.targetColumn] = result;
        } else {
            item.AppData[config.resultKey] = result;
        }
    }
}

/**
 * Store an analysis error on an item based on configuration
 * @param {Object} item - The item to store the error on
 * @param {Object} config - The analysis configuration
 * @param {Error} error - The error to store
 */
function storeAnalysisError(item, config, error) {
    if (config.targetColumn) {
        item.AppData[`${config.targetColumn}_error`] = error.message;
    } else {
        item.AppData[`${config.resultKey}_error`] = error.message;
    }
}

/**
 * Clear analysis results from an item based on configuration
 * @param {Object} item - The item to clear results from
 * @param {Object} config - The analysis configuration
 * @param {boolean} clearTargetColumn - Whether to clear target column data (used in clearSpecificAnalysisResults)
 */
function clearAnalysisResultsFromItem(item, config, clearTargetColumn = false) {
    if (!item || !item.AppData) return;
    
    if (config.targetColumn) {
        if (clearTargetColumn && item.hasOwnProperty(config.targetColumn)) {
            item[config.targetColumn] = null;
        }
        delete item.AppData[`${config.targetColumn}_error`];
    } else {
        // Don't delete the resultKey - set to null instead to maintain Vue reactivity
        // The field was initialized in appDataInit and must remain defined for reactive tracking
        if (config.resultKey in item.AppData) {
            item.AppData[config.resultKey] = null;
        }
        delete item.AppData[`${config.resultKey}_error`];
    }
}

// Modular reactive store factory for any generic data, with async API calls for load and save
export function createReactiveStore(apiCall = null, saveCall = null, apiArgs = [], analysisConfig = null, priorityConfig = null, exemptFromEviction = false) {
    // Priority configuration with defaults
    const priorities = {
        load: priorityConfig?.load !== undefined ? priorityConfig.load : Priority.LOAD,      // Default: 8
        save: priorityConfig?.save !== undefined ? priorityConfig.save : Priority.SAVE,      // Default: 9
        analysis: priorityConfig?.analysis !== undefined ? priorityConfig.analysis : Priority.ANALYSIS  // Default: 1
    };
    // Helper to recursively add AppData to all objects in an array (and nested arrays)
    function appDataInit(arr, forceFresh = false) {
        if (!Array.isArray(arr)) return arr;
        return arr.map(obj => {
            if (obj && typeof obj === 'object') {
                // Preserve the stable row ID across AppData resets
                const existingRowId = obj.AppData?._rowId;
                // Always create fresh AppData if forceFresh is true (e.g., on refresh to clear stale data)
                if (forceFresh || !('AppData' in obj) || typeof obj.AppData !== 'object' || obj.AppData === null) {
                    obj['AppData'] = {};
                }
                // Restore or assign a stable runtime row ID (never persisted, used for move-tracking)
                obj.AppData._rowId = existingRowId || Math.random().toString(36).slice(2, 10);
                
                // Initialize analysis target columns and AppData result keys if they don't exist
                if (analysisConfig && Array.isArray(analysisConfig)) {
                    analysisConfig.forEach(config => {
                        if (config.targetColumn && !(config.targetColumn in obj)) {
                            obj[config.targetColumn] = null; // Initialize to null for proper placeholder display
                        }
                        // Also initialize AppData result keys for proper reactivity
                        if (config.resultKey && !(config.resultKey in obj.AppData)) {
                            obj.AppData[config.resultKey] = null;
                        }
                    });
                }
                
                // Recursively initialize nested arrays (e.g., Items)
                Object.keys(obj).forEach(key => {
                    if (Array.isArray(obj[key])) {
                        obj[key] = appDataInit(obj[key], forceFresh);
                    }
                });
            }
            return obj;
        });
    }

    // Helper to clear analysis results from AppData and target columns
    function clearAnalysisResults(arr, analysisConfig) {
        if (!Array.isArray(arr) || !analysisConfig) return arr;
        
        const clearResults = (item) => {
            if (item && item.AppData) {
                analysisConfig.forEach(config => {
                    clearAnalysisResultsFromItem(item, config, false); // Don't clear target column data
                });
                // Clear analysis state
                delete item.AppData._analyzed;
                delete item.AppData._analyzing;
            }
        };

        arr.forEach(item => {
            clearResults(item);
            // Also clear nested arrays if they exist
            if (item && typeof item === 'object') {
                Object.keys(item).forEach(key => {
                    if (Array.isArray(item[key])) {
                        item[key].forEach(nestedItem => clearResults(nestedItem));
                    }
                });
            }
        });
        
        return arr;
    }

    // Read-only stores (saveCall === null) never need originalData: isModified is always false,
    // saves are impossible, and no unsaved-changes guards or undo baselines apply.
    // Skipping originalData eliminates one full deep clone of the dataset and prevents
    // isModified from running expensive JSON comparisons on every reactive evaluation.
    const isReadOnly = typeof saveCall !== 'function';

    // Analyses marked keepWhileRefreshing keep their last result until a re-run replaces it: a
    // reload carries each result to the new row with the same input values (sourceColumns), and an
    // invalidation re-runs without clearing first. The rows never show a blank while refreshing.
    const keptConfigs = (analysisConfig || []).filter(c => c.keepWhileRefreshing && c.sourceColumns?.length);
    const inputKey = (row, c) => JSON.stringify(c.sourceColumns.map(k => row?.[k] ?? null));
    const resultOf = (row, c) => (c.targetColumn ? row?.[c.targetColumn] : row?.AppData?.[c.resultKey]);
    function keptResults(rows) {
        return keptConfigs.map(c => new Map(rows
            .filter(row => resultOf(row, c) != null)
            .map(row => [inputKey(row, c), resultOf(row, c)])));
    }
    function restoreKept(rows, kept) {
        keptConfigs.forEach((c, n) => {
            for (const row of rows) {
                const value = kept[n].get(inputKey(row, c));
                if (value === undefined || !row?.AppData) continue;
                if (c.targetColumn) row[c.targetColumn] = value;
                else row.AppData[c.resultKey] = value;
            }
        });
    }

    // An evicted store that is still read loads again. Pages often get a store once (mounted) and
    // read it through computeds, so eviction would otherwise leave them empty until remount.
    // This module reads _data, so its own sweeps, timers and methods never wake an evicted store.
    let reloadQueued = false;
    function reloadWhenRead(s) {
        if (reloadQueued) return;
        reloadQueued = true;
        Promise.resolve().then(() => {
            reloadQueued = false;
            if (s.needsReload && !s.isLoading) s.load('Reloading evicted store...');
        });
    }

    const store = Vue.reactive({
        _data: [],
        // The rows (mutated in place, never reassigned)
        get data() {
            if (this.needsReload) reloadWhenRead(this);
            return this._data;
        },
        // For read-only stores this is kept as a plain (non-reactive) empty array.
        // Never populated — use store.isModified (always false) to check edit state.
        originalData: isReadOnly ? [] : [],
        isLoading: false,
        loadingMessage: '',
        loadingProgress: -1, // 0-100 when a long-running load emits progress; -1 = indeterminate
        error: null,
        isAnalyzing: false,
        isReloadingMainData: false, // Lock to prevent analysis during main data reload
        isSaving: false, // True only during the save operation (used to suppress false conflict detection from the save cascade)
        externalConflict: false, // True when an external session mutated this data while we have unsaved changes
        lockConflictOwner: null, // Set when a save is blocked by a competing lock
        analysisProgress: -1,
        analysisMessage: '',
        analysisConfig,
        initialLoad: false, // True if this is the first load of the store
        autoSaved: false, // True if this store has been auto-saved or loaded from auto-save
        lastAutoSaveHash: null, // Hash of data when last auto-saved, to prevent redundant saves
        loadedBackupKey: null, // Original backup key used for restore (may differ from current key)
        needsReload: false, // True when store was cleared by logout — reloadErrorStores() will reload after login
        exemptFromEviction, // True if this is a core store that should never be evicted (e.g., dashboard userData)
        
        // Computed property to check if data has been modified.
        // Always returns false for read-only stores (saveCall === null) — no deep clone performed.
        get isModified() {
            if (isReadOnly) return false;
            if (!this._data || !this.originalData) return false;
            if (this._data.length === 0 && this.originalData.length === 0) return false;
            
            // Create clean copies without AppData and analysis columns for comparison
            const cleanCurrent = removeAppData(
                deepClone(this._data), 
                this.analysisConfig
            );
            const cleanOriginal = removeAppData(
                deepClone(this.originalData), 
                this.analysisConfig
            );
            
            // Deep comparison using JSON serialization
            return !areValuesEqual(cleanCurrent, cleanOriginal);
        },
        
        setData(newData) {
            // Deep clone and initialize AppData (force fresh to clear any stale data from server)
            const processedData = appDataInit(deepClone(newData), true);
            // Clear any existing analysis results if analysis is configured
            if (this.analysisConfig) {
                clearAnalysisResults(processedData, this.analysisConfig);
            }
            // Mutate existing array in place to preserve references (critical for undo system)
            this._data.splice(0, this._data.length, ...processedData);
            // Clear auto-save hash when data changes
            this.lastAutoSaveHash = null;
            
            // Automatically run analysis if configured and data is loaded
            // Skip if main data is being reloaded (will run after reload completes)
            if (this.analysisConfig && this._data.length > 0 && !this.isAnalyzing && !this.isReloadingMainData) {
                // Use nextTick to ensure Vue has updated the DOM and reactive properties
                Vue.nextTick(() => {
                    this.runConfiguredAnalysis();
                });
            }
        },
        setOriginalData(newOriginalData) {
            // Deep clone and initialize AppData (force fresh for original data too)
            const processedData = appDataInit(deepClone(newOriginalData), true);
            // Mutate existing array in place to preserve references
            this.originalData.splice(0, this.originalData.length, ...processedData);
        },
        setError(err) {
            this.error = err;
        },
        setLoading(isLoading, message = '') {
            this.isLoading = isLoading;
            this.loadingMessage = message;
            if (!isLoading) this.loadingProgress = -1;
        },
        reset() {
            // Clear arrays in place to preserve references for undo system
            this._data.splice(0, this._data.length);
            this.originalData.splice(0, this.originalData.length);
            this.isLoading = false;
            this.loadingMessage = '';
            this.loadingProgress = -1;
            this.error = null;
            this.isAnalyzing = false;
            this.analysisProgress = -1;
            this.analysisMessage = '';
        },
        async load(message = 'Loading data...', skipAnalysis = false) {
            this.needsReload = false; // Clear flag set by eviction
            if (typeof apiCall !== 'function') {
                this.setError('No API call provided');
                // Initialize with empty array to allow dynamic property addition
                if (!isReadOnly) this.setOriginalData([]);
                this.setData([]);
                return;
            }
            // Edits made while the fetch is in flight must not be overwritten when it resolves.
            // A store that is already modified here is being discarded/refreshed on purpose.
            const modifiedAtStart = !isReadOnly && this.isModified;
            this.setLoading(true, message);
            this.loadingProgress = -1;
            this.isReloadingMainData = true; // Lock to prevent analysis during reload
            this.externalConflict = false;
            this.lockConflictOwner = null;
            this.setError(null);

            // Subscribe to progress events emitted by the API function for this load
            const progressTopic = apiCall._namespace && apiCall._methodName
                ? `${apiCall._namespace}:${apiCall._methodName}`
                : null;
            // Track original loading message to restore after rate limit clears
            let originalMessage = message;
            
            const onProgress = progressTopic ? ({ current, total, message: msg }) => {
                if (msg) {
                    this.loadingMessage = msg;
                    originalMessage = msg; // Track the latest non-rate-limit message
                }
                if (total > 0 && current !== undefined) {
                    this.loadingProgress = Math.round((current / total) * 100);
                }
            } : null;
            
            // System-level rate limit listener (all stores listen to this)
            const onRateLimit = ({ message: msg }) => {
                if (msg) {
                    this.loadingMessage = msg;
                    this.loadingProgress = -1; // Indeterminate during rate limit
                } else {
                    // Rate limit cleared, restore original message
                    this.loadingMessage = originalMessage;
                }
            };
            
            if (progressTopic && onProgress) {
                ProgressBus.on(progressTopic, onProgress);
            }
            ProgressBus.on('system:rateLimit', onRateLimit);

            try {
                // Use priority queue for load operations (high priority)
                const result = await PriorityQueue.enqueue(
                    apiCall,
                    apiArgs,
                    priorities.load,
                    { label: message, type: 'load', store: 'reactive' }
                );
                // The user edited during the fetch: keep their edits and flag the newer server
                // data as a conflict, as the invalidation handler does for a modified store.
                if (!modifiedAtStart && !isReadOnly && this.isModified) {
                    this.externalConflict = true;
                    return;
                }
                // Handle null, undefined, or empty results by initializing empty arrays
                const dataToSet = (result && Array.isArray(result)) ? result : [];
                // Pre-assign stable row IDs before splitting into data and originalData.
                appDataInit(dataToSet, false);
                // Read-only stores skip originalData entirely — no second deep clone needed.
                if (!isReadOnly) {
                    this.setOriginalData(dataToSet);
                }
                const kept = keptResults(this._data);
                this.setData(dataToSet);
                restoreKept(this._data, kept);
                
                // Release lock BEFORE running analysis so analysis can proceed
                this.isReloadingMainData = false;
                
                // After data is loaded, run analysis if configured, data exists, and not skipped
                if (!skipAnalysis && this.analysisConfig && this.analysisConfig.length > 0 && this._data.length > 0) {
                    await this.runConfiguredAnalysis();
                }
            } catch (err) {
                const isAuthError = err?.status === 401 || err?.result?.error?.code === 401 || err?.result?.error?.status === 'UNAUTHENTICATED';
                if (isAuthError) {
                    Auth.checkAuthWithPrompt({ context: 'data load' });
                }
                this.setError(err.message || 'Failed to load data');
                // Initialize with empty arrays to allow dynamic property addition
                if (!isReadOnly) this.setOriginalData([]);
                this.setData([]);
            } finally {
                if (progressTopic && onProgress) {
                    ProgressBus.off(progressTopic, onProgress);
                }
                ProgressBus.off('system:rateLimit', onRateLimit);
                this.setLoading(false, '');
                // Ensure lock is released even if analysis fails
                this.isReloadingMainData = false;
            }
        },
        async save(message = 'Saving data...', options = {}) {
            if (typeof saveCall !== 'function') {
                this.setError('No save API call provided');
                return;
            }
            this.isSaving = true;
            this.setLoading(true, message);
            this.setError(null);
            this.lockConflictOwner = null;
            try {
                // Remove all objects marked for deletion and analysis target columns before saving
                const cleanData = removeAppData(this._data, this.analysisConfig);
                // Use priority queue for save operations (highest priority)
                // Pass options as the last parameter to save functions that support it
                const result = await PriorityQueue.enqueue(
                    saveCall,
                    [...(cleanData ? [cleanData] : []), ...apiArgs, options],
                    priorities.save,
                    { label: message, type: 'save', store: 'reactive' }
                );
                // now remove the rows marked for deletion from live data without breaking reactivity:
                this.removeMarkedRows();
                // Sync originalData to the saved state so isModified becomes false.
                // Must happen after removeMarkedRows so deleted rows are not included in the baseline.
                this.setOriginalData(this._data);
                
                // Remove backup from user data after successful save
                const storeKey = generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig);
                await removeStoreBackupFromUserData(storeKey);
                if (this.loadedBackupKey && this.loadedBackupKey !== storeKey) {
                    await removeStoreBackupFromUserData(this.loadedBackupKey);
                }
                this.loadedBackupKey = null;
                this.autoSaved = false; // Clear auto-save flag after successful save
                this.lastAutoSaveHash = null; // Clear auto-save hash after manual save
                this.externalConflict = false; // Conflict resolved — our save is now the latest
                // Repopulate cache after save so the poller can detect future cross-session changes.
                // The cascade during setData deleted the cache entries; this restores them without
                // affecting store state (result is discarded).
                apiCall(...apiArgs).catch(() => {});
                
                return result;
            } catch (err) {
                const isAuthError = err?.status === 401 || err?.result?.error?.code === 401 || err?.result?.error?.status === 'UNAUTHENTICATED';
                if (isAuthError) {
                    Auth.checkAuthWithPrompt({ context: 'data save' });
                    return false;
                }
                const lockMatch = err?.message?.match(/locked by (.+)$/i);
                if (lockMatch) {
                    this.lockConflictOwner = lockMatch[1];
                    this.setError(null);
                } else {
                    this.setError(err.message || 'Failed to save data');
                }
                return false;
            } finally {
                this.isSaving = false;
                this.setLoading(false, '');
            }
        },
        // Mark/unmark for deletion by index using metadata
        markRowForDeletion(idx, value = true) {
            if (this._data[idx]) {
                const row = this._data[idx];
                
                // Parse existing metadata
                let metadata = {};
                if (row.metadata) {
                    try {
                        metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                    } catch (e) {
                        console.warn('Failed to parse metadata:', e);
                    }
                }
                
                // Set or remove deletion flag
                if (value) {
                    metadata.deletion = { marked: true };
                } else {
                    delete metadata.deletion;
                }
                
                // Save back to metadata
                row.metadata = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
                
                // If marking for deletion and row is empty, remove immediately
                if (value) {
                    // Check if all fields (except 'AppData' and 'metadata') are empty/falsy
                    const hasContent = Object.keys(row).some(
                        key => key !== 'AppData' && key !== 'metadata' && !!row[key]
                    );
                    if (!hasContent) {
                        this._data.splice(idx, 1);
                    }
                }
            }
        },
        // Remove all rows marked for deletion (and nested arrays)
        removeMarkedRows() {
            // Filter in place to preserve array reference for undo system
            const filteredData = this._data.filter(obj => !isMarkedForDeletion(obj));
            
            // Recursively filter nested arrays in place too
            filteredData.forEach(obj => {
                if (isValidObject(obj)) {
                    Object.keys(obj).forEach(key => {
                        if (Array.isArray(obj[key])) {
                            // Filter nested array in place
                            const filteredNested = obj[key].filter(nestedObj => !isMarkedForDeletion(nestedObj));
                            obj[key].splice(0, obj[key].length, ...filteredNested);
                        }
                    });
                }
            });
            
            // Replace data array contents in place (preserves reference)
            this._data.splice(0, this._data.length, ...filteredData);
        },
        addRow(row, fieldNames = null) {
            // Ensure AppData is set and nested arrays are initialized
            if (row && typeof row === 'object') {
                if (!('AppData' in row) || typeof row.AppData !== 'object' || row.AppData === null) {
                    row['AppData'] = {};
                }
                if (!row.AppData._rowId) {
                    row.AppData._rowId = Math.random().toString(36).slice(2, 10);
                }
                // Initialize fields to empty string if fieldNames provided
                if (Array.isArray(fieldNames)) {
                    row = initializeRowFields(row, fieldNames);
                }
                Object.keys(row).forEach(key => {
                    if (Array.isArray(row[key])) {
                        row[key] = appDataInit(row[key]);
                    }
                });
            }
            this._data.push(row);
        },
        addNestedRow(parentIdx, key, row, fieldNames = null, position = null) {
            // Add a row to a nested array (e.g., Items)
            // position: { position: 'above'|'below', targetIndex: number } or null for append
            if (
                Array.isArray(this._data) &&
                this._data[parentIdx] &&
                Array.isArray(this._data[parentIdx][key])
            ) {
                if (row && typeof row === 'object') {
                    if (!('AppData' in row) || typeof row.AppData !== 'object' || row.AppData === null) {
                        row['AppData'] = {};
                    }
                    if (!row.AppData._rowId) {
                        row.AppData._rowId = Math.random().toString(36).slice(2, 10);
                    }
                    // Initialize fields to empty string if fieldNames provided
                    if (Array.isArray(fieldNames)) {
                        row = initializeRowFields(row, fieldNames);
                    }
                    Object.keys(row).forEach(k => {
                        if (Array.isArray(row[k])) {
                            row[k] = appDataInit(row[k]);
                        }
                    });
                }
                
                // Insert at specific position if provided
                if (position && typeof position.targetIndex === 'number') {
                    const insertIndex = position.position === 'above' 
                        ? position.targetIndex 
                        : position.targetIndex + 1;
                    this._data[parentIdx][key].splice(insertIndex, 0, row);
                    
                    // If the row above the insertion point is in a group, add the new row to that group
                    const items = this._data[parentIdx][key];
                    const rowAbove = insertIndex > 0 ? items[insertIndex - 1] : null;
                    if (rowAbove && rowAbove.metadata) {
                        try {
                            const aboveMeta = JSON.parse(rowAbove.metadata);
                            const aboveGrouping = aboveMeta?.grouping;
                            if (aboveGrouping) {
                                let meta = {};
                                try { meta = JSON.parse(row.metadata || '{}'); } catch (e) { meta = {}; }
                                meta.grouping = { groupId: aboveGrouping.groupId, isGroupMaster: false };
                                row.metadata = JSON.stringify(meta);
                            }
                        } catch (e) { /* malformed metadata - skip grouping */ }
                    }
                } else {
                    // Default: append to end
                    this._data[parentIdx][key].push(row);
                }
            }
        },
        // Clear specific analysis results by result key or target column
        clearSpecificAnalysisResults(identifiers = []) {
            if (!this.analysisConfig || !Array.isArray(identifiers) || identifiers.length === 0) {
                return;
            }
            
            const clearSpecificResults = (item) => {
                if (item && item.AppData) {
                    this.analysisConfig.forEach(config => {
                        // keepWhileRefreshing results stay until the re-run replaces them
                        const shouldClear = !config.keepWhileRefreshing && (identifiers.includes(config.resultKey) ||
                                          identifiers.includes(config.targetColumn));
                        
                        if (shouldClear) {
                            clearAnalysisResultsFromItem(item, config, true); // Clear target column data
                        }
                    });
                }
            };

            this._data.forEach(item => {
                clearSpecificResults(item);
                // Also clear nested arrays if they exist
                if (item && typeof item === 'object') {
                    Object.keys(item).forEach(key => {
                        if (Array.isArray(item[key])) {
                            item[key].forEach(nestedItem => clearSpecificResults(nestedItem));
                        }
                    });
                }
            });
        },
        async runConfiguredAnalysis(options = {}) {
            // Check if main data is being reloaded - don't run analysis during reload
            if (this.isReloadingMainData) {
                //console.log('[ReactiveStore] Skipping analysis - main data is being reloaded');
                return;
            }
            
            if (!this.analysisConfig || this.isAnalyzing) {
                return;
            }
            this._pendingReanalysis = false;

            const {
                batchSize = 10,
                delayMs = 50,
                skipIfAnalyzed = false,
                essentialOnly = appSettings.onlyRunEssentialAnalysis // Check global setting
            } = options;

            this.isAnalyzing = true;
            this.analysisProgress = -1;
            this.analysisMessage = 'Starting analysis...';

            try {
                // Helper to find value from ordered source columns
                const findSourceValue = (item, sourceColumns, parentItem = null, extractAsObject = false) => {
                    if (!sourceColumns || sourceColumns.length === 0) return item;
                    
                    // If extractAsObject is true and multiple columns specified, extract all as an object
                    if (extractAsObject && sourceColumns.length > 1) {
                        const result = {};
                        for (const column of sourceColumns) {
                            if (item && (item[column] !== undefined && item[column] !== null && item[column] !== '')) {
                                result[column] = item[column];
                            } else if (parentItem && (parentItem[column] !== undefined && parentItem[column] !== null && parentItem[column] !== '')) {
                                result[column] = parentItem[column];
                            } else {
                                result[column] = null;
                            }
                        }
                        return result;
                    }
                    
                    // Original behavior: return first non-empty value (fallback chain)
                    for (const column of sourceColumns) {
                        // First check the item itself
                        if (item && item[column] !== undefined && item[column] !== null && item[column] !== '') {
                            return item[column];
                        }
                        // Then check parent item if available
                        if (parentItem && parentItem[column] !== undefined && parentItem[column] !== null && parentItem[column] !== '') {
                            return parentItem[column];
                        }
                    }
                    return null;
                };

                // Helper to detect which arrays contain the requested columns
                const detectRelevantArrays = () => {
                    const relevantConfigs = [];
                    
                    for (const config of this.analysisConfig) {
                        const configResult = {
                            ...config,
                            processMain: false,
                            processNested: [],
                            needsParentContext: false
                        };

                        if (!config.sourceColumns || config.sourceColumns.length === 0) {
                            // No source columns specified, process main array only
                            configResult.processMain = true;
                        } else {
                            // Check if any source columns exist in main data
                            const mainSample = this._data[0];
                            if (mainSample) {
                                const hasMainColumns = config.sourceColumns.some(col => 
                                    mainSample.hasOwnProperty(col) && 
                                    mainSample[col] !== undefined && 
                                    mainSample[col] !== null && 
                                    mainSample[col] !== ''
                                );
                                
                                if (hasMainColumns) {
                                    configResult.processMain = true;
                                }

                                // Check nested arrays for the columns
                                Object.keys(mainSample).forEach(key => {
                                    if (Array.isArray(mainSample[key]) && mainSample[key].length > 0) {
                                        const nestedSample = mainSample[key][0];
                                        const hasNestedColumns = config.sourceColumns.some(col => 
                                            nestedSample.hasOwnProperty(col) && 
                                            nestedSample[col] !== undefined && 
                                            nestedSample[col] !== null && 
                                            nestedSample[col] !== ''
                                        );
                                        
                                        if (hasNestedColumns) {
                                            configResult.processNested.push(key);
                                            
                                            // Check if nested items need parent context
                                            const needsParent = config.sourceColumns.some(col => 
                                                !nestedSample.hasOwnProperty(col) && 
                                                mainSample.hasOwnProperty(col)
                                            );
                                            
                                            if (needsParent) {
                                                configResult.needsParentContext = true;
                                            }
                                        }
                                    }
                                });
                            }
                        }

                        relevantConfigs.push(configResult);
                    }

                    return relevantConfigs;
                };

                const relevantConfigs = detectRelevantArrays();
                
                // Filter configs based on essentialOnly flag
                const configsToRun = essentialOnly
                    ? relevantConfigs.filter(config => config.essential !== false)
                    : relevantConfigs;
                
                if (essentialOnly && configsToRun.length < relevantConfigs.length) {
                    //console.log(`[ReactiveStore] Running ${configsToRun.length} essential analysis steps (skipping ${relevantConfigs.length - configsToRun.length} nonessential)`);
                }
                
                let totalOperations = 0;
                let completedOperations = 0;

                // Calculate total operations for progress tracking
                configsToRun.forEach(config => {
                    if (config.processMain) {
                        totalOperations += this._data.length;
                    }
                    config.processNested.forEach(arrayKey => {
                        this._data.forEach(item => {
                            if (item[arrayKey] && Array.isArray(item[arrayKey])) {
                                totalOperations += item[arrayKey].length;
                            }
                        });
                    });
                });

                // Process main data
                for (const config of configsToRun) {
                    if (!config.processMain) continue;

                    this.analysisMessage = `${config.label || 'Processing'} main data...`;

                    for (let i = 0; i < this._data.length; i += batchSize) {
                        const batch = this._data.slice(i, i + batchSize);
                        
                        // Create batch promises for concurrent execution via priority queue
                        const batchPromises = batch.map(async (item) => {
                            if (!item || typeof item !== 'object') return;
                            if (!item.AppData) item.AppData = {};
                            
                            if (skipIfAnalyzed && item.AppData._analyzed) return;
                            item.AppData._analyzing = true;

                            try {
                                const inputValue = findSourceValue(item, config.sourceColumns, null, config.extractColumnsAsObject);
                                
                                if (inputValue !== null || config.passFullItem) {
                                    // Use full item if passFullItem is true, otherwise use extracted value
                                    const firstParam = config.passFullItem ? item : inputValue;
                                    const apiParams = [firstParam, ...(config.additionalParams || [])];
                                    
                                    // Use priority queue for analysis calls (low priority)
                                    const result = await PriorityQueue.enqueue(
                                        config.apiFunction,
                                        apiParams,
                                        config.priority !== undefined ? config.priority : priorities.analysis,
                                        {
                                            label: config.label || config.resultKey,
                                            type: 'analysis',
                                            resultKey: config.resultKey,
                                            essential: config.essential !== false, // Track if essential
                                            store: 'reactive'
                                        }
                                    );
                                    
                                    storeAnalysisResult(item, config, result);
                                }
                                
                            } catch (error) {
                                console.error(`[ConfiguredAnalysis] Error in ${config.label || config.resultKey}:`, error);
                                storeAnalysisError(item, config, error);
                            }
                            
                            item.AppData._analyzing = false;
                            item.AppData._analyzed = true;
                        });
                        
                        // Wait for entire batch to complete
                        await Promise.all(batchPromises);
                        
                        completedOperations += batch.length;

                        this.analysisProgress = Math.min((completedOperations / totalOperations) * 100, 100);

                        if (delayMs > 0) {
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                        }
                    }
                }

                // Process nested data
                for (const config of configsToRun) {
                    for (const arrayKey of config.processNested) {
                        this.analysisMessage = `${config.label || 'Processing'} ${arrayKey} data...`;

                        for (const parentItem of this._data) {
                            if (!parentItem[arrayKey] || !Array.isArray(parentItem[arrayKey])) continue;

                            const nestedArray = parentItem[arrayKey];
                            
                            for (let i = 0; i < nestedArray.length; i += batchSize) {
                                const batch = nestedArray.slice(i, i + batchSize);
                                
                                // Create batch promises for concurrent execution via priority queue
                                const batchPromises = batch.map(async (nestedItem) => {
                                    if (!nestedItem || typeof nestedItem !== 'object') return;
                                    if (!nestedItem.AppData) nestedItem.AppData = {};
                                    
                                    if (skipIfAnalyzed && nestedItem.AppData._analyzed) return;
                                    nestedItem.AppData._analyzing = true;

                                    try {
                                        // Create enhanced item with parent context if needed
                                        let itemWithContext = nestedItem;
                                        if (config.needsParentContext) {
                                            itemWithContext = { ...parentItem, ...nestedItem };
                                        }

                                        const inputValue = findSourceValue(nestedItem, config.sourceColumns, 
                                            config.needsParentContext ? parentItem : null, config.extractColumnsAsObject);
                                        
                                        if (inputValue !== null || config.passFullItem) {
                                            // Use full item if passFullItem is true, otherwise use extracted value
                                            const firstParam = config.passFullItem ? nestedItem : inputValue;
                                            const apiParams = [firstParam, ...(config.additionalParams || [])];
                                            
                                            // Use priority queue for analysis calls (low priority)
                                            const result = await PriorityQueue.enqueue(
                                                config.apiFunction,
                                                apiParams,
                                                config.priority !== undefined ? config.priority : priorities.analysis,
                                                {
                                                    label: config.label || config.resultKey,
                                                    type: 'analysis',
                                                    resultKey: config.resultKey,
                                                    essential: config.essential !== false, // Track if essential
                                                    nested: arrayKey,
                                                    store: 'reactive'
                                                }
                                            );
                                            
                                            storeAnalysisResult(nestedItem, config, result);
                                        }
                                        
                                    } catch (error) {
                                        console.error(`[ConfiguredAnalysis] Error in ${config.label || config.resultKey}:`, error);
                                        storeAnalysisError(nestedItem, config, error);
                                    }
                                    
                                    nestedItem.AppData._analyzing = false;
                                    nestedItem.AppData._analyzed = true;
                                });
                                
                                // Wait for entire batch to complete
                                await Promise.all(batchPromises);
                                
                                completedOperations += batch.length;

                                this.analysisProgress = Math.min((completedOperations / totalOperations) * 100, 100);

                                if (delayMs > 0) {
                                    await new Promise(resolve => setTimeout(resolve, delayMs));
                                }
                            }
                        }
                    }
                }

                this.analysisProgress = 100;
                this.analysisMessage = 'Analysis complete';

            } catch (error) {
                console.error('[ConfiguredAnalysis] Analysis failed:', error);
                this.analysisMessage = `Analysis failed: ${error.message}`;
            } finally {
                this.isAnalyzing = false;
                if (this._pendingReanalysis) {
                    this._pendingReanalysis = false;
                    Vue.nextTick(() => this.runConfiguredAnalysis({ skipIfAnalyzed: false }));
                }
                setTimeout(() => {
                    this.analysisProgress = 0;
                    this.analysisMessage = '';
                }, 2000);
            }
        },
        async handleInvalidation() {
            // Block during save: the invalidation cascade fires synchronously inside the save's PriorityQueue
            // call (via stampDataChange/setData), so isSaving=true means this is our own write, not an
            // external change. isReloadingMainData=true means a fresh data fetch is already in flight;
            // starting another load would be redundant. Analysis (isAnalyzing=true) is explicitly allowed
            // so external changes are detected even when a large packlist is still being analyzed.
            if (this.isSaving || this.isReloadingMainData) return;
            // needsReload=true means the store was evicted from memory. The store will be reloaded
            // when next accessed via getReactiveStore(). Attempting to reload here would create
            // a second parallel load operation.
            if (this.needsReload) return;
            // While offline, skip background reloads — the network call will fail and the cache is
            // already frozen. Stores with errors are reloaded automatically by reloadErrorStores()
            // when connectivity is restored.
            if (authState.isOffline) return;
            // If unsaved changes exist, don't silently overwrite them — flag the conflict instead.
            // The UI will show a warning banner; reload happens after the user saves or discards.
            if (this.isModified) {
                this.externalConflict = true;
                // CRITICAL: The invalidation cascade already deleted all cache entries and dependency
                // records for this store's chain. Without repopulating the cache here, the poller
                // will find no matching entry on subsequent ticks and silently skip all future
                // external changes until the user resolves the conflict. Re-fetching now re-registers
                // the full dependency chain so the system remains aware of further changes.
                apiCall(...apiArgs).catch(() => {});
                return;
            }
            
            // Preemptive eviction optimization: Before reloading, check if this store's
            // priority score is low enough that it will likely be evicted soon anyway.
            // If so, evict now instead of wasting an API call and CPU on a reload.
            const storeKey = generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig);
            if (shouldPreemptivelyEvict(storeKey, this)) {
                console.log(`[ReactiveStore] Preemptively evicting low-priority store on invalidation: ${storeKey.slice(0, 60)}...`);
                this.evict();
                return;
            }
            
            await this.load('Reloading data due to invalidation...');
        },
        /**
         * Re-applies the most recent autosave backup for this store's key.
         * Called by sheetLockMixin.claimLock() so that claiming a lock on this
         * device also picks up the autosaved work from the previous device.
         * @returns {Promise<boolean>} True if a backup was found and applied, false otherwise.
         */
        async applyLatestBackup() {
            const storeKey = generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig);
            const backupInfo = await loadStoreBackupFromUserData(storeKey);
            if (!backupInfo) return false;
            if (backupInfo.mode === 'diff') {
                const restoredData = applyDiffToData(this._data, backupInfo.diff);
                this.setData(restoredData);
            } else if (backupInfo.mode === 'full') {
                this.setData(backupInfo.data);
            }
            this.loadedBackupKey = backupInfo.key || null;
            this.autoSaved = true;
            return true;
        },
        /**
         * Release this store's data arrays from memory without removing it from the registry.
         * The store remains registered and its cache invalidation listeners stay active.
         * On next access, needsReload=true causes the component to trigger a fresh load.
         *
         * Safe to call only when: !isModified && !isLoading && !isSaving && !isAnalyzing
         * The LRU eviction sweep checks all four guards before calling this.
         */
        evict() {
            this._data.splice(0, this._data.length);
            if (!isReadOnly) this.originalData.splice(0, this.originalData.length);
            this.isAnalyzing = false;
            this.analysisProgress = 0;
            this.analysisMessage = '';
            this.needsReload = true;
        }
    });

    // Helper to strip AppData and analysis target columns from objects (including filtering out items marked for deletion)
    function removeAppData(arr, analysisConfig = null) {
        if (!Array.isArray(arr)) return arr;
        
        const excludedColumns = getExcludedColumns(analysisConfig);
        
        return arr
            .filter(obj => !isMarkedForDeletion(obj))
            .map(obj => {
                if (isValidObject(obj)) {
                    const newObj = { ...obj };
                    
                    // Remove excluded columns
                    excludedColumns.forEach(column => {
                        delete newObj[column];
                    });
                    
                    // Recursively process nested arrays
                    Object.keys(newObj).forEach(key => {
                        if (Array.isArray(newObj[key])) {
                            newObj[key] = removeAppData(newObj[key], analysisConfig);
                        }
                    });
                    return newObj;
                }
                return obj;
            });
    }

    // Helper to initialize all fields in a row with empty strings
    function initializeRowFields(row, fieldNames) {
        if (!row || typeof row !== 'object' || !Array.isArray(fieldNames)) return row;
        fieldNames.forEach(field => {
            if (!(field in row)) row[field] = '';
        });
        return row;
    }

    return store;
}

// Central registry for reactive stores, keyed by apiCall.toString() + JSON.stringify(apiArgs)
const reactiveStoreRegistry = Vue.reactive({});

// LRU metadata for each registered store: creation time, lastAccess timestamp, and access count.
// Stored separately so it doesn't pollute the reactive store objects.
// Score is calculated as: (accessCount / ageInMinutes) × exp(-timeSinceLastAccess / recencyGuard)
const storeMetaRegistry = {};

// Maximum number of simultaneously populated stores.
// Stores exceeding this cap (sorted by lowest score) are evicted after a debounce.
// Also used for preemptive eviction: when at 80% capacity, invalidated stores in the
// bottom 30% by score are evicted instead of reloaded (saves API calls).
const MAX_POPULATED_STORES = 15;

// Recency guard: stores accessed within this window will not be evicted
const RECENCY_GUARD_MS = 5 * 60 * 1000; // 5 minutes

let _lruEvictDebounceTimer = null;

/**
 * Calculate priority score for a store based on recency and access frequency.
 * Higher score = more valuable = less likely to evict.
 * 
 * @param {string} key - Store key in the registry
 * @returns {number} Priority score (0 if metadata not found)
 */
function calculateStoreScore(key) {
    const meta = storeMetaRegistry[key];
    if (!meta) return 0;
    
    const now = Date.now();
    const timeSinceLastAccessMs = now - meta.lastAccess;
    const timeSinceLastAccessMin = timeSinceLastAccessMs / 60000;
    
    // Exponential decay: stores accessed recently get higher scores
    const recencyFactor = Math.exp(-timeSinceLastAccessMin / (RECENCY_GUARD_MS / 1000));
    
    // Frequency: accesses per minute
    const frequency = meta.accessCount / Math.max((timeSinceLastAccessMin + 0.1), 0.1);
    
    // Combined score
    return frequency * recencyFactor;
}

/**
 * Check if a store should be preemptively evicted instead of reloaded on invalidation.
 * Compares the store's score against other populated stores.
 * 
 * Strategy: If this store's score is in the bottom 30% of all active stores,
 * evict it instead of reloading. This saves API calls and CPU for data that
 * will likely be evicted soon anyway.
 * 
 * @param {string} key - Store key in the registry
 * @param {Object} store - The reactive store object
 * @returns {boolean} True if store should be evicted instead of reloaded
 */
function shouldPreemptivelyEvict(key, store) {
    // Never preemptively evict core stores or stores with unsaved changes
    if (store.exemptFromEviction || store.isModified) {
        return false;
    }

    // Same recency guard as the LRU sweep: a store fetched recently is in use
    if (Date.now() - (storeMetaRegistry[key]?.lastAccess || 0) < RECENCY_GUARD_MS) {
        return false;
    }
    
    // Get all populated stores and their scores
    const allKeys = Object.keys(reactiveStoreRegistry);
    const populated = allKeys.filter(k => {
        const s = reactiveStoreRegistry[k];
        return s && s._data && s._data.length > 0;
    });
    
    // If we're not near the limit, don't preemptively evict
    if (populated.length < MAX_POPULATED_STORES * 0.8) {
        return false;
    }
    
    // Calculate scores for all populated stores
    const scores = populated.map(k => calculateStoreScore(k)).filter(score => score > 0);
    if (scores.length === 0) return false;
    
    // Sort scores to find the 30th percentile threshold
    scores.sort((a, b) => a - b);
    const threshold = scores[Math.floor(scores.length * 0.3)];
    
    // Calculate this store's score
    const thisScore = calculateStoreScore(key);
    
    // If this store's score is below the 30th percentile, evict it
    return thisScore <= threshold;
}

/**
 * Debounced LRU sweep: called after every new store access that could push the total
 * populated count over MAX_POPULATED_STORES. Finds eviction candidates (lowest access frequency,
 * not recently accessed, not modified/loading/saving/analyzing) and evicts until count is within the threshold.
 * 
 * Access frequency is calculated as: accessCount / ageInMinutes
 * Higher frequency = more active store = kept longer
 */
function scheduleLruEviction() {
    if (_lruEvictDebounceTimer) return;
    _lruEvictDebounceTimer = setTimeout(() => {
        _lruEvictDebounceTimer = null;
        const allKeys = Object.keys(reactiveStoreRegistry);
        const populated = allKeys.filter(k => {
            const s = reactiveStoreRegistry[k];
            return s && s._data && s._data.length > 0;
        });
        if (populated.length <= MAX_POPULATED_STORES) return;

        const now = Date.now();
        
        // Calculate recency-weighted frequency for each store and sort by lowest score first
        const storesWithFrequency = populated.map(key => {
            const score = calculateStoreScore(key);
            const meta = storeMetaRegistry[key];
            return { 
                key, 
                score, 
                lastAccess: meta?.lastAccess || 0, 
                accessCount: meta?.accessCount || 0 
            };
        });
        
        // Sort by score ascending (lowest score = least active = evict first)
        storesWithFrequency.sort((a, b) => a.score - b.score);

        let evictCount = populated.length - MAX_POPULATED_STORES;
        for (const { key, score, lastAccess, accessCount } of storesWithFrequency) {
            if (evictCount <= 0) break;
            const s = reactiveStoreRegistry[key];
            if (!s) continue;
            
            // Safety guards:
            // 1. Never evict stores marked as exempt (core stores like dashboard userData)
            // 2. Never evict stores with unsaved work or active operations
            // 3. Never evict stores accessed within the recency guard window (60 seconds)
            const timeSinceAccess = now - lastAccess;
            if (s.exemptFromEviction || s.isModified || s.isLoading || s.isSaving || s.isAnalyzing || timeSinceAccess < RECENCY_GUARD_MS) {
                continue;
            }
            
            s.evict();
            //console.log(`[ReactiveStore] Evicted store (score: ${score.toFixed(4)}, ${accessCount} accesses, last: ${(timeSinceAccess / 1000).toFixed(0)}s ago, key: ${key.slice(0, 40)}...)`);
            evictCount--;
        }
        
        // if (evictCount > 0) {
        //     console.warn(`[ReactiveStore] Could not evict enough stores (${evictCount} remaining) - all candidates are either active or recently accessed`);
        // }
    }, 5000); // 5-second debounce to let navigation bursts settle
}

// Auto-save timer for dirty stores
let autoSaveInterval = null;
const AUTO_SAVE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Calculate diff between original and current data recursively
 * Only stores row indices with their changed fields for efficiency
 * Handles nested arrays recursively
 * Excludes AppData and analysis target columns
 * @param {Array} originalData - Original data
 * @param {Array} currentData - Current modified data
 * @param {Array} analysisConfig - Analysis configuration to identify columns to exclude
 * @returns {Array} Array of changes with indices and modified fields
 */
function calculateStoreDiff(originalData, currentData, analysisConfig = null) {
    if (!Array.isArray(originalData) || !Array.isArray(currentData)) {
        return null;
    }
    
    const excludedColumns = getExcludedColumns(analysisConfig);
    const changes = [];
    
    currentData.forEach((item, index) => {
        if (!isValidObject(item)) return;
        
        const original = originalData[index];
        if (!isValidObject(original)) {
            // New item added - recursively process nested arrays
            const cleanData = {};
            Object.keys(item).forEach(key => {
                if (shouldExcludeColumn(key, excludedColumns)) return;
                
                if (Array.isArray(item[key])) {
                    // For nested arrays, calculate diff recursively
                    const nestedDiff = calculateStoreDiff([], item[key], analysisConfig);
                    if (nestedDiff) {
                        cleanData[key] = { _nestedDiff: nestedDiff };
                    }
                } else {
                    cleanData[key] = item[key];
                }
            });
            changes.push({
                index,
                type: 'added',
                data: cleanData
            });
            return;
        }
        
        // Check for modified fields recursively
        const modifiedFields = {};
        Object.keys(item).forEach(key => {
            if (shouldExcludeColumn(key, excludedColumns)) return;
            
            if (Array.isArray(item[key]) && Array.isArray(original[key])) {
                // For nested arrays, calculate diff recursively
                const nestedDiff = calculateStoreDiff(original[key], item[key], analysisConfig);
                if (nestedDiff) {
                    modifiedFields[key] = { _nestedDiff: nestedDiff };
                }
            } else if (!areValuesEqual(item[key], original[key])) {
                modifiedFields[key] = item[key];
            }
        });
        
        if (Object.keys(modifiedFields).length > 0) {
            changes.push({
                index,
                type: 'modified',
                data: modifiedFields
            });
        }
    });
    
    // Check for deleted items
    if (originalData.length > currentData.length) {
        for (let i = currentData.length; i < originalData.length; i++) {
            changes.push({
                index: i,
                type: 'deleted'
            });
        }
    }
    
    return changes.length > 0 ? changes : null;
}




/**
 * Save dirty stores to user data
 * Each store is saved as a separate user data entry with the storeKey as ID and diff as Value
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipAuthCheck - If true, skip auth check (used during logout)
 */
export async function saveDirtyStoresToUserData(options = {}) {
    const { skipAuthCheck = false } = options;
    
    // If called during logout, skip auth checks entirely
    if (skipAuthCheck) {
        //console.log('[ReactiveStore AutoSave] Skipping auth check (logout in progress)');
        if (!authState.user?.email) {
            //console.log('[ReactiveStore AutoSave] No user email available, skipping auto-save');
            return;
        }
    } else {
        // While offline, skip auto-save — the API call will fail and user data is preserved in memory.
        if (authState.isOffline) {
            //console.log('[ReactiveStore AutoSave] Network offline, skipping auto-save');
            return;
        }

        // Normal auto-save flow - check auth silently; proactive refresh handles renewal
        // before expiry. If expired, skip this cycle without prompting — the user will
        // be prompted on their next explicit action (save, navigation, etc.).
        const isAuthenticated = await Auth.checkAuth();
        
        if (!isAuthenticated) {
            //console.log('[ReactiveStore AutoSave] Auth check failed, skipping auto-save');
            return;
        }
        
        if (!authState.user?.email) {
            //console.log('[ReactiveStore AutoSave] No user email available, skipping auto-save');
            return;
        }
    }
    
    try {
        let savedCount = 0;
        let cleanedCount = 0;
        let skippedCount = 0;
        
        // Save each dirty store as a separate user data entry. The writes start together, so
        // storeUserData writes them all in one batch (one read and one write of the user tab).
        const writes = [];
        for (const [key, store] of Object.entries(reactiveStoreRegistry)) {
            const isModified = store.isModified;
            const diff = calculateStoreDiff(store.originalData, store._data, store.analysisConfig);
            
            if (isModified && store.originalData && store._data && diff) {
                // Calculate hash of current diff to check if already saved
                const currentHash = JSON.stringify(diff);
                
                // Only save if this exact state hasn't been auto-saved already
                if (store.lastAutoSaveHash !== currentHash) {
                    // Store has changes - save the diff
                    writes.push(Requests.storeUserData(
                        { diff, timestamp: new Date().toISOString() },
                        authState.user.email,
                        key // Use the store key as the unique ID
                    ).then(() => {
                        store.autoSaved = true;
                        store.lastAutoSaveHash = currentHash; // Record this state as saved
                    }));
                    savedCount++;
                } else {
                    skippedCount++;
                }
            } else if (!diff && store.autoSaved) {
                // Store is clean but was previously auto-saved - clean up the entry
                writes.push(Requests.storeUserData(
                    null, // Setting to null will delete the entry
                    authState.user.email,
                    key
                ).then(() => {
                    store.autoSaved = false;
                }));
                cleanedCount++;
            }
        }
        await Promise.all(writes);
        
        // if (savedCount > 0) {
        //     console.log(`[ReactiveStore AutoSave] Successfully saved ${savedCount} dirty store(s) to user data`);
        // }
        // if (cleanedCount > 0) {
        //     console.log(`[ReactiveStore AutoSave] Cleaned up ${cleanedCount} resolved auto-save entries`);
        // }
        // if (skippedCount > 0) {
        //     console.log(`[ReactiveStore AutoSave] Skipped ${skippedCount} store(s) - already auto-saved in current state`);
        // }
        // if (savedCount === 0 && cleanedCount === 0 && skippedCount === 0) {
        //     console.log('[ReactiveStore AutoSave] No changes to save or clean up');
        // }
    } catch (error) {
        console.error('[ReactiveStore AutoSave] Failed to save dirty stores:', error);
    }
}

/**
 * Start auto-save timer
 */
function startAutoSaveTimer() {
    if (autoSaveInterval) {
        return; // Already running
    }
    
    //console.log('[ReactiveStore AutoSave] Starting auto-save timer');
    autoSaveInterval = setInterval(() => {
        const storeCount = Object.keys(reactiveStoreRegistry).length;
        if (storeCount > 0) {
            saveDirtyStoresToUserData();
        } else {
            //console.log('[ReactiveStore AutoSave] No stores in registry, skipping auto-save');
        }
    }, AUTO_SAVE_INTERVAL_MS);
}

/**
 * Stop auto-save timer
 */
function stopAutoSaveTimer() {
    if (autoSaveInterval) {
        //console.log('[ReactiveStore AutoSave] Stopping auto-save timer');
        clearInterval(autoSaveInterval);
        autoSaveInterval = null;
    }
}

/**
 * Apply saved diff from user data to store data recursively
 * @param {Array} data - Store data to apply changes to
 * @param {Array} diff - Array of changes to apply
 * @returns {Array} Modified data
 */
function applyDiffToData(data, diff) {
    if (!Array.isArray(data) || !Array.isArray(diff)) {
        return data;
    }
    
    const result = [...data];
    
    diff.forEach(change => {
        if (change.type === 'modified' && change.index < result.length) {
            // Apply modified fields, handling nested diffs
            const updatedItem = { ...result[change.index] };
            
            Object.keys(change.data).forEach(key => {
                const value = change.data[key];
                
                // Check if this is a nested diff
                if (value && typeof value === 'object' && value._nestedDiff) {
                    // Recursively apply nested diff
                    const currentNestedData = updatedItem[key] || [];
                    updatedItem[key] = applyDiffToData(currentNestedData, value._nestedDiff);
                } else {
                    updatedItem[key] = value;
                }
            });
            
            result[change.index] = updatedItem;
        } else if (change.type === 'added') {
            // Add new item if not already present, handling nested diffs
            if (change.index >= result.length) {
                const newItem = { ...change.data };
                
                // Process any nested diffs in the added item
                Object.keys(newItem).forEach(key => {
                    const value = newItem[key];
                    if (value && typeof value === 'object' && value._nestedDiff) {
                        // Recursively apply nested diff
                        newItem[key] = applyDiffToData([], value._nestedDiff);
                    }
                });
                
                result.push(newItem);
            }
        }
        // Note: We don't apply 'deleted' changes on restore to avoid data loss
    });
    
    return result;
}

/**
 * Normalize possible backup payload shapes from different autosave versions.
 * @param {*} backupData - Parsed user data payload
 * @returns {{mode: 'diff', diff: Array}|{mode: 'full', data: Array}|null}
 */
function normalizeBackupPayload(backupData) {
    if (!backupData) {
        return null;
    }

    // Current format: { diff: [...], timestamp }
    if (Array.isArray(backupData.diff)) {
        return { mode: 'diff', diff: renameLegacyRowKeys(backupData.diff) };
    }

    // Legacy format: direct diff array
    if (Array.isArray(backupData)) {
        return { mode: 'diff', diff: renameLegacyRowKeys(backupData) };
    }

    // Legacy alias occasionally used in prototypes.
    if (Array.isArray(backupData.changes)) {
        return { mode: 'diff', diff: renameLegacyRowKeys(backupData.changes) };
    }

    // Legacy snapshot format: full data captured directly.
    if (Array.isArray(backupData.data)) {
        return { mode: 'full', data: renameLegacyRowKeys(backupData.data) };
    }

    return null;
}

// Row keys renamed to lowercase; backups saved before the rename still use the old names
const LEGACY_ROW_KEYS = { MetaData: 'metadata', EditHistory: 'edithistory' };

/**
 * Recursively rename legacy row keys in a backup payload.
 * @param {*} value - Backup payload (arrays/objects are copied, other values returned as-is)
 * @returns {*}
 */
function renameLegacyRowKeys(value) {
    if (Array.isArray(value)) return value.map(renameLegacyRowKeys);
    if (!value || typeof value !== 'object') return value;
    const renamed = {};
    for (const [key, child] of Object.entries(value)) {
        renamed[LEGACY_ROW_KEYS[key] || key] = renameLegacyRowKeys(child);
    }
    return renamed;
}

/**
 * Load saved store data from user data
 * @param {string} storeKey - Store registry key (used as the user data ID)
 * @returns {{mode: 'diff', diff: Array, key: string|null}|{mode: 'full', data: Array, key: string|null}|null}
 */
async function loadStoreBackupFromUserData(storeKey) {
    if (!authState.isAuthenticated || !authState.user?.email) {
        return null;
    }
    
    try {
        // Retrieve using the storeKey as the ID
        const backupData = await Requests.getUserData(authState.user.email, storeKey);
        const normalizedExact = normalizeBackupPayload(backupData);
        if (normalizedExact) {
            //console.log('[ReactiveStore] Found backup for store (exact key match)');
            return {
                ...normalizedExact,
                key: storeKey
            };
        }

        // Fallback: match by key prefix to support analysis-config key drift.
        const keySeparatorIndex = storeKey.lastIndexOf(':');
        if (keySeparatorIndex > 0) {
            const keyPrefix = storeKey.substring(0, keySeparatorIndex);
            const prefixBackupData = await Requests.getUserDataByPrefix(authState.user.email, keyPrefix);
            const normalizedPrefix = normalizeBackupPayload(prefixBackupData?.value);
            if (normalizedPrefix) {
                //console.log('[ReactiveStore] Found backup by store key prefix fallback');
                return {
                    ...normalizedPrefix,
                    key: prefixBackupData?.id || null
                };
            }
        }
    } catch (error) {
        console.warn('[ReactiveStore] Failed to load backup from user data:', error);
    }
    
    return null;
}

/**
 * Remove store backup from user data
 * @param {string} storeKey - Store registry key (used as the user data ID)
 */
async function removeStoreBackupFromUserData(storeKey) {
    if (!authState.isAuthenticated || !authState.user?.email) {
        return;
    }
    
    try {
        // Store null to effectively delete the backup entry
        await Requests.storeUserData(null, authState.user.email, storeKey);
        //console.log(`[ReactiveStore] Removed backup for store after save`);
    } catch (error) {
        console.warn('[ReactiveStore] Failed to remove backup from user data:', error);
    }
}

/**
 * Find stores that match the given criteria (partial matching)
 * Useful for finding stores when you don't know the exact analysis config
 * @param {Function} apiCall - The API function used to create the store
 * @param {Array} apiArgs - Arguments passed to the API function
 * @returns {Array} Array of matching store objects with { key, store, isModified }
 */
export function findMatchingStores(apiCall, apiArgs = []) {
    if (!apiCall) return [];
    
    const apiCallIdentifier = getMethodIdentifier(apiCall);
    const apiArgsStr = JSON.stringify(apiArgs);
    const matches = [];
    
    // Search through all registered stores
    for (const [key, store] of Object.entries(reactiveStoreRegistry)) {
        // Check if the key starts with the apiCall identifier and contains the apiArgs
        if (key.startsWith(apiCallIdentifier + ':') && key.includes(apiArgsStr)) {
            matches.push({
                key,
                store,
                isModified: store.isModified || false
            });
        }
    }
    
    return matches;
}

/**
 * Helper to extract method name from API function
 * @param {Function} apiFunction - The API function
 * @returns {string|null} - Method name or null
 */
function extractMethodName(apiFunction) {
    if (!apiFunction) return null;
    
    // Check if the function has _methodName property (set by wrapMethods)
    if (apiFunction._methodName) {
        return apiFunction._methodName;
    }
    
    const funcStr = apiFunction.toString();
    // For arrow functions that call Requests.methodName, extract the method name
    // Matches patterns like: Requests.methodName( or Requests.methodName.call(
    const requestsMatch = funcStr.match(/Requests\.(\w+)(?:\(|\.call\()/);
    if (requestsMatch) {
        return requestsMatch[1];
    }
    
    // Try to extract method name from function
    const match = funcStr.match(/function\s+(\w+)|^(\w+)\s*\(/);
    if (match) {
        return match[1] || match[2];
    }
    
    // For arrow functions, check the name property
    if (apiFunction.name) {
        return apiFunction.name;
    }
    
    console.warn(`[extractMethodName] Could not extract name from function`, funcStr.substring(0, 100));
    return null;
}

/**
 * Returns a reactive store instance for the given apiCall and apiArgs.
 * If a store for the same apiCall/apiArgs exists, returns it.
 * Otherwise, creates a new store and registers it.
 * @param {Function} apiCall - The API function to use for loading data
 * @param {Function} saveCall - The API function to use for saving data
 * @param {Array} apiArgs - Arguments to pass to the API function
 * @param {Array} analysisConfig - Optional analysis configuration array
 * @param {boolean} autoLoad - Whether to automatically load data on first creation (default: true)
 * @param {Object} priorityConfig - Optional priority configuration for load/save/analysis
 * @param {boolean} exemptFromEviction - If true, this store will never be evicted (use for critical stores like dashboard)
 * @returns {Object} The reactive store instance
 */
export function getReactiveStore(apiCall, saveCall = null, apiArgs = [], analysisConfig = null, autoLoad = true, priorityConfig = null, exemptFromEviction = false) {
    const key = generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig);
    
    if (!reactiveStoreRegistry[key]) {
        const store = createReactiveStore(apiCall, saveCall, apiArgs, analysisConfig, priorityConfig, exemptFromEviction);
        reactiveStoreRegistry[key] = store;
        const now = Date.now();
        storeMetaRegistry[key] = { createdAt: now, lastAccess: now, accessCount: 1 };

        const totalStores = Object.keys(reactiveStoreRegistry).length;
        // console.log(`[ReactiveStore] New store created (${totalStores} total registered): ${key.substring(0, 80)}${key.length > 80 ? '...' : ''}`);
        scheduleLruEviction();
        
        // Mark as initial load and set loading state
        store.initialLoad = true;
        store.setLoading(true, 'Initializing...');
        
        // Setup cache invalidation subscriptions
        setupCacheInvalidationListeners(store, apiCall, apiArgs, analysisConfig);
        
        // Start auto-save timer if not already running
        startAutoSaveTimer();
        
        if (autoLoad) {
            // Perform async initialization without blocking store return
            (async () => {
                try {
                    store.setLoading(true, 'Checking for saved changes...');
                    
                    // Check for backup first
                    const backupInfo = await loadStoreBackupFromUserData(key);
                    const hasBackup = !!backupInfo;
                    
                    if (hasBackup) {
                        store.setLoading(true, 'Restoring saved changes...');
                    }
                    
                    // Load data - skip initial analysis if we have a backup to apply
                    store.setLoading(true, 'Loading data...');
                    await store.load('Loading data...', hasBackup);
                    
                    // Apply backup after load if found
                    if (hasBackup && store._data) {
                        //console.log('[ReactiveStore] Applying backup to store data');
                        if (backupInfo.mode === 'diff') {
                            const restoredData = applyDiffToData(store._data, backupInfo.diff);
                            store.setData(restoredData);
                        } else if (backupInfo.mode === 'full') {
                            store.setData(backupInfo.data);
                        }
                        store.loadedBackupKey = backupInfo.key || null;
                        store.autoSaved = true; // Mark that this store was loaded from auto-save
                        // setData will trigger analysis automatically if configured
                    }
                    
                    store.initialLoad = false;
                } catch (err) {
                    console.warn('[ReactiveStore] Initial load failed:', err);
                    store.setError(err);
                    store.setLoading(false);
                    store.initialLoad = false;
                    // Store will have empty arrays initialized, allowing dynamic property addition
                }
            })();
        } else {
            // Initialize with empty arrays to allow dynamic property addition
            // setOriginalData is a no-op for read-only stores (saveCall === null), but check via store.isModified
            // since isReadOnly is a closure var inside createReactiveStore — use saveCall presence here instead.
            if (typeof saveCall === 'function') store.setOriginalData([]);
            store.setData([]);
            store.setLoading(false);
            store.initialLoad = false;
        }
    }

    // Handle evicted stores that need reloading
    const existingStore = reactiveStoreRegistry[key];
    if (existingStore && existingStore.needsReload && !existingStore.isLoading) {
        // console.log(`[ReactiveStore] Re-accessing evicted store, triggering reload: ${key.substring(0, 80)}${key.length > 80 ? '...' : ''}`);
        // Trigger async reload without blocking return
        // After reload completes, check eviction again in case the reload didn't trigger cache invalidation
        // (e.g., cache was still fresh within 8-min TTL). Without this, stores can accumulate indefinitely.
        existingStore.load('Reloading evicted store...')
            .then(() => scheduleLruEviction())
            .catch(err => {
                console.warn('[ReactiveStore] Failed to reload evicted store:', err);
                scheduleLruEviction(); // Check eviction even on reload failure
            });
    }
    
    // Update LRU metadata on every access (new store creation handled above; this covers re-access)
    if (storeMetaRegistry[key]) {
        storeMetaRegistry[key].lastAccess = Date.now();
        storeMetaRegistry[key].accessCount++;
    }
    
    // Check eviction on every getReactiveStore access (debounced to 2 seconds)
    // This prevents store accumulation even when reloads don't trigger cache invalidation
    scheduleLruEviction();

    return existingStore;
}

/**
 * Setup cache invalidation listeners for a reactive store.
 *
 * ═══════════════════════════════════════════════════════════════
 * HOW THIS CONNECTS TO THE INVALIDATION CHAIN
 *
 * The CacheInvalidationBus emits events only for 'api:*' namespace keys
 * (see CacheManager.invalidate). This function subscribes to the pattern
 * matching the store's load function (e.g. 'api:getInventoryTabData').
 *
 * ARGS MATCHING CONTRACT:
 *   storeArgs = JSON.stringify(apiArgs).replace(/^\[|\]$/g, '')
 *   This must equal the argsString embedded in the cache key that was
 *   invalidated. The cache key is generated from the exact arguments
 *   passed when the store called apiCall — which is apiArgs spread with
 *   no extras. Any default parameters added INSIDE the api function are
 *   not part of the outer key, so they do not affect this comparison.
 *
 * LISTENER LIFECYCLE:
 *   Listeners are registered once when the store is first created and
 *   are never removed. They remain active for the lifetime of the page.
 *   A new store with the same key reuses the existing store instance
 *   (see getReactiveStore) so listeners are not duplicated.
 * ═══════════════════════════════════════════════════════════════
 */
function setupCacheInvalidationListeners(store, apiCall, apiArgs, analysisConfig) {
    // Subscribe to main API call invalidations (triggers full reload)
    const mainMethodName = extractMethodName(apiCall);
    if (mainMethodName) {
        const mainPattern = `api:${mainMethodName}`;
        const storeArgs = JSON.stringify(apiArgs).replace(/^\[|\]$/g, '');
        
        CacheInvalidationBus.on(mainPattern, (eventData) => {
            // Check if arguments match
            const cachedArgs = eventData.argsString;
            
            if (cachedArgs === storeArgs) {
                store.handleInvalidation();
            }
        });
    }
    
    // Subscribe to analysis function invalidations (triggers re-analysis only)
    // A shared debounce timer coalesces rapid bursts of analysis invalidations into a
    // single clear + re-run, preventing UI flickering from chain-reaction invalidations.
    if (analysisConfig && Array.isArray(analysisConfig)) {
        let analysisDebounceTimer = null;
        const pendingInvalidatedKeys = new Set();

        const flushAnalysisInvalidations = () => {
            analysisDebounceTimer = null;

            // If main data is reloading, analysis will run automatically after load completes
            if (store.isReloadingMainData) {
                pendingInvalidatedKeys.clear();
                return;
            }

            const keysToInvalidate = [...pendingInvalidatedKeys];
            pendingInvalidatedKeys.clear();

            // Clear all accumulated results in one pass, then run analysis once
            store.clearSpecificAnalysisResults(keysToInvalidate);
            if (store.isAnalyzing) {
                // Analysis is mid-flight; flag a re-run for when it finishes
                store._pendingReanalysis = true;
            } else {
                store.runConfiguredAnalysis({ skipIfAnalyzed: false });
            }
        };

        analysisConfig.forEach((config) => {
            const analysisMethodName = extractMethodName(config.apiFunction);
            if (analysisMethodName) {
                const analysisPattern = `api:${analysisMethodName}`;

                CacheInvalidationBus.on(analysisPattern, () => {
                    pendingInvalidatedKeys.add(config.resultKey || config.targetColumn);

                    // Reset the debounce window on every new invalidation so that a burst
                    // of invalidations only triggers one re-analysis at the end of the burst.
                    // 150ms is long enough to absorb cascade chains but short enough to feel responsive.
                    if (analysisDebounceTimer) clearTimeout(analysisDebounceTimer);
                    analysisDebounceTimer = setTimeout(flushAnalysisInvalidations, 150);
                });
            }
        });
    }
}

/**
 * Helper to create a new analysis configuration entry
 * @param {Function} apiFunction - The API function to call
 * @param {string} resultKey - Key to store the result in AppData OR column name if targetColumn is specified
 * @param {string} label - UI label for the analysis step
 * @param {string|Array<string>} sourceColumns - Column(s) to extract value from (ordered array for priority)
 * @param {Array} additionalParams - Additional parameters to pass to API function
 * @param {string} targetColumn - Optional: column name to store results directly in data (not AppData)
 * @param {boolean} passFullItem - If true, pass entire item as first param instead of extracted value
 * @param {number} priority - Priority level (0-9, default: Priority.ANALYSIS=1)
 * @param {boolean} extractColumnsAsObject - If true and sourceColumns has multiple items, extract all as {col1, col2, ...} object
 * @param {boolean} essential - If true (default), this analysis is essential and runs even when onlyRunEssentialAnalysis is enabled
 * @returns {Object} Analysis configuration object. Set `keepWhileRefreshing: true` on it to keep the
 *   last result until a re-run replaces it (reloads carry it to rows with the same sourceColumns values).
 */
export function createAnalysisConfig(apiFunction, resultKey, label, sourceColumns = null, additionalParams = [], targetColumn = null, passFullItem = false, priority = Priority.ANALYSIS, extractColumnsAsObject = false, essential = true) {
    return {
        apiFunction,
        resultKey,
        label,
        sourceColumns: Array.isArray(sourceColumns) ? sourceColumns : (sourceColumns ? [sourceColumns] : []),
        additionalParams,
        targetColumn, // If set, results go to this column instead of AppData
        passFullItem, // If true, pass entire item even when sourceColumns specified
        extractColumnsAsObject, // If true, extract multiple sourceColumns into {col1, col2, ...} object
        priority, // Priority level for queue processing
        essential // If true, runs even when onlyRunEssentialAnalysis is enabled
    };
}

/**
 * Clear all reactive stores from the registry
 * Useful for logout or when switching users
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipSave - If true, skip auto-save during cleanup (used during logout)
 */
/**
 * Reload all stores in the registry that are in an error state.
 * Called after successful re-authentication so stores cleared by a failed load
 * during token expiry will recover automatically.
 */
export function reloadErrorStores() {
    const storesToReload = Object.values(reactiveStoreRegistry).filter(
        store => (store.error || store.needsReload) && !store.isLoading && !store.isSaving
    );
    storesToReload.forEach(store => {
        // Clear the flag before calling handleInvalidation — the flag guard in that method
        // exists to block bus-driven invalidations during logout, not intentional reloads.
        store.needsReload = false;
        store.handleInvalidation();
    });
    // Restart auto-save timer if any stores are reloading (it was stopped during logout)
    if (storesToReload.length > 0) {
        startAutoSaveTimer();
    }
}

/**
 * Trigger analysis on all stores that have nonessential analysis configured
 * Used when enabling full analysis mode (onlyRunEssentialAnalysis: false -> true)
 */
export function getPreferencesStore() {
    return getReactiveStore(
        Requests.getPreferences,
        Requests.savePreferences,
        []
    );
}

/**
 * Maximum inventory save note length (InventoryNoteMaxLength preference, default 25 until loaded).
 * Reactive: computed properties that call it update when the preference changes.
 * @returns {number}
 */
export function getInventoryNoteMaxLength() {
    return resolveInventoryNoteMaxLength(getPreferencesStore().data);
}

/**
 * Tab names an inventory tab preference lists (INVENTORY_TAB_PREFERENCES; empty until loaded).
 * Reactive: computed properties that call it update when the preference changes.
 * @param {string} preferenceId
 * @returns {string[]}
 */
export function getInventoryTabList(preferenceId) {
    return resolveInventoryTabList(getPreferencesStore().data, preferenceId);
}

export function runNonessentialAnalysisOnAllStores() {
    let triggeredCount = 0;
    Object.values(reactiveStoreRegistry).forEach(store => {
        if (!store.analysisConfig) return;
        
        // Check if this store has any nonessential analysis
        const hasNonessential = store.analysisConfig.some(config => config.essential === false);
        if (hasNonessential && store._data && store._data.length > 0 && !store.isAnalyzing) {
            // Trigger analysis with essentialOnly=false to run all analysis
            store.runConfiguredAnalysis({ essentialOnly: false });
            triggeredCount++;
        }
    });
    
    if (triggeredCount > 0) {
        //console.log(`[ReactiveStore] Triggered nonessential analysis on ${triggeredCount} store(s)`);
    }
}

/**
 * Clear all reactive stores and mark them for reload.
 * 
 * NOTE: This function is NO LONGER used for logout. Logout now performs a page refresh
 * (window.location.reload()) which is simpler and more reliable. Components hold direct
 * references to store objects, so deleting registry entries leaves orphaned stores that
 * never get recreated properly.
 * 
 * This function remains available for testing/debugging purposes.
 * 
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipSave - If true, skip saving dirty stores before clearing
 */
export async function clearAllReactiveStores(options = {}) {
    const { skipSave = false } = options;
    
    //console.log('[ReactiveStore] Starting cleanup of all stores');
    
    // Get count before clearing
    const storeCount = Object.keys(reactiveStoreRegistry).length;
    
    // Step 1: Immediately stop and clear all tasks in the Priority queue
    //console.log('[ReactiveStore] Step 1: Stopping and clearing Priority Queue');
    PriorityQueue.stopProcessing();
    PriorityQueue.clearAll();
    
    // Step 2: Stop the autosave timer
    //console.log('[ReactiveStore] Step 2: Stopping auto-save timer');
    stopAutoSaveTimer();
    
    // Step 3: Optionally save dirty stores (skip during logout since we save separately)
    if (!skipSave) {
        //console.log('[ReactiveStore] Step 3: Saving dirty stores');
        await saveDirtyStoresToUserData({ skipAuthCheck: true });
    } else {
        //console.log('[ReactiveStore] Step 3: Skipping save (skipSave=true)');
    }
    
    // Step 4: Reset all stores in place and mark them for reload, keeping them in the registry.
    // Components hold direct object references to these stores; deleting registry entries makes
    // those references stale and prevents reloadErrorStores() from reloading them after re-login.
    Object.values(reactiveStoreRegistry).forEach(store => {
        store._data.splice(0, store._data.length);
        store.originalData.splice(0, store.originalData.length);
        store.isLoading = false;
        store.loadingMessage = '';
        store.error = null;
        store.isAnalyzing = false;
        store.isReloadingMainData = false;
        store.isSaving = false;
        store.externalConflict = false;
        store.lockConflictOwner = null;
        store.analysisProgress = -1;
        store.analysisMessage = '';
        store.autoSaved = false;
        store.lastAutoSaveHash = null;
        store.loadedBackupKey = null;
        store.needsReload = true;
    });

    // Step 5: Delete all store entries from the registry
    // This ensures a clean slate on logout. When stores are re-accessed after login,
    // getReactiveStore() will create fresh entries with needsReload properly handled.
    for (const key of Object.keys(reactiveStoreRegistry)) {
        delete reactiveStoreRegistry[key];
        delete storeMetaRegistry[key];
    }

    //console.log(`[ReactiveStore] Cleanup complete - deleted ${storeCount} store(s) from registry`);
}

