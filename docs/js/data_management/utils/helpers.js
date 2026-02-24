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
 * Filters data based on search parameters.
 * @param {Array} data - The array of objects to search within.
 * @param {Object} searchParams - An object where keys are field names and values are search terms.
 *        If the key is "$any", the value will be searched in all fields.
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

    /**
     * Helper function to apply match type to a value comparison
     * @param {string} itemValue - The value from the data item
     * @param {string|Array} searchValue - The search value(s) to match against
     * @param {string} type - The type of match to perform
     * @returns {boolean} Whether the match succeeds
     */
    function applyMatchType(itemValue, searchValue, type) {
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

    return data.filter(item => {
        // If $any is present, search all keys for the value
        if (searchParams.hasOwnProperty('$any')) {
            const searchConfig = searchParams['$any'];
            const searchValue = extractSearchValue(searchConfig);
            const type = typeof searchConfig === 'object' ? searchConfig.type : 'contains';
            
            return Object.values(item).some(val => 
                applyMatchType(val, searchValue, type)
            );
        }
        
        // Separate filters by type for different combining logic
        const excludeFilters = [];
        const otherFilters = [];
        
        Object.keys(searchParams).forEach(key => {
            if (!item.hasOwnProperty(key)) return;
            
            const searchConfig = searchParams[key];
            const searchValue = extractSearchValue(searchConfig);
            const type = typeof searchConfig === 'object' ? searchConfig.type : 'contains';
            
            const filterInfo = { key, searchValue, type };
            
            if (type === 'excludes') {
                excludeFilters.push(filterInfo);
            } else {
                otherFilters.push(filterInfo);
            }
        });
        
        // For exclude filters: each filter independently excludes items
        // Item passes if it passes ALL exclude filters (doesn't match any excluded term)
        const passesExcludeFilters = excludeFilters.length === 0 || 
            excludeFilters.every(f => applyMatchType(item[f.key], f.searchValue, f.type));
        
        // For other filters: Item passes if it matches ANY filter (OR logic)
        const passesOtherFilters = otherFilters.length === 0 || 
            otherFilters.some(f => applyMatchType(item[f.key], f.searchValue, f.type));
        
        // Item must pass both filter groups
        return passesExcludeFilters && passesOtherFilters;
    });
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
    
    // Parse text filters into searchParams
    const textFilters = parseTextFilterParameters(params);
    textFilters.forEach(filter => {
        if (filter.column && filter.values && filter.values.length > 0) {
            // Store as object with values and type for advanced matching
            result.searchParams[filter.column] = {
                values: filter.values,
                type: filter.type || 'contains'
            };
        }
    });
    
    return result;
}


