/**
 * Find scopes: which pages share a search (pure; no Vue, no data access).
 *
 * A page's find scope names what its search box searches. Navigating between two pages of the
 * same scope carries the search along. Navigating to a page of another scope opens it with the
 * search last left in that scope, if that was within SEARCH_MEMORY_MS, and otherwise with none.
 * A link that names a search (searchTerm in its path) always opens with that search, and browser
 * back/forward restores the search its history entry had.
 *
 * A page no pattern lists is its own scope: its search stays while you stay on the page.
 *
 * Patterns are clean paths ('?' parameters stripped) split on '/'. '*' matches one segment, and
 * $1, $2... in the scope stand for the segments the '*'s matched. The first matching entry wins.
 */
export const FIND_SCOPES = Object.freeze([
    // Inventory items: the overview, every category and its edit history
    { paths: ['inventory', 'inventory/categories', 'inventory/*', 'inventory/*/edit-history'], scope: 'inventory-items' },
    // Shows: the production schedule, the design queue and the pack list lists (all, pinned,
    // unlinked), before the one-pack-list patterns below
    { paths: ['schedule', 'schedule/design-queue', 'packlist', 'packlist/pins', 'packlist/unlinked'], scope: 'shows' },
    // One pack list: its crates and its item summary
    { paths: ['packlist/*', 'packlist/*/*'], scope: 'packlist:$1' }
]);

/** URL parameters that make up a page's search. Only searchTerm carries; the result index doesn't. */
export const SEARCH_PARAMS = Object.freeze(['searchTerm', 'searchIndex']);

/** How long a search left in a scope is offered again when you return to that scope */
export const SEARCH_MEMORY_MS = 5 * 60 * 1000;

function segments(path) {
    return String(path || '').split('?')[0].split('/').filter(s => s.length > 0);
}

/** The pattern's '*' captures for a path, or null when it doesn't match */
function matchPattern(pattern, pathSegments) {
    const patternSegments = pattern.split('/');
    if (patternSegments.length !== pathSegments.length) return null;
    const captures = [];
    for (let i = 0; i < patternSegments.length; i++) {
        if (patternSegments[i] === '*') captures.push(pathSegments[i]);
        else if (patternSegments[i] !== pathSegments[i]) return null;
    }
    return captures;
}

/** The find scope of a path (with or without parameters) */
export function findScope(path, scopes = FIND_SCOPES) {
    const pathSegments = segments(path);
    for (const entry of scopes) {
        for (const pattern of entry.paths) {
            const captures = matchPattern(pattern, pathSegments);
            if (captures) return entry.scope.replace(/\$(\d+)/g, (_, n) => captures[n - 1] ?? '');
        }
    }
    return pathSegments.join('/');
}

/** Whether a search on fromPath carries to toPath */
export function carriesSearch(fromPath, toPath, scopes = FIND_SCOPES) {
    if (!fromPath || !toPath) return false;
    return findScope(fromPath, scopes) === findScope(toPath, scopes);
}

/** Parameters without the search ones */
export function withoutSearch(params = {}) {
    const rest = { ...params };
    for (const key of SEARCH_PARAMS) delete rest[key];
    return rest;
}

/**
 * Note the search on a page as the one last left in its scope (an empty term forgets the scope's).
 * @param {Map<string, {term: string, at: number}>} memory
 */
export function rememberSearch(memory, path, term, now) {
    const scope = findScope(path);
    if (term && String(term).trim()) memory.set(scope, { term, at: now });
    else memory.delete(scope);
}

/** The search last left in a path's scope, if it was left less than SEARCH_MEMORY_MS ago */
export function recallSearch(memory, path, now) {
    const scope = findScope(path);
    const entry = memory.get(scope);
    if (!entry) return null;
    if (now - entry.at >= SEARCH_MEMORY_MS) {
        memory.delete(scope);
        return null;
    }
    return entry.term;
}
