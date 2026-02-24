import { CacheInvalidationBus, Requests, authState, Auth } from '../index.js';
import { PriorityQueue, Priority } from './priorityQueue.js';

// Re-export Priority for component use
export { Priority };

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
 */

/**
 * Generate a clean identifier for a function, using cache edithistory when available
 * @param {Function} fn - The function to identify
 * @returns {string} A clean identifier string
 */
function getMethodIdentifier(fn) {
    if (!fn) return '';
    // If function has cache wrapper edithistory, use it for a clean identifier
    if (fn._namespace && fn._methodName) {
        return `${fn._namespace}.${fn._methodName}`;
    }
    // Otherwise fall back to toString (for unwrapped functions)
    return fn.toString();
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
    return getMethodIdentifier(apiCall) + ':' + getMethodIdentifier(saveCall) + ':' + JSON.stringify(apiArgs) + ':' + JSON.stringify(analysisConfig);
}

/**
 * Build a set of columns that should be excluded from comparisons and saves
 * @param {Array} analysisConfig - Analysis configuration
 * @returns {Set} Set of column names to exclude
 */
function getExcludedColumns(analysisConfig = null) {
    const excludedColumns = new Set(['AppData']); // EditHistory should persist, only AppData is ephemeral
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
function isMarkedForDeletion(obj) {
    if (!isValidObject(obj) || !obj.MetaData) return false;
    try {
        const metadata = typeof obj.MetaData === 'string' ? JSON.parse(obj.MetaData) : obj.MetaData;
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
export function createReactiveStore(apiCall = null, saveCall = null, apiArgs = [], analysisConfig = null, priorityConfig = null) {
    // Priority configuration with defaults
    const priorities = {
        load: priorityConfig?.load !== undefined ? priorityConfig.load : Priority.LOAD,      // Default: 8
        save: priorityConfig?.save !== undefined ? priorityConfig.save : Priority.SAVE,      // Default: 9
        analysis: priorityConfig?.analysis !== undefined ? priorityConfig.analysis : Priority.ANALYSIS  // Default: 1
    };
    // Helper to recursively add AppData to all objects in an array (and nested arrays)
    function appDataInit(arr) {
        if (!Array.isArray(arr)) return arr;
        return arr.map(obj => {
            if (obj && typeof obj === 'object') {
                if (!('AppData' in obj)) obj['AppData'] = {};
                
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
                        obj[key] = appDataInit(obj[key]);
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

    const store = Vue.reactive({
        data: [],
        originalData: [],
        isLoading: false,
        loadingMessage: '',
        error: null,
        isAnalyzing: false,
        isReloadingMainData: false, // Lock to prevent analysis during main data reload
        analysisProgress: 0,
        analysisMessage: '',
        analysisConfig,
        initialLoad: false, // True if this is the first load of the store
        autoSaved: false, // True if this store has been auto-saved or loaded from auto-save
        lastAutoSaveHash: null, // Hash of data when last auto-saved, to prevent redundant saves
        
        // Computed property to check if data has been modified
        get isModified() {
            if (!this.data || !this.originalData) return false;
            if (this.data.length === 0 && this.originalData.length === 0) return false;
            
            // Create clean copies without AppData and analysis columns for comparison
            const cleanCurrent = removeAppData(
                deepClone(this.data), 
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
            // Deep clone and initialize AppData
            const processedData = appDataInit(deepClone(newData));
            // Clear any existing analysis results if analysis is configured
            if (this.analysisConfig) {
                clearAnalysisResults(processedData, this.analysisConfig);
            }
            // Mutate existing array in place to preserve references (critical for undo system)
            this.data.splice(0, this.data.length, ...processedData);
            // Clear auto-save hash when data changes
            this.lastAutoSaveHash = null;
            
            // Automatically run analysis if configured and data is loaded
            // Skip if main data is being reloaded (will run after reload completes)
            if (this.analysisConfig && this.data.length > 0 && !this.isAnalyzing && !this.isReloadingMainData) {
                // Use nextTick to ensure Vue has updated the DOM and reactive properties
                Vue.nextTick(() => {
                    this.runConfiguredAnalysis();
                });
            }
        },
        setOriginalData(newOriginalData) {
            // Deep clone and initialize AppData
            const processedData = appDataInit(deepClone(newOriginalData));
            // Mutate existing array in place to preserve references
            this.originalData.splice(0, this.originalData.length, ...processedData);
        },
        setError(err) {
            this.error = err;
        },
        setLoading(isLoading, message = '') {
            this.isLoading = isLoading;
            this.loadingMessage = message;
        },
        reset() {
            // Clear arrays in place to preserve references for undo system
            this.data.splice(0, this.data.length);
            this.originalData.splice(0, this.originalData.length);
            this.isLoading = false;
            this.loadingMessage = '';
            this.error = null;
            this.isAnalyzing = false;
            this.analysisProgress = 0;
            this.analysisMessage = '';
        },
        async load(message = 'Loading data...', skipAnalysis = false) {
            //this.reset();
            if (typeof apiCall !== 'function') {
                this.setError('No API call provided');
                // Initialize with empty array to allow dynamic property addition
                this.setOriginalData([]);
                this.setData([]);
                return;
            }
            this.setLoading(true, message);
            this.isReloadingMainData = true; // Lock to prevent analysis during reload
            this.setError(null);
            try {
                // Use priority queue for load operations (high priority)
                const result = await PriorityQueue.enqueue(
                    apiCall,
                    apiArgs,
                    priorities.load,
                    { label: message, type: 'load', store: 'reactive' }
                );
                // Handle null, undefined, or empty results by initializing empty arrays
                const dataToSet = (result && Array.isArray(result)) ? result : [];
                this.setOriginalData(dataToSet);
                this.setData(dataToSet);
                
                // Release lock BEFORE running analysis so analysis can proceed
                this.isReloadingMainData = false;
                
                // After data is loaded, run analysis if configured, data exists, and not skipped
                if (!skipAnalysis && this.analysisConfig && this.analysisConfig.length > 0 && this.data.length > 0) {
                    await this.runConfiguredAnalysis();
                }
            } catch (err) {
                this.setError(err.message || 'Failed to load data');
                // Initialize with empty arrays to allow dynamic property addition
                this.setOriginalData([]);
                this.setData([]);
            } finally {
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
            this.setLoading(true, message);
            this.setError(null);
            try {
                // Remove all objects marked for deletion and analysis target columns before saving
                const cleanData = removeAppData(this.data, this.analysisConfig);
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
                
                // Remove backup from user data after successful save
                const storeKey = generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig);
                await removeStoreBackupFromUserData(storeKey);
                this.autoSaved = false; // Clear auto-save flag after successful save
                this.lastAutoSaveHash = null; // Clear auto-save hash after manual save
                
                return result;
            } catch (err) {
                this.setError(err.message || 'Failed to save data');
                return false;
            } finally {
                this.setLoading(false, '');
            }
        },
        // Mark/unmark for deletion by index using MetaData
        markRowForDeletion(idx, value = true) {
            if (this.data[idx]) {
                const row = this.data[idx];
                
                // Parse existing MetaData
                let metadata = {};
                if (row.MetaData) {
                    try {
                        metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
                    } catch (e) {
                        console.warn('Failed to parse MetaData:', e);
                    }
                }
                
                // Set or remove deletion flag
                if (value) {
                    metadata.deletion = { marked: true };
                } else {
                    delete metadata.deletion;
                }
                
                // Save back to MetaData
                row.MetaData = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
                
                // If marking for deletion and row is empty, remove immediately
                if (value) {
                    // Check if all fields (except 'AppData' and 'MetaData') are empty/falsy
                    const hasContent = Object.keys(row).some(
                        key => key !== 'AppData' && key !== 'MetaData' && !!row[key]
                    );
                    if (!hasContent) {
                        this.data.splice(idx, 1);
                    }
                }
            }
        },
        // Remove all rows marked for deletion (and nested arrays)
        removeMarkedRows() {
            // Filter in place to preserve array reference for undo system
            const filteredData = this.data.filter(obj => !isMarkedForDeletion(obj));
            
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
            this.data.splice(0, this.data.length, ...filteredData);
        },
        addRow(row, fieldNames = null) {
            // Ensure AppData is set and nested arrays are initialized
            if (row && typeof row === 'object') {
                if (!('AppData' in row)) row['AppData'] = {};
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
            this.data.push(row);
        },
        addNestedRow(parentIdx, key, row, fieldNames = null, position = null) {
            // Add a row to a nested array (e.g., Items)
            // position: { position: 'above'|'below', targetIndex: number } or null for append
            if (
                Array.isArray(this.data) &&
                this.data[parentIdx] &&
                Array.isArray(this.data[parentIdx][key])
            ) {
                if (row && typeof row === 'object') {
                    if (!('AppData' in row)) row['AppData'] = {};
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
                    this.data[parentIdx][key].splice(insertIndex, 0, row);
                } else {
                    // Default: append to end
                    this.data[parentIdx][key].push(row);
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
                        const shouldClear = identifiers.includes(config.resultKey) || 
                                          identifiers.includes(config.targetColumn);
                        
                        if (shouldClear) {
                            clearAnalysisResultsFromItem(item, config, true); // Clear target column data
                        }
                    });
                }
            };

            this.data.forEach(item => {
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
                console.log('[ReactiveStore] Skipping analysis - main data is being reloaded');
                return;
            }
            
            if (!this.analysisConfig || this.isAnalyzing) {
                return;
            }

            const {
                batchSize = 10,
                delayMs = 50,
                skipIfAnalyzed = false
            } = options;

            this.isAnalyzing = true;
            this.analysisProgress = 0;
            this.analysisMessage = 'Starting analysis...';

            try {
                // Helper to find value from ordered source columns
                const findSourceValue = (item, sourceColumns, parentItem = null) => {
                    if (!sourceColumns || sourceColumns.length === 0) return item;
                    
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
                            const mainSample = this.data[0];
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
                let totalOperations = 0;
                let completedOperations = 0;

                // Calculate total operations for progress tracking
                relevantConfigs.forEach(config => {
                    if (config.processMain) {
                        totalOperations += this.data.length;
                    }
                    config.processNested.forEach(arrayKey => {
                        this.data.forEach(item => {
                            if (item[arrayKey] && Array.isArray(item[arrayKey])) {
                                totalOperations += item[arrayKey].length;
                            }
                        });
                    });
                });

                // Process main data
                for (const config of relevantConfigs) {
                    if (!config.processMain) continue;

                    this.analysisMessage = `${config.label || 'Processing'} main data...`;

                    for (let i = 0; i < this.data.length; i += batchSize) {
                        const batch = this.data.slice(i, i + batchSize);
                        
                        // Create batch promises for concurrent execution via priority queue
                        const batchPromises = batch.map(async (item) => {
                            if (!item || typeof item !== 'object') return;
                            if (!item.AppData) item.AppData = {};
                            
                            if (skipIfAnalyzed && item.AppData._analyzed) return;
                            item.AppData._analyzing = true;

                            try {
                                const inputValue = findSourceValue(item, config.sourceColumns);
                                
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
                for (const config of relevantConfigs) {
                    for (const arrayKey of config.processNested) {
                        this.analysisMessage = `${config.label || 'Processing'} ${arrayKey} data...`;

                        for (const parentItem of this.data) {
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
                                            config.needsParentContext ? parentItem : null);
                                        
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
                setTimeout(() => {
                    this.analysisProgress = 0;
                    this.analysisMessage = '';
                }, 2000);
            }
        },
        async handleInvalidation() {
            // Reload both originalData and data from the server
            // The load() method will:
            // 1. Set isReloadingMainData = true (prevents concurrent analysis)
            // 2. Load fresh data from API
            // 3. Run analysis automatically after data loads
            // 4. Set isReloadingMainData = false
            await this.load('Reloading data due to invalidation...');
        }
    });

    // Helper to strip AppData, EditHistory, and analysis target columns from objects (including filtering out items marked for deletion)
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

// Auto-save timer for dirty stores
let autoSaveInterval = null;
const AUTO_SAVE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Calculate diff between original and current data recursively
 * Only stores row indices with their changed fields for efficiency
 * Handles nested arrays recursively
 * Excludes AppData, EditHistory, and analysis target columns
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
        console.log('[ReactiveStore AutoSave] Skipping auth check (logout in progress)');
        if (!authState.user?.email) {
            console.log('[ReactiveStore AutoSave] No user email available, skipping auto-save');
            return;
        }
    } else {
        // Normal auto-save flow - check if auth prompt is showing
        if (Auth.authPromptShowing) {
            console.log('[ReactiveStore AutoSave] Auth prompt showing, skipping auto-save');
            return;
        }
        
        // Check authentication before attempting to save (with prompt if expired)
        const isAuthenticated = await Auth.checkAuthWithPrompt({
            context: 'auto-save',
            message: 'Your session has expired.'
        });
        
        if (!isAuthenticated) {
            console.log('[ReactiveStore AutoSave] Auth check failed, skipping auto-save');
            return;
        }
        
        if (!authState.user?.email) {
            console.log('[ReactiveStore AutoSave] No user email available, skipping auto-save');
            return;
        }
    }
    
    try {
        let savedCount = 0;
        let cleanedCount = 0;
        let skippedCount = 0;
        
        // Save each dirty store as a separate user data entry
        for (const [key, store] of Object.entries(reactiveStoreRegistry)) {
            const isModified = store.isModified;
            const diff = calculateStoreDiff(store.originalData, store.data, store.analysisConfig);
            
            if (isModified && store.originalData && store.data && diff) {
                // Calculate hash of current diff to check if already saved
                const currentHash = JSON.stringify(diff);
                
                // Only save if this exact state hasn't been auto-saved already
                if (store.lastAutoSaveHash !== currentHash) {
                    // Store has changes - save the diff
                    await Requests.storeUserData(
                        { diff, timestamp: new Date().toISOString() },
                        authState.user.email,
                        key // Use the store key as the unique ID
                    );
                    store.autoSaved = true;
                    store.lastAutoSaveHash = currentHash; // Record this state as saved
                    savedCount++;
                } else {
                    skippedCount++;
                }
            } else if (!diff && store.autoSaved) {
                // Store is clean but was previously auto-saved - clean up the entry
                await Requests.storeUserData(
                    null, // Setting to null will delete the entry
                    authState.user.email,
                    key
                );
                store.autoSaved = false;
                cleanedCount++;
            }
        }
        
        if (savedCount > 0) {
            console.log(`[ReactiveStore AutoSave] Successfully saved ${savedCount} dirty store(s) to user data`);
        }
        if (cleanedCount > 0) {
            console.log(`[ReactiveStore AutoSave] Cleaned up ${cleanedCount} resolved auto-save entries`);
        }
        if (skippedCount > 0) {
            console.log(`[ReactiveStore AutoSave] Skipped ${skippedCount} store(s) - already auto-saved in current state`);
        }
        if (savedCount === 0 && cleanedCount === 0 && skippedCount === 0) {
            console.log('[ReactiveStore AutoSave] No changes to save or clean up');
        }
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
    
    console.log('[ReactiveStore AutoSave] Starting auto-save timer');
    autoSaveInterval = setInterval(() => {
        const storeCount = Object.keys(reactiveStoreRegistry).length;
        if (storeCount > 0) {
            saveDirtyStoresToUserData();
        } else {
            console.log('[ReactiveStore AutoSave] No stores in registry, skipping auto-save');
        }
    }, AUTO_SAVE_INTERVAL_MS);
}

/**
 * Stop auto-save timer
 */
function stopAutoSaveTimer() {
    if (autoSaveInterval) {
        console.log('[ReactiveStore AutoSave] Stopping auto-save timer');
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
 * Load saved store data from user data
 * @param {string} storeKey - Store registry key (used as the user data ID)
 * @returns {Array|null} Diff to apply, or null if none found
 */
async function loadStoreBackupFromUserData(storeKey) {
    if (!authState.isAuthenticated || !authState.user?.email) {
        return null;
    }
    
    try {
        // Retrieve using the storeKey as the ID
        const backupData = await Requests.getUserData(authState.user.email, storeKey);
        // Check for null (deleted entry) or missing data
        if (backupData && backupData !== null && backupData.diff) {
            console.log(`[ReactiveStore] Found backup for store, timestamp: ${backupData.timestamp}`);
            return backupData.diff;
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
        console.log(`[ReactiveStore] Removed backup for store after save`);
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
 * @returns {Object} The reactive store instance
 */
export function getReactiveStore(apiCall, saveCall = null, apiArgs = [], analysisConfig = null, autoLoad = true, priorityConfig = null) {
    const key = generateStoreKey(apiCall, saveCall, apiArgs, analysisConfig);
    
    if (!reactiveStoreRegistry[key]) {
        const store = createReactiveStore(apiCall, saveCall, apiArgs, analysisConfig, priorityConfig);
        reactiveStoreRegistry[key] = store;
        
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
                    const backup = await loadStoreBackupFromUserData(key);
                    const hasBackup = backup && backup.length > 0;
                    
                    if (hasBackup) {
                        store.setLoading(true, 'Restoring saved changes...');
                    }
                    
                    // Load data - skip initial analysis if we have a backup to apply
                    store.setLoading(true, 'Loading data...');
                    await store.load('Loading data...', hasBackup);
                    
                    // Apply backup after load if found
                    if (hasBackup && store.data) {
                        console.log('[ReactiveStore] Applying backup to store data');
                        const restoredData = applyDiffToData(store.data, backup);
                        store.setData(restoredData);
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
            store.setOriginalData([]);
            store.setData([]);
            store.setLoading(false);
            store.initialLoad = false;
        }
    }
    
    return reactiveStoreRegistry[key];
}

/**
 * Setup cache invalidation listeners for a reactive store
 * @param {Object} store - The reactive store instance
 * @param {Function} apiCall - The main API call function
 * @param {Array} apiArgs - Arguments for the API call
 * @param {Array} analysisConfig - Analysis configuration
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
    if (analysisConfig && Array.isArray(analysisConfig)) {
        analysisConfig.forEach((config, index) => {
            const analysisMethodName = extractMethodName(config.apiFunction);
            if (analysisMethodName) {
                const analysisPattern = `api:${analysisMethodName}`;
                
                CacheInvalidationBus.on(analysisPattern, async (eventData) => {
                    console.log(`[ReactiveStore] Analysis invalidation received for ${analysisMethodName}`);
                    
                    // Add small delay to allow main data reload to register if happening simultaneously
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                    // Check if main data is being reloaded - if so, skip (analysis will run after load)
                    if (store.isReloadingMainData) {
                        console.log(`[ReactiveStore] Skipping analysis rerun for ${analysisMethodName} - main data is reloading`);
                        return;
                    }
                    
                    // Clear and rerun only the specific analysis that was invalidated
                    console.log(`[ReactiveStore] Re-running analysis step ${index + 1} for ${analysisMethodName}`);
                    store.clearSpecificAnalysisResults([config.resultKey || config.targetColumn]);
                    store.runConfiguredAnalysis({ skipIfAnalyzed: false });
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
 * @returns {Object} Analysis configuration object
 */
export function createAnalysisConfig(apiFunction, resultKey, label, sourceColumns = null, additionalParams = [], targetColumn = null, passFullItem = false, priority = Priority.ANALYSIS) {
    return {
        apiFunction,
        resultKey,
        label,
        sourceColumns: Array.isArray(sourceColumns) ? sourceColumns : (sourceColumns ? [sourceColumns] : []),
        additionalParams,
        targetColumn, // If set, results go to this column instead of AppData
        passFullItem, // If true, pass entire item even when sourceColumns specified
        priority // Priority level for queue processing
    };
}

/**
 * Clear all reactive stores from the registry
 * Useful for logout or when switching users
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipSave - If true, skip auto-save during cleanup (used during logout)
 */
export async function clearAllReactiveStores(options = {}) {
    const { skipSave = false } = options;
    
    console.log('[ReactiveStore] Starting cleanup of all stores');
    
    // Get count before clearing
    const storeCount = Object.keys(reactiveStoreRegistry).length;
    
    // Step 1: Immediately stop and clear all tasks in the Priority queue
    console.log('[ReactiveStore] Step 1: Stopping and clearing Priority Queue');
    PriorityQueue.stopProcessing();
    PriorityQueue.clearAll();
    
    // Step 2: Stop the autosave timer
    console.log('[ReactiveStore] Step 2: Stopping auto-save timer');
    stopAutoSaveTimer();
    
    // Step 3: Optionally save dirty stores (skip during logout since we save separately)
    if (!skipSave) {
        console.log('[ReactiveStore] Step 3: Saving dirty stores');
        await saveDirtyStoresToUserData({ skipAuthCheck: true });
    } else {
        console.log('[ReactiveStore] Step 3: Skipping save (skipSave=true)');
    }
    
    // Step 4: Remove all reactive stores from registry
    console.log('[ReactiveStore] Step 4: Clearing all stores from registry');
    Object.keys(reactiveStoreRegistry).forEach(key => {
        delete reactiveStoreRegistry[key];
    });
    
    console.log(`[ReactiveStore] Cleanup complete - cleared ${storeCount} store(s) from registry`);
}

