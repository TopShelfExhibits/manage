/**
 * URL Router - Synchronizes application navigation with browser URLs
 * Uses hash-based routing for compatibility with static hosting
 */
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
     * Initialize URL routing system
     */
    initialize() {
        
        // Listen for browser back/forward
        window.addEventListener('popstate', this.handlePopState.bind(this));
        
        this.isInitialized = true;
    }

    /**
     * Get current URL path (decoded)
     */
    getCurrentURLPath() {
        const hash = window.location.hash.slice(1); // Remove #
        return this.decodePath(hash);
    }

    /**
     * Handle browser back/forward buttons
     */
    async handlePopState(event) {
        const path = this.getCurrentURLPath();
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
