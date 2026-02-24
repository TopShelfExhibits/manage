/**
 * useSearch - Vue 3 Composable for Search Functionality
 * 
 * Provides reusable search functionality with:
 * - Text highlighting with multi-word support
 * - Row filtering with AND/OR logic
 * - URL parameter synchronization
 * - XSS-safe HTML escaping
 * 
 * @example
 * const search = useSearch({
 *     formatValue: formatCellValue,
 *     syncWithUrl: true,
 *     navigationRegistry: NavigationRegistry,
 *     containerPath: '/inventory',
 *     appContext: { currentPath: '/inventory?tab=items' }
 * });
 * 
 * // In template
 * <input v-model="search.searchValue.value" />
 * <span v-html="search.highlightText(cellValue, column)"></span>
 */

/**
 * Split search term into individual words
 * @param {String} searchTerm - The search term to split
 * @returns {Array} Array of words
 */
function splitSearchTerms(searchTerm) {
    if (!searchTerm || typeof searchTerm !== 'string') return [];
    return searchTerm.trim().split(/\s+/).filter(word => word.length > 0);
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {String} text - Text to escape
 * @returns {String} Escaped text
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Escape regex special characters
 * @param {String} text - Text to escape
 * @returns {String} Escaped text safe for regex
 */
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a search composable
 * @param {Object} options - Configuration options
 * @param {Function} options.formatValue - Optional value formatter function(value, column)
 * @param {Boolean} options.syncWithUrl - Enable URL parameter synchronization
 * @param {Object} options.navigationRegistry - Navigation registry for URL sync
 * @param {String} options.containerPath - Container path for URL sync
 * @param {Object} options.appContext - App context with currentPath
 * @returns {Object} Search state and methods
 */
export function useSearch(options = {}) {
    const {
        formatValue = null,
        syncWithUrl = false,
        navigationRegistry = null,
        containerPath = null,
        appContext = null
    } = options;

    // State
    const searchValue = Vue.ref('');
    const _clearingSearch = Vue.ref(false);

    // Computed
    const searchWords = Vue.computed(() => {
        return splitSearchTerms(searchValue.value);
    });

    const hasActiveSearch = Vue.computed(() => {
        return searchValue.value.trim().length > 0;
    });

    /**
     * Core highlighting logic - processes a string and returns HTML with highlights
     * @param {String} text - The text to highlight
     * @param {Array} words - Array of search words
     * @returns {String} HTML with highlighted matches
     */
    function applyHighlighting(text, words) {
        if (!text || !words || words.length === 0) {
            return escapeHtml(text || '');
        }

        const stringValue = String(text);
        
        // Collect all match positions for all search words
        const matches = [];
        words.forEach(word => {
            const escapedSearchWord = escapeRegex(word);
            const regex = new RegExp(escapedSearchWord, 'gi');
            let match;
            while ((match = regex.exec(stringValue)) !== null) {
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    text: match[0]
                });
            }
        });
        
        // Sort matches by start position
        matches.sort((a, b) => a.start - b.start);
        
        // Merge overlapping matches
        const merged = [];
        for (const match of matches) {
            if (merged.length === 0) {
                merged.push(match);
            } else {
                const last = merged[merged.length - 1];
                if (match.start <= last.end) {
                    // Overlapping or adjacent - merge them
                    last.end = Math.max(last.end, match.end);
                    last.text = stringValue.substring(last.start, last.end);
                } else {
                    merged.push(match);
                }
            }
        }
        
        // Build the final string with highlights, escaping HTML as we go
        let result = '';
        let lastIndex = 0;
        
        for (const match of merged) {
            // Add the non-matching part before this match (escaped)
            const beforeMatch = stringValue.substring(lastIndex, match.start);
            result += escapeHtml(beforeMatch);
            
            // Add the matching part with highlight (escaped)
            const matchText = escapeHtml(match.text);
            result += `<span class="search-match">${matchText}</span>`;
            
            lastIndex = match.end;
        }
        
        // Add any remaining text after the last match (escaped)
        const afterMatch = stringValue.substring(lastIndex);
        result += escapeHtml(afterMatch);
        
        return result;
    }

    /**
     * Highlight search terms in raw text (without formatting)
     * Useful for highlighting pre-formatted or HTML content
     * @param {String} text - The text to highlight
     * @returns {String} HTML string with highlighted matches
     */
    function highlightRawText(text) {
        if (!hasActiveSearch.value || !text) {
            return escapeHtml(text || '');
        }
        
        return applyHighlighting(text, searchWords.value);
    }

    /**
     * Highlight search terms in HTML content
     * Strips HTML tags, highlights matches, preserves line breaks
     * @param {String} htmlContent - HTML content to highlight
     * @returns {String} HTML with highlighted matches (preserves <br> tags)
     */
    function highlightHtmlContent(htmlContent) {
        if (!hasActiveSearch.value || !htmlContent) {
            return htmlContent || '';
        }
        
        // Replace <br> tags with newline placeholder before stripping HTML
        // This preserves line breaks through the process
        const NEWLINE_PLACEHOLDER = '\n';
        let processedContent = String(htmlContent)
            .replace(/<br\s*\/?>/gi, NEWLINE_PLACEHOLDER)
            .replace(/<\/p>/gi, NEWLINE_PLACEHOLDER)
            .replace(/<\/div>/gi, NEWLINE_PLACEHOLDER)
            .replace(/<\/li>/gi, NEWLINE_PLACEHOLDER);
        
        // Strip HTML tags to get plain text
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = processedContent;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        
        // Apply highlighting to plain text (this escapes HTML including newlines)
        const highlighted = applyHighlighting(plainText, searchWords.value);
        
        // Convert newlines back to <br> tags
        // Need to be careful not to break the search-match spans
        return highlighted.replace(/\n/g, '<br>');
    }

    /**
     * Highlight search terms in text with HTML spans
     * @param {*} value - The value to highlight
     * @param {Object} column - Column definition (for formatting)
     * @returns {String} HTML string with highlighted matches
     */
    function highlightText(value, column = null) {
        // First format the value if formatter provided
        const formattedValue = formatValue && column ? formatValue(value, column) : value;
        
        // If no search value or empty formatted value, return as-is
        if (!hasActiveSearch.value || !formattedValue) {
            return formattedValue;
        }
        
        return applyHighlighting(formattedValue, searchWords.value);
    }

    /**
     * Check if a value contains any search terms (OR logic)
     * @param {*} value - Value to check
     * @param {Object} column - Column definition (for formatting)
     * @returns {Boolean} True if any search word matches
     */
    function hasMatch(value, column = null) {
        if (!hasActiveSearch.value) {
            return false;
        }
        
        const formattedValue = formatValue && column ? formatValue(value, column) : value;
        if (!formattedValue) return false;
        
        const formattedLower = String(formattedValue).toLowerCase();
        
        // Check if any search word matches (OR logic for highlighting indication)
        return searchWords.value.some(word => formattedLower.includes(word.toLowerCase()));
    }

    /**
     * Check if a row matches search terms (AND logic)
     * @param {Object} row - Row data object
     * @param {Array} visibleColumns - Array of column definitions to search
     * @returns {Boolean} True if all search words match somewhere in the row
     */
    function matchesRow(row, visibleColumns) {
        if (!hasActiveSearch.value) return true;
        if (!row) return false;
        
        const words = searchWords.value;
        
        // All search words must match somewhere in the row (AND logic)
        return words.every(word => 
            visibleColumns.some(column => {
                const value = row[column.key];
                return String(value).toLowerCase().includes(word);
            })
        );
    }

    /**
     * Clear the search field and optionally update URL
     */
    function clearSearch() {
        _clearingSearch.value = true;
        searchValue.value = '';
        if (syncWithUrl) {
            updateUrlParameter('');
        }
        // Reset flag after a brief delay
        setTimeout(() => {
            _clearingSearch.value = false;
        }, 100);
    }

    /**
     * Update URL parameter with search term
     * @param {String} value - Search value to set in URL
     */
    function updateUrlParameter(value) {
        if (!syncWithUrl || !navigationRegistry || !containerPath) {
            return;
        }
        
        // Use silent parameter update to avoid triggering full navigation
        navigationRegistry.updatePathParametersSilently(
            containerPath.split('?')[0],
            appContext?.currentPath,
            {
                searchTerm: (value && value.trim()) ? value : undefined
            }
        );
    }

    /**
     * Handle search input blur event
     */
    function handleBlur() {
        if (!syncWithUrl || _clearingSearch.value) return;
        updateUrlParameter(searchValue.value);
    }

    /**
     * Initialize search value from URL parameters
     */
    function initializeFromUrl() {
        if (!syncWithUrl || !navigationRegistry || !containerPath || !appContext?.currentPath) {
            return;
        }
        
        const params = navigationRegistry.getParametersForContainer(
            containerPath,
            appContext.currentPath
        );
        if (params?.searchTerm) {
            searchValue.value = params.searchTerm;
        }
    }

    /**
     * Watch for URL parameter changes when syncWithUrl is enabled
     */
    function setupUrlWatcher() {
        if (!syncWithUrl || !appContext) return null;
        
        return Vue.watch(
            () => appContext.currentPath,
            (newPath, oldPath) => {
                if (!oldPath || !navigationRegistry || !containerPath) return;
                
                // Get parameters from both paths
                const newParams = navigationRegistry.getParametersForContainer(
                    containerPath,
                    newPath
                );
                const oldParams = navigationRegistry.getParametersForContainer(
                    containerPath,
                    oldPath
                );
                
                // Only update if searchTerm parameter changed
                if (newParams?.searchTerm !== oldParams?.searchTerm) {
                    searchValue.value = newParams?.searchTerm || '';
                }
            }
        );
    }

    return {
        // State
        searchValue,
        searchWords,
        hasActiveSearch,
        
        // Methods
        highlightText,
        highlightRawText,
        highlightHtmlContent,
        hasMatch,
        matchesRow,
        clearSearch,
        handleBlur,
        updateUrlParameter,
        initializeFromUrl,
        setupUrlWatcher,
        
        // Utility exports
        splitSearchTerms,
        escapeHtml
    };
}
