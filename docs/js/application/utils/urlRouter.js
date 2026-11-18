/**
 * URL Router - Synchronizes application navigation with browser URLs
 * Uses hash-based routing for compatibility with static hosting
 */
import { ApplicationUtils } from '../../data_management/index.js';
import { authState } from '../utils/auth.js';

// Pages that moved: an old path (and everything under it) opens the new one. Navigation
// (handleNavigateToPath: links, browser history) and stored dashboard cards (DashboardRegistry)
// go through redirectPath.
const PATH_REDIRECTS = {
    'reports/inventory-proposals': 'inventory/proposals'
};

/** A path with a moved page's old prefix replaced (PATH_REDIRECTS); parameters are kept */
export function redirectPath(path) {
    if (typeof path !== 'string') return path;
    for (const [from, to] of Object.entries(PATH_REDIRECTS)) {
        if (path.startsWith(from) && (path.length === from.length || '/?'.includes(path[from.length]))) {
            return to + path.slice(from.length);
        }
    }
    return path;
}

export class URLRouter {
    constructor(navigationRegistry, appContext) {
        this.navigationRegistry = navigationRegistry;
        this.appContext = appContext;
        this.isInitialized = false;
    }

    /**
     * Encode path for URL (replace spaces with +)
     */
    encodePath(path) {
        return path.replace(/ /g, '+');
    }

    /**
     * Decode path from URL (replace + with spaces)
     */
    decodePath(path) {
        return path.replace(/\+/g, ' ');
    }

    /**
     * Check if a hash is a short hash (starts with "go:")
     */
    static isShortHash(hash) {
        return typeof hash === 'string' && hash.startsWith('go:');
    }

    /**
     * Extract short code from hash (removes "go:" prefix)
     */
    static extractShortCode(hash) {
        if (!URLRouter.isShortHash(hash)) {
            return null;
        }
        return hash.slice(3); // Remove "go:" prefix
    }

    /**
     * Create a short hash URL from a path (async - calls ApplicationUtils)
     * @param {string} path - The full path to shorten
     * @returns {Promise<string>} The short hash format (e.g., "go:1gx")
     */
    static async createShortHash(path) {
        const shortCode = await ApplicationUtils.getShortLink(path);
        return `go:${shortCode}`;
    }

    /**
     * Decode a short hash back to the original path (async - calls ApplicationUtils)
     * @param {string} shortHash - The short hash to decode (e.g., "go:1gx")
     * @returns {Promise<string|null>} The full path, or null if not found
     */
    static async decodeShortHash(shortHash) {
        const shortCode = URLRouter.extractShortCode(shortHash);
        if (!shortCode) {
            return null;
        }
        return await ApplicationUtils.expandShortLink(shortCode);
    }

    /**
     * Initialize URL routing system
     */
    initialize() {
        
        // Listen for browser back/forward
        window.addEventListener('popstate', this.handlePopState.bind(this));
        
        this.isInitialized = true;
    }

    /**
     * Get current URL path (sync, no short hash expansion).
     * Safe to call before authentication.
     */
    getCurrentURLPath() {
        const hash = window.location.hash.slice(1); // Remove #
        return this.decodePath(hash);
    }

    /**
     * Check if a path is an unresolved short hash.
     */
    isShortPath(path) {
        return URLRouter.isShortHash(path);
    }

    /**
     * Resolve the current URL path, expanding short hashes if present.
     * Must only be called after authentication.
     * @returns {Promise<string|null>} The full path, or null if short hash could not be resolved.
     */
    async resolvePathFromURL() {
        const hash = window.location.hash.slice(1); // Remove #

        // Don't try to expand short hashes if not authenticated
        if (URLRouter.isShortHash(hash)) {
            if (!authState.isAuthenticated) {
                //console.warn('[URLRouter] Cannot resolve short hash - not authenticated');
                return null;
            }
            
            const decodedPath = await URLRouter.decodeShortHash(hash);
            if (decodedPath) {
                // Replace the short hash in the URL with the full path silently
                const encodedPath = this.encodePath(decodedPath);
                history.replaceState({ path: decodedPath }, '', `#${encodedPath}`);
                return decodedPath;
            }
            // Short code not found in Links table
            return null;
        }

        return this.decodePath(hash);
    }

    /**
     * Handle browser back/forward buttons
     */
    async handlePopState(event) {
        const path = await this.resolvePathFromURL();
        if (path) {
            // Let NavigationSystem handle the actual navigation, mark as browser navigation
            await this.navigationRegistry.handleNavigateToPath({ 
                targetPath: path, 
                isBrowserNavigation: true 
            }, this.appContext);
        }
    }

    /**
     * Update URL from application navigation
     */
    updateURL(path, pushToHistory = true) {
        if (!this.isInitialized) return;
        
        try {
            const fullPath = path || this.getCurrentPath();
            const encodedPath = this.encodePath(fullPath);
            const url = `#${encodedPath}`;
            
            if (pushToHistory) {
                history.pushState({ path: fullPath }, '', url);
            } else {
                history.replaceState({ path: fullPath }, '', url);
            }
        } catch (error) {
            console.error('[URLRouter] Error updating URL:', error);
        }
    }

    /**
     * Get current path from app context
     */
    getCurrentPath() {
        return this.appContext.currentPath || 'dashboard';
    }
}
