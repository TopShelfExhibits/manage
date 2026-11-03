import { isCheckedValue } from './checkbox-values.js';

export function parseDate(val, forceLocal = true, defaultYear = null) {
    if (!val) return null;
    
    // Handle 'YYYY-MM-DD' as local date
    if (forceLocal && typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const [year, month, day] = val.split('-').map(Number);
        return new Date(year, month - 1, day, 12, 0, 0, 0);
    }
    
    if (typeof val === 'string') {
        // Handle 'M/D/YYYY' or 'M/D/YY' or 'M/D' (optionally with year)
        let mdy = val.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (mdy) {
            let month = Number(mdy[1]);
            let day = Number(mdy[2]);
            let year = mdy[3] ? Number(mdy[3]) : null;
            if (year && year < 100) year += 2000; // handle 2-digit years
            if (!year && defaultYear) year = Number(defaultYear);
            if (!year) year = new Date().getFullYear();
            return new Date(year, month - 1, day, 12, 0, 0, 0);
        }
        
        // Handle 'DD-MMM' or 'D-MMM' format (e.g., '21-Jan', '3-Dec')
        let dmm = val.match(/^(\d{1,2})-([A-Za-z]{3})$/);
        if (dmm) {
            const day = Number(dmm[1]);
            const monthName = dmm[2].toLowerCase();
            const monthMap = {
                jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
            };
            const month = monthMap[monthName];
            if (month !== undefined) {
                const year = defaultYear ? Number(defaultYear) : new Date().getFullYear();
                return new Date(year, month, day, 12, 0, 0, 0);
            }
        }
        
        // Handle 'MMM-DD' or 'MMM-D' format (e.g., 'Jan-21', 'Dec-3')
        let mmd = val.match(/^([A-Za-z]{3})-(\d{1,2})$/);
        if (mmd) {
            const monthName = mmd[1].toLowerCase();
            const day = Number(mmd[2]);
            const monthMap = {
                jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
            };
            const month = monthMap[monthName];
            if (month !== undefined) {
                const year = defaultYear ? Number(defaultYear) : new Date().getFullYear();
                return new Date(year, month, day, 12, 0, 0, 0);
            }
        }
    }
    
    // Fallback to Date constructor
    const d = new Date(val);
    if (!isNaN(d)) {
        // If defaultYear is provided and year is not set, set it
        if (defaultYear && d.getFullYear() === 1970) {
            d.setFullYear(Number(defaultYear));
        }
        return d;
    }
    return null;
}

/**
 * Converts a Date object to a YYYY-MM-DD date string using local calendar date.
 * @param {Date} date
 * @returns {string|null}
 */
export function toISODateString(date) {
    if (!date || !(date instanceof Date) || isNaN(date)) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Converts a Date object to a MM/DD/YYYY date string using local calendar date.
 * @param {Date} date
 * @returns {string|null}
 */
export function toUSDateString(date) {
    if (!date || !(date instanceof Date) || isNaN(date)) return null;
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const y = date.getFullYear();
    return `${m}/${d}/${y}`;
}

/**
 * Normalizes a header name by removing carriage returns, newlines, and extra whitespace.
 * Google Sheets headers may contain line breaks that need to be stripped for matching.
 * @param {string} headerName - The raw header name from Google Sheets
 * @returns {string} Normalized header name
 */
/**
 * Whether the app is running locally (localhost, 127.0.0.1, or file://).
 * Local runs use the fake Google services and the dev/test tooling.
 * @returns {boolean}
 */
export function isLocalhost() {
    return (
        typeof window !== 'undefined' &&
        (
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.protocol === 'file:'
        )
    );
}

export function normalizeHeaderName(headerName) {
    return String(headerName ?? '')
        .replace(/[\r\n]+/g, ' ')  // Replace carriage returns and newlines with spaces
        .replace(/\s+/g, ' ')       // Collapse multiple spaces into one
        .trim();                     // Remove leading/trailing whitespace
}

/**
 * Sanitizes a tab name by removing characters that would break Google Sheets or interface display.
 * Removes: /, \, ?, *, [, ], and other problematic characters.
 * Keeps alphanumeric, spaces, hyphens, and underscores for fuzzy matching to work.
 * @param {string} tabName - The tab name to sanitize
 * @returns {string} - The sanitized tab name
 */
export function sanitizeTabName(tabName) {
    if (!tabName || typeof tabName !== 'string') return '';
    
    return tabName
        .replace(/[\/\\?*\[\]'"]/g, '')  // Remove problematic characters
        .replace(/\s+/g, ' ')             // Collapse multiple spaces
        .trim();                          // Remove leading/trailing whitespace
}

/**
 * Returns today's date as a YYYY-MM-DD string using the local calendar date.
 * @returns {string}
 */
export function todayISOString() {
    return toISODateString(new Date());
}

/**
 * Converts a numeric day offset (relative to today) or an ISO date string to an ISO date string.
 * Returns null for anything else (undefined, non-ISO strings, etc.).
 * Single entry point for resolving date filter values from the URL / presets.
 * @param {number|string|null|undefined} value
 * @returns {string|null}
 */
export function offsetToISO(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        const d = new Date();
        d.setDate(d.getDate() + value);
        return toISODateString(d);
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return null;
}


/**
 * Filters data based on search parameters.
 * @param {Array} data - The array of objects to search within.
 * @param {Object} searchParams - Keys are field names; each value is a search config
 *        ({ values, type } or a plain string), or a list of configs for the same field.
 *        If the key is "$any", the value is searched in all fields.
 *        Types: 'contains' (default), 'excludes', 'empty', 'checked', 'unchecked'.
 *        Within one field, the include types (contains, empty, checked, unchecked) are OR'd and
 *        every excludes applies (AND); different fields are AND'd.
 * @returns {Array} - The filtered array of objects.
 */
export function searchFilter(data, searchParams) {
    if (!Array.isArray(data) || typeof searchParams !== 'object') {
        throw new Error('Invalid arguments: data must be an array and searchParams must be an object.');
    }

    /**
     * Extract search value from config (handles backward compatibility)
     */
    function extractSearchValue(searchConfig) {
        if (typeof searchConfig === 'string') {
            return searchConfig;
        }
        if (searchConfig.values && Array.isArray(searchConfig.values)) {
            return searchConfig.values;
        }
        return searchConfig.value;
    }

    function typeOf(searchConfig) {
        return (typeof searchConfig === 'object' && searchConfig && searchConfig.type) || 'contains';
    }

    /**
     * Helper function to apply match type to a value comparison
     * @param {string} itemValue - The value from the data item
     * @param {string|Array} searchValue - The search value(s) to match against
     * @param {string} type - The type of match to perform
     * @returns {boolean} Whether the match succeeds
     */
    function applyMatchType(itemValue, searchValue, type) {
        // Value-less types
        if (type === 'empty') return !String(itemValue ?? '').trim();
        if (type === 'checked') return isCheckedValue(itemValue);
        if (type === 'unchecked') return !isCheckedValue(itemValue);

        const itemStr = String(itemValue).toLowerCase();

        // Handle array of values (list search)
        if (Array.isArray(searchValue)) {
            const searchStrings = searchValue.map(v => String(v).toLowerCase());

            if (type === 'excludes') {
                // Item passes filter if it doesn't contain ANY of the excluded values
                // Each exclude value independently triggers exclusion (AND logic)
                return !searchStrings.some(searchStr => itemStr.includes(searchStr));
            }
            // Default to contains: Item matches if it contains ANY of the search values (OR logic)
            return searchStrings.some(searchStr => itemStr.includes(searchStr));
        }

        // Handle single value (backward compatibility)
        const searchStr = String(searchValue).toLowerCase();

        if (type === 'excludes') {
            return !itemStr.includes(searchStr);
        }
        // Default to contains
        return itemStr.includes(searchStr);
    }

    // One field's configs: (any include config matches, if there are any) and (every excludes passes)
    function passesField(itemValue, configs) {
        const includes = configs.filter(c => typeOf(c) !== 'excludes');
        const excludes = configs.filter(c => typeOf(c) === 'excludes');
        if (!excludes.every(c => applyMatchType(itemValue, extractSearchValue(c), 'excludes'))) return false;
        return includes.length === 0 || includes.some(c => applyMatchType(itemValue, extractSearchValue(c), typeOf(c)));
    }

    const asList = (config) => (Array.isArray(config) ? config : [config]).filter(c => c !== null && c !== undefined);

    return data.filter(item => {
        // If $any is present, search all keys for the value
        if (searchParams.hasOwnProperty('$any')) {
            const configs = asList(searchParams['$any']);
            return Object.values(item).some(val => passesField(val, configs));
        }

        // Every field's filter must pass (AND across fields); a field the item lacks is skipped
        return Object.keys(searchParams).every(key => {
            if (!item.hasOwnProperty(key)) return true;
            return passesField(item[key], asList(searchParams[key]));
        });
    });
}

/** Filter types that take no values (the operation is the whole filter). */
export const VALUELESS_FILTER_TYPES = Object.freeze(['empty', 'checked', 'unchecked']);

/**
 * Text filters from the filter UI / URL ([{ column, values, type }]) → searchFilter params.
 * Filters on the same column are kept together as a list, so "contains Bob" and "is empty" on
 * one column both apply (rows matching either), instead of the second replacing the first.
 * @param {Array} textFilters
 * @returns {Object} searchParams (empty when there are no usable filters)
 */
export function textFiltersToSearchParams(textFilters) {
    const params = {};
    (Array.isArray(textFilters) ? textFilters : []).forEach(filter => {
        if (!filter || !filter.column) return;
        const type = filter.type || 'contains';
        const values = normalizeFilterValues(filter).map(v => String(v)).filter(v => v.trim());
        if (!values.length && !VALUELESS_FILTER_TYPES.includes(type)) return;
        const config = VALUELESS_FILTER_TYPES.includes(type) ? { values: [], type } : { values, type };
        const existing = params[filter.column];
        if (!existing) params[filter.column] = config;
        else params[filter.column] = [...(Array.isArray(existing) ? existing : [existing]), config];
    });
    return params;
}

/**
 * Map over an array with bounded concurrency, yielding between batches.
 * Use in place of Promise.all(array.map(...)) when the input length is
 * variable or driven by user filters (shows, items), to avoid flooding the
 * microtask queue and locking the browser's main thread.
 *
 * NOTE: Concurrency management here is only relevant while the abstraction
 * layer runs on the browser main thread. If/when this layer is refactored to
 * a real backend API, this helper (and its callers) can be removed.
 *
 * @param {Array} items - The array to process
 * @param {Function} asyncFn - Async function called with (item, index)
 * @param {number} concurrency - Max parallel tasks per batch (default 8)
 * @param {Function} [onProgress] - Optional callback called after each batch: ({ processed, total }) => void
 * @returns {Promise<Array>} Results in original array order
 */
export async function mapWithConcurrency(items, asyncFn, concurrency = 8, onProgress = null) {
    const results = new Array(items.length);
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map((item, j) => asyncFn(item, i + j)));
        for (let j = 0; j < chunkResults.length; j++) {
            results[i + j] = chunkResults[j];
        }
        const processed = Math.min(i + concurrency, items.length);
        if (onProgress) {
            onProgress({ processed, total: items.length });
        }
        if (i + concurrency < items.length) {
            await new Promise(r => setTimeout(r, 0));
        }
    }
    return results;
}


class FuzzyMatcher {
  static #keyboardAdjacencyMap = new Map(Object.entries({
    Q: ['W', 'A'],
    W: ['Q', 'E', 'S'],
    E: ['W', 'R', 'D'],
    R: ['E', 'T', 'F'],
    T: ['R', 'Y', 'G'],
    Y: ['T', 'U', 'H'],
    U: ['Y', 'I', 'J'],
    I: ['U', 'O', 'K'],
    O: ['I', 'P', 'L'],
    P: ['O'],
    A: ['Q', 'S', 'Z'],
    S: ['A', 'D', 'W', 'X'],
    D: ['S', 'F', 'E', 'C'],
    F: ['D', 'G', 'R', 'V'],
    G: ['F', 'H', 'T', 'B'],
    H: ['G', 'J', 'Y', 'N'],
    J: ['H', 'K', 'U', 'M'],
    K: ['J', 'L', 'I'],
    L: ['K', 'O'],
    Z: ['A', 'X'],
    X: ['Z', 'S', 'C'],
    C: ['X', 'D', 'V'],
    V: ['C', 'F', 'B'],
    B: ['V', 'G', 'N'],
    N: ['B', 'H', 'M'],
    M: ['N', 'J']
  }));

  static #visualSimilarityPairs = [
    ['O', '0'], ['L', '1'], ['I', 'L'], ['C', 'E'], ['G', 'Q'], ['U', 'V'], ['M', 'N'], [' ', '_'], [' ', '-']
  ];

  static GetTopFuzzyMatch(inputText, comparisonRange, abbreviationRange = null, distanceThreshold = 2) {
    if (typeof inputText !== 'string') {
      throw new Error(`Input must be text.`);
    }

    inputText = inputText.trim().toUpperCase().replace(/[\(\).'"]/g, '');
    const inputLen = inputText.length;

    // Short strings (acronyms, etc.) require stricter matching to avoid false positives
    if (inputLen <= 4) distanceThreshold = Math.min(distanceThreshold, 1);

    let bestMatch = '';
    let lowestDistance = distanceThreshold;
    let multipleBestResults = false;

    const comparisonValues = comparisonRange.flat();
    const abbreviations = abbreviationRange ? abbreviationRange.flat() : [];

    const preprocessedValues = [];

    for (let i = 0; i < comparisonValues.length; i++) {
      const value = comparisonValues[i];
      if (!value) continue;

      // Add the main comparison value itself as a candidate
      const processedValue = value.trim().toUpperCase().replace(/[\(\).'"]/g, '');
      preprocessedValues.push({
        original: value,
        processed: processedValue,
        length: processedValue.length
      });

      // If abbreviationRange is provided, add those too
      if (abbreviations[i]) {
        const splitAbbrs = abbreviations[i]
          .split(',')
          .map(a => a.trim())
          .filter(a => a.length > 0);

        for (let abbr of splitAbbrs) {
          preprocessedValues.push({
            original: value, // Always return the value from comparisonRange
            processed: abbr.toUpperCase().replace(/[\(\).'"]/g, ''),
            length: abbr.length
          });
        }
      }
    }

    const inputFirstLetter = inputText[0]?.toUpperCase() || '';

    // Put entries that start with the same first letter at the top
    preprocessedValues.sort((a, b) => {
      const aMatches = a.processed?.[0] === inputFirstLetter;
      const bMatches = b.processed?.[0] === inputFirstLetter;

      if (aMatches && !bMatches) return -1;
      if (!aMatches && bMatches) return 1;
      return 0; // maintain original order among equal-priority entries
    });

    for (let { original, processed, length } of preprocessedValues) {
      if (Math.abs(inputLen - length) > lowestDistance) continue;

      const dist = FuzzyMatcher.#fastDamerauLevenshteinEarlyAbort(inputText, processed, lowestDistance);

      if (dist === 0) return original;

      if (dist < lowestDistance) {
        lowestDistance = dist;
        multipleBestResults = false;
        bestMatch = original;
      } else if (dist === lowestDistance) {
        multipleBestResults = true;
      }
    }

    if (lowestDistance >= distanceThreshold) {
      throw new Error(`No good matches found for "${inputText}"`);
    } else if (multipleBestResults) {
      throw new Error(`Multiple possible matches found for "${inputText}"`);
    }

    return bestMatch;
  }

  static #fastDamerauLevenshteinEarlyAbort(a, b, maxDist) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > maxDist) return maxDist + 1;

    if (m === 0) return n;
    if (n === 0) return m;

    let dp = Array.from({ length: m + 2 }, () =>
      new Uint16Array(n + 2).fill(0)
    );

    const INF = m + n;
    dp[0][0] = INF;

    for (let i = 0; i <= m; i++) {
      dp[i + 1][1] = i;
      dp[i + 1][0] = INF;
    }

    for (let j = 0; j <= n; j++) {
      dp[1][j + 1] = j;
      dp[0][j + 1] = INF;
    }

    const da = {};
    for (let i = 0; i < m; i++) da[a[i]] = 0;
    for (let j = 0; j < n; j++) da[b[j]] = 0;

    for (let i = 1; i <= m; i++) {
      let db = 0;
      for (let j = 1; j <= n; j++) {
        const i1 = da[b[j - 1]];
        const j1 = db;

        const cost = FuzzyMatcher.#substitutionCost(a[i - 1], b[j - 1]);
        if (cost === 0) db = j;

        dp[i + 1][j + 1] = Math.min(
          dp[i][j] + cost,                         // substitution
          dp[i + 1][j] + 1,                        // insertion
          dp[i][j + 1] + 1,                        // deletion
          dp[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1) // transposition
        );
      }

      const rowMin = Math.min(...dp[i + 1]);
      if (rowMin > maxDist) return maxDist + 1;
      da[a[i - 1]] = i;
    }

    return dp[m + 1][n + 1];
  }

  static #substitutionCost(charA, charB) {
    if (charA === charB) return 0;

    charA = charA.toUpperCase();
    charB = charB.toUpperCase();

    // Visual similarity check
    for (const pair of FuzzyMatcher.#visualSimilarityPairs) {
      if ((pair[0] === charA && pair[1] === charB) || (pair[1] === charA && pair[0] === charB)) {
        return 0.7;
      }
    }

    // Keyboard adjacency check
    const adj = FuzzyMatcher.#keyboardAdjacencyMap.get(charA);
    if (adj && adj.includes(charB)) {
      return 0.7;
    }

    return 1;
  }
}
export const GetTopFuzzyMatch = FuzzyMatcher.GetTopFuzzyMatch;

/**
 * Simple paragraph matching function that returns a similarity score between 0 and 1
 * @param {string} text1 - First text to compare
 * @param {string} text2 - Second text to compare
 * @returns {number} Similarity score between 0 (no match) and 1 (exact match)
 */
export function GetParagraphMatchRating(text1, text2) {
  // Handle null/undefined/empty cases
  if (!text1 || !text2) return 0;
  if (text1 === text2) return 1;
  
  // Normalize texts: lowercase, remove extra whitespace and punctuation
  const normalize = (text) => {
    let normalized = text.toLowerCase()
      // Normalize dimensions like "3 x 4 x 5" to "3x4x5"
      .replace(/(\d+)\s*[xX]\s*(\d+)(?:\s*[xX]\s*(\d+))?/g, '$1x$2$3')
      // Normalize measurements like "2 ft" to "2ft", "3 cm" to "3cm", etc.
      .replace(/(\d+)\s+(ft|in|cm|mm|m|yd|inch|inches|foot|feet)/g, '$1$2')
      // Remove other punctuation
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized;
  };
  
  const norm1 = normalize(text1);
  const norm2 = normalize(text2);
  
  // Quick exact match check after normalization
  if (norm1 === norm2) return 1;
  
  // Split into words
  const words1 = norm1.split(' ');
  const words2 = norm2.split(' ');
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // Calculate word overlap using Jaccard similarity
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = new Set([...set1].filter(word => set2.has(word)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/**
 * Parse date filter parameters from URL params object
 * Format: DCol1, DVal1, DType1, DCol2, DVal2, DType2, etc.
 * 
 * @param {Object} params - URL parameters object
 * @returns {Array} Array of date filters with {column, value, type}
 */
export function parseDateFilterParameters(params) {
    const dateFilters = [];
    let filterIndex = 1;
    
    while (params[`DCol${filterIndex}`] || params[`DVal${filterIndex}`]) {
        const column = params[`DCol${filterIndex}`] || '';
        const valueString = params[`DVal${filterIndex}`] || '';
        const type = params[`DType${filterIndex}`] || 'after';
        
        if (column || valueString) {
            // Try to parse as number (offset), otherwise keep as string (date or identifier)
            let value = valueString;
            const numValue = Number(valueString);
            if (!isNaN(numValue) && valueString.trim() !== '') {
                value = numValue;
            }
            dateFilters.push({ column, value, type });
        }
        filterIndex++;
    }
    
    return dateFilters;
}

/**
 * Build date filter URL parameters
 * 
 * @param {Array} dateFilters - Array of date filters with {column, value, type}
 * @returns {Object} Object with DCol1, DVal1, DType1, DCol2, DVal2, DType2, etc.
 */
export function buildDateFilterParameters(dateFilters) {
    const params = {};
    
    if (!dateFilters || !Array.isArray(dateFilters)) return params;
    
    dateFilters.forEach((filter, index) => {
        if (filter.column || filter.value !== undefined) {
            params[`DCol${index + 1}`] = filter.column || '';
            params[`DVal${index + 1}`] = String(filter.value);
            params[`DType${index + 1}`] = filter.type || 'after';
        }
    });
    
    return params;
}

/**
 * Parse text filter parameters from URL params object
 * Format: Col1, Val1, Type1, Col2, Val2, Type2, etc.
 * Values can be pipe-separated for list search (val1|val2|val3)
 * 
 * @param {Object} params - URL parameters object
 * @returns {Array} Array of text filters with {column, values, type}
 */
export function parseTextFilterParameters(params) {
    const textFilters = [];
    let filterIndex = 1;
    
    while (params[`Col${filterIndex}`] || params[`Val${filterIndex}`]) {
        const column = params[`Col${filterIndex}`] || '';
        const valueString = params[`Val${filterIndex}`] || '';
        const type = params[`Type${filterIndex}`] || 'contains';
        
        if (column || valueString) {
            // Split pipe-separated values
            const values = valueString.split('|').map(v => v.trim()).filter(v => v);
            textFilters.push({ column, values, type });
        }
        filterIndex++;
    }
    
    return textFilters;
}

/**
 * Normalize filter values for backward compatibility
 * Converts old {value: string} format to new {values: array} format
 * 
 * @param {Object} filter - Filter object that may have 'value' or 'values'
 * @returns {Array} Array of values
 */
export function normalizeFilterValues(filter) {
    return filter.values || (filter.value ? [filter.value] : []);
}

/**
 * Build text filter URL parameters
 * 
 * @param {Array} textFilters - Array of text filters with {column, values, type}
 * @returns {Object} Object with Col1, Val1, Type1, Col2, Val2, Type2, etc.
 */
export function buildTextFilterParameters(textFilters) {
    const params = {};
    
    if (!textFilters || !Array.isArray(textFilters)) return params;
    
    textFilters.forEach((filter, index) => {
        const values = normalizeFilterValues(filter);
        if (filter.column || values.length > 0) {
            params[`Col${index + 1}`] = filter.column || '';
            // Join multiple values with pipe separator
            params[`Val${index + 1}`] = values.join('|');
            params[`Type${index + 1}`] = filter.type || 'contains';
        }
    });
    
    return params;
}

/**
 * Parse all search parameters from URL params object
 * Combines date filter and text filter parsing
 * 
 * @param {Object} params - URL parameters object
 * @returns {Object} Object with {dateFilters, searchParams}
 */
export function parseSearchParameters(params) {
    const result = {
        dateFilters: [],
        searchParams: {}
    };
    
    // Parse date filters
    result.dateFilters = parseDateFilterParameters(params);
    
    // Parse text filters into searchParams (same-column filters kept together)
    result.searchParams = textFiltersToSearchParams(parseTextFilterParameters(params));
    
    return result;
}

// Trims whitespace from any value, converting to string first.
export function normalizeText(value) {
    return String(value || '').trim();
}

// Produces a comparison key: uppercase, alphanumeric only. Used for matching/deduplication.
export function normalizeMatchKey(value) {
    return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}



// Returns a random loading quote, updating at most every 10 seconds.
export function getRandomLoadingQuote() {
    if (Date.now() - quoteTime > 10000) {
        quoteTime = Date.now();
        const index = Math.floor(Math.random() * loadingQuotes.length);
        currentQuote = loadingQuotes[index];
    }
    return currentQuote;
}




let quoteTime = Date.now();
let currentQuote = 'Getting quotes...';
const loadingQuotes = [
    'Please remain calm.',
    'We are getting there.',
    'Feel free to grab a coffee while you wait.',
    'Kick back and relax.',
    'This can take some time.',
    'Your data is taking the scenic route.',
    'The final 1% contains the difficult bits.',
    'A watched pot never boils.',
    'Please don’t refresh the page.',
    'Your patience is being converted into useful data.',
    '“Patience is bitter, but its fruit is sweet.” — Aristotle',
    '“The two most powerful warriors are patience and time.” — Leo Tolstoy',
    '“Nature does not hurry, yet everything is accomplished.” — Lao Tzu',
    '“Any sufficiently advanced technology is indistinguishable from magic.” — Arthur C. Clarke',
    '“The answer is there, waiting for us to find it.” — Carl Sagan',
    '“The whole is greater than the sum of its parts.” — Aristotle',
    '“We never live; we are always in the expectation of living.” — Voltaire',
    '“Progress is a comparative of which we have not settled the superlative.” — G. K. Chesterton',
    '“The right question is usually more important than the right answer.” — Plato',
    '“The best preparation for the future is the present well seen to, and the last duty done.” — George MacDonald',
    '“To keep a lamp burning we have to keep putting oil in it.” — George MacDonald',
    '“I myself find waiting more tiring than action.” — Winston Churchill',
    '“It is better to do something than to do nothing while waiting to do everything.” — Winston Churchill',
    '“Poets have been mysteriously silent on the subject of cheese.” — G.K. Chesterton',
    '“The traveler sees what he sees. The tourist sees what he has come to see.” — G.K. Chesterton',
    '“Hardship often prepares an ordinary person for an extraordinary destiny.” — C. S. Lewis',
    '“Things never happen the same way twice.” — C.S. Lewis',
    '“Still round the corner there may wait, A new road or a secret gate.” — J.R.R. Tolkien',
];