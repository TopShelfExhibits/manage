import { html } from '../index.js';
import { authState, Auth } from '../index.js';
import { URLRouter } from './urlRouter.js';
import { DashboardRegistry } from './DashboardRegistry.js';
import { parseSearchParameters } from '../../data_management/utils/helpers.js';

// Vue is available globally, destructure ref from it
const { ref } = Vue;

export const NavigationRegistry = {
    /**
     * Main navigation structure - initialized with only main sections
     * Child routes are registered dynamically by components
     */
    routes: {
        // Dashboard section
        dashboard: {
            path: 'dashboard',
            displayName: 'Dashboard',
            icon: 'dashboard',
            isMainSection: true,
            children: {}
        },

        // Inventory section
        inventory: {
            path: 'inventory',
            displayName: 'Inventory',
            icon: 'inventory_2',
            isMainSection: true,
            children: {}
        },

        // Packlist section
        packlist: {
            path: 'packlist',
            displayName: 'Packlists',
            icon: 'list_alt',
            isMainSection: true,
            children: {}
        },

        // Schedule section
        schedule: {
            path: 'schedule',
            displayName: 'Schedule',
            icon: 'event',
            isMainSection: true,
            children: {}
        },

        // Reports section
        reports: {
            path: 'reports',
            displayName: 'Reports',
            icon: 'assessment',
            isMainSection: true,
            children: {}
        }
    },

    // Dashboard registry
    dashboardRegistry: DashboardRegistry,

    // URL Router integration
    urlRouter: null,

    // Track route registration changes for reactivity using Vue ref
    // This is a ref so Vue components can properly track changes
    routeRegistrationVersion: ref(0),

    /**
     * Initialize dashboard registry
     */
    async initializeDashboard() {
        await this.dashboardRegistry.initialize();
    },

    /**
     * Initialize URL routing system
     */
    initializeURLRouting(appContext) {
        if (!this.urlRouter) {
            this.urlRouter = new URLRouter(this, appContext);
            this.urlRouter.initialize();
        }
    },

    /**
     * Register navigation routes for a section
     * @param {string} section - Main section (e.g., 'inventory')
     * @param {Object} navigationConfig - Navigation configuration
     * @param {Object} navigationConfig.routes - Route definitions
     */
    registerNavigation(section, navigationConfig) {
        if (!this.routes[section]) {
            console.warn(`NavigationRegistry: Cannot register routes for unknown section '${section}'`);
            return;
        }

        // Add routes to the section's children
        if (navigationConfig.routes) {
            Object.entries(navigationConfig.routes).forEach(([routeKey, routeConfig]) => {
                this.addDynamicRoute(section, routeKey, routeConfig);
            });
            
            // Increment version to notify watchers of route registration
            this.routeRegistrationVersion.value++;
        }
    },

    /**
     * Quick access to main navigation items (for primary nav bar)
     */
    get primaryNavigation() {
        return Object.entries(this.routes)
            .filter(([key, route]) => route.isMainSection)
            .map(([key, route]) => ({
                id: key,
                title: route.displayName,
                path: route.path,
                icon: route.icon
            }));
    },

    /**
     * Parse JSON segment from path
     * @param {string} jsonString - The JSON string from path
     * @returns {Object|null} Parsed JSON object or null
     */
    parseJsonPathSegment(jsonString) {
        if (!jsonString) return null;
        
        try {
            return JSON.parse(jsonString);
        } catch (e) {
            console.warn('[NavigationRegistry] Failed to parse JSON path segment:', e);
            return null;
        }
    },

    /**
     * Build JSON path segment from parameters
     * @param {Object} parameters - Parameters to encode as JSON
     * @returns {string} JSON string for path segment
     */
    buildJsonPathSegment(parameters) {
        if (!parameters || Object.keys(parameters).length === 0) return '';
        return JSON.stringify(parameters);
    },

    /**
     * Get route configuration by path
     * @param {string} path - The route path (e.g., 'inventory/<category>')
     * @returns {Object|null} Route configuration or null if not found
     */
    getRoute(path) {
        const pathSegments = path.split('/').filter(segment => segment.length > 0);
        
        if (pathSegments.length === 0) return null;
        
        let currentRoute = this.routes[pathSegments[0]];
        
        for (let i = 1; i < pathSegments.length && currentRoute?.children; i++) {
            currentRoute = currentRoute.children[pathSegments[i]];
        }
        
        return currentRoute || null;
    },

    /**
     * Parse path with parameters (supports JSON path segments)
     * @param {string} path - The path with potential JSON parameters (e.g., 'schedule?DCol1=Date&DVal1=0&DType1=after')
     * @returns {Object} Object with path, parameters, and route information
     */
    parsePath(path) {
        let cleanPath = path;
        let parameters = {};
        
        // Split on ? to separate route from parameters
        if (path.includes('?')) {
            const [pathPart, paramPart] = path.split('?');
            cleanPath = pathPart;
            
            if (paramPart) {
                // Decode URL-encoded parameter string
                const decodedParamPart = decodeURIComponent(paramPart);
                
                // Check if decoded paramPart is JSON
                if (decodedParamPart.startsWith('{') || decodedParamPart.startsWith('[')) {
                    const parsedJson = this.parseJsonPathSegment(decodedParamPart);
                    if (parsedJson) {
                        parameters = parsedJson;
                    }
                } else {
                    // Fallback: old query string format for backwards compatibility
                    const searchParams = new URLSearchParams(paramPart);
                    const flatParams = {};
                    for (const [key, value] of searchParams) {
                        // Try to parse boolean and number values
                        if (value === 'true') flatParams[key] = true;
                        else if (value === 'false') flatParams[key] = false;
                        else if (!isNaN(value) && !isNaN(parseFloat(value))) flatParams[key] = parseFloat(value);
                        else flatParams[key] = value;
                    }
                    
                    // Convert old DCol/Col format to new dateFilters/textFilters arrays
                    const converted = parseSearchParameters(flatParams);
                    
                    // Build new format parameters
                    if (converted.dateFilters && converted.dateFilters.length > 0) {
                        parameters.dateFilters = converted.dateFilters;
                    }
                    
                    // Convert searchParams object format to textFilters array
                    if (converted.searchParams && Object.keys(converted.searchParams).length > 0) {
                        // A column may hold a list of filters (same-column filters are kept together)
                        parameters.textFilters = Object.entries(converted.searchParams).flatMap(([column, data]) =>
                            (Array.isArray(data) ? data : [data]).map(d => ({ column, values: d.values, type: d.type })));
                    }
                    
                    // Preserve any other non-filter params that weren't converted
                    Object.keys(flatParams).forEach(key => {
                        if (!key.startsWith('DCol') && !key.startsWith('DVal') && !key.startsWith('DType') &&
                            !key.startsWith('Col') && !key.startsWith('Val') && !key.startsWith('Type')) {
                            parameters[key] = flatParams[key];
                        }
                    });
                    
                    //console.log('[NavigationRegistry] Converted legacy URL format:', {
                    //    flatParams,
                    //    converted: parameters
                    //});
                }
            }
        }
        
        const route = this.getRoute(cleanPath);
        
        return {
            path: cleanPath,
            fullPath: Object.keys(parameters).length > 0 ? path : cleanPath,
            parameters,
            route,
            hasParameters: Object.keys(parameters).length > 0
        };
    },

    /**
     * Build path with parameters as JSON segment
     * @param {string} path - The base path (may include existing JSON segment or query parameters)
     * @param {Object} parameters - Parameters to add/replace
     * @returns {string} Full path with JSON segment
     */
    buildPath(path, parameters = {}) {
        // Parse existing path to extract clean path and existing parameters
        const pathInfo = this.parsePath(path);
        const cleanPath = pathInfo.path;
        
        // Merge existing parameters with new ones (new ones take precedence)
        const mergedParameters = { ...pathInfo.parameters, ...parameters };
        
        // Return clean path if no parameters
        if (Object.keys(mergedParameters).length === 0) {
            return cleanPath;
        }
        
        // Build JSON segment
        const jsonSegment = this.buildJsonPathSegment(mergedParameters);
        
        return `${cleanPath}?${jsonSegment}`;
    },

    /**
     * Get navigation parameters from a path (parses query string)
     * @param {string} path - The path with potential parameters
     * @returns {Object} The parameters object
     */
    getNavigationParameters(path) {
        const pathInfo = this.parsePath(path);
        return pathInfo.parameters;
    },

    /**
     * Get parameters for a container, respecting context (dashboard vs regular navigation)
     * This is the preferred method for components to retrieve their parameters
     * @param {string} containerPath - The container's path
     * @param {string} currentPath - The app's current path (from appContext.currentPath)
     * @returns {Object} The parameters object for this container
     */
    getParametersForContainer(containerPath, currentPath) {
        if (!currentPath) return {};
        
        const currentCleanPath = currentPath.split('?')[0];
        const containerCleanPath = containerPath.split('?')[0];
        const isOnDashboard = currentCleanPath.split('/')[0] === 'dashboard';
        
        if (isOnDashboard) {
            // On dashboard: get parameters from dashboard registry
            const dashboardContainer = this.dashboardRegistry.getContainer(containerPath);
            if (dashboardContainer) {
                const containerFullPath = typeof dashboardContainer === 'string' 
                    ? dashboardContainer 
                    : dashboardContainer.path;
                return this.getNavigationParameters(containerFullPath);
            }
            return {};
        } else {
            // Not on dashboard: check if current path matches container path
            if (currentCleanPath === containerCleanPath) {
                return this.getNavigationParameters(currentPath);
            }
            return {};
        }
    },

    /**
     * Build path with updated parameters, preserving existing ones
     * Convenience method that gets current parameters and merges with new ones
     * Parameters with undefined, null, or empty string values are removed
     * @param {string} containerPath - The container's clean path
     * @param {string} currentPath - The app's current path (from appContext.currentPath)
     * @param {Object} newParams - Parameters to add/update (use undefined/null/'' to remove)
     * @returns {string} Full path with merged parameters
     */
    buildPathWithCurrentParams(containerPath, currentPath, newParams = {}) {
        const cleanPath = containerPath.split('?')[0];
        const currentParams = this.getParametersForContainer(containerPath, currentPath);
        
        // console.log('[NavigationRegistry] buildPathWithCurrentParams:', {
        //     cleanPath,
        //     currentParams,
        //     newParams
        // });
        
        const mergedParams = { ...currentParams, ...newParams };
        
        // Remove parameters with undefined, null, or empty string values
        const keysToRemove = [];
        Object.keys(mergedParams).forEach(key => {
            if (mergedParams[key] === undefined || mergedParams[key] === null || mergedParams[key] === '') {
                keysToRemove.push(key);
                delete mergedParams[key];
            }
        });
        
        // if (keysToRemove.length > 0) {
        //     console.log('[NavigationRegistry] Removed parameters:', keysToRemove);
        // }
        
        const finalPath = this.buildPath(cleanPath, mergedParams);
        //console.log('[NavigationRegistry] Built final path:', finalPath);
        
        // If we removed parameters, update caches immediately to prevent stale cached params from being reapplied
        if (keysToRemove.length > 0) {
            // Update route's lastParameters cache (for non-dashboard navigation)
            const route = this.getRoute(cleanPath);
            if (route) {
                route.lastParameters = Object.keys(mergedParams).length > 0 ? { ...mergedParams } : {};
                //console.log('[NavigationRegistry] Updated route cache after removing params:', route.lastParameters);
            }
            
            // Update dashboard registry cache (for dashboard navigation) - only if container exists on dashboard
            if (this.dashboardRegistry && this.dashboardRegistry.has(cleanPath)) {
                this.dashboardRegistry.updatePath(cleanPath, finalPath);
                //console.log('[NavigationRegistry] Updated dashboard cache after removing params');
            }
        }
        
        return finalPath;
    },

    /**
     * Get display name for a path
     * @param {string} path - The path to get display name for
     * @param {boolean} [preferDashboardTitle=false] - If true, prefer dashboardTitle over displayName
     * @returns {string} Display name or dashboard title
     */
    getDisplayName(path, preferDashboardTitle = false) {
        const cleanPath = path.split('?')[0];
        const route = this.getRoute(cleanPath);
        if (route) {
            if (preferDashboardTitle && route.dashboardTitle) {
                return route.dashboardTitle;
            }
            return route.displayName;
        }
        
        // Fallback: generate from last segment
        const segments = cleanPath.split('/').filter(segment => segment.length > 0);
        const lastSegment = segments[segments.length - 1];
        return lastSegment ? lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1) : 'Unknown';
    },



    /**
     * Add a dynamic route at runtime (useful for categories, etc.)
     * @param {string} parentPath - Parent path where to add the route
     * @param {string} routeKey - Key for the new route
     * @param {Object} routeConfig - Route configuration
     * @param {string} [routeConfig.displayName] - Display name for navigation
     * @param {string} [routeConfig.dashboardTitle] - Custom title for dashboard display
     * @param {string} [routeConfig.icon] - Icon for the route
     */
    addDynamicRoute(parentPath, routeKey, routeConfig) {
        const parentRoute = this.getRoute(parentPath);
        if (parentRoute) {
            if (!parentRoute.children) {
                parentRoute.children = {};
            }
            const routePath = `${parentPath}/${routeKey}`;
            if (parentRoute.children[routeKey]) {
                // Update existing route's information
                Object.assign(parentRoute.children[routeKey], {
                    path: routePath,
                    ...routeConfig
                });
            } else {
                // Add new route
                parentRoute.children[routeKey] = {
                    path: routePath,
                    ...routeConfig
                };
            }
            
            // Increment version to notify watchers of route registration
            this.routeRegistrationVersion.value++;
        }
    },

    /**
     * Get container type from path - consolidated logic
     * @param {string} path - The container path
     * @returns {string} Container type
     */
    getTypeFromPath(path) {
        // Strip query parameters before processing
        const cleanPath = path.split('?')[0];
        const segments = cleanPath.split('/').filter(segment => segment.length > 0);
        const firstSegment = segments[0];
        if (this.routes[firstSegment] && this.routes[firstSegment].isMainSection) {
            return firstSegment;
        }
        return segments[segments.length - 1];
    },

    /**
     * Navigation handlers - consolidated
     */
    async handleNavigateToPath(navigationData, appContext) {
        let { targetPath, isBrowserNavigation, replaceHistory } = navigationData;
        
        // Parse the target path to get the clean path
        let pathInfo = this.parsePath(targetPath);
        
        // Check if targetPath had explicit parameters (indicated by ? in the original path).
        // This distinguishes between: "path with explicit params" vs "path with no params specified".
        // When params are explicitly provided but then filtered to empty (e.g., searchTerm removed),
        // we should NOT auto-preserve searchTerm.
        const hadExplicitParams = targetPath.includes('?');
        
        // Special handling for inventory routes: preserve searchTerm from current path
        // ONLY if no explicit parameters were provided to this navigation call
        if (!hadExplicitParams && (!pathInfo.hasParameters || !pathInfo.parameters.searchTerm)) {
            const currentPathInfo = this.parsePath(appContext.currentPath || '');
            const isNavigatingToInventory = pathInfo.path.startsWith('inventory');
            const isComingFromInventory = currentPathInfo.path.startsWith('inventory');
            
            // If navigating within inventory space and current path has searchTerm, preserve it
            if (isNavigatingToInventory && isComingFromInventory && currentPathInfo.parameters.searchTerm) {
                pathInfo.parameters.searchTerm = currentPathInfo.parameters.searchTerm;
                pathInfo.hasParameters = true;
                targetPath = this.buildPath(pathInfo.path, pathInfo.parameters);
                pathInfo = this.parsePath(targetPath); // Re-parse with updated params
            }
        }
        
        // Apply cached parameters if no explicit parameters provided
        if (!pathInfo.hasParameters) {
            const route = this.getRoute(pathInfo.path);
            if (route?.lastParameters && Object.keys(route.lastParameters).length > 0) {
                // Build path with cached parameters
                targetPath = this.buildPath(pathInfo.path, route.lastParameters);
                pathInfo = this.parsePath(targetPath); // Re-parse with cached params
                //console.log('[NavigationRegistry] Applied cached parameters:', route.lastParameters);
            }
        }
        
        const currentPathInfo = this.parsePath(appContext.currentPath || '');
        
        // Check if we're navigating to the same base path (just parameter change)
        const isSameBasePath = pathInfo.path === currentPathInfo.path;
        
        // Check authentication - if not authenticated, just show prompt but don't block
        // Let data operations trigger reauth when they fail
        const isAuthenticated = await Auth.checkAuth();
        
        if (!isAuthenticated) {
            //console.log('[NavigationRegistry] Not authenticated, showing login prompt');
            
            // Show auth prompt (non-blocking - user can login when ready)
            Auth.checkAuthWithPrompt({
                context: 'navigation',
                message: 'Please log in to view content.'
            });
            
            // Still update path so user sees the auth prompt in context
            appContext.currentPath = pathInfo.fullPath;
            
            return { action: 'navigation_blocked', reason: 'not_authenticated' };
        }
        
        //console.log('[NavigationRegistry] Navigation to:', pathInfo.fullPath, isSameBasePath ? '(parameter change)' : '(new location)');
        
        // Update app state
        appContext.currentPath = pathInfo.fullPath;
        
        // Cache parameters for future navigation (only if not on dashboard)
        const isOnDashboard = pathInfo.path.split('/')[0] === 'dashboard';
        if (!isOnDashboard && pathInfo.hasParameters) {
            const route = this.getRoute(pathInfo.path);
            if (route) {
                route.lastParameters = { ...pathInfo.parameters };
                //console.log('[NavigationRegistry] Cached parameters for', pathInfo.path, ':', route.lastParameters);
            }
        }
        
        // Only close menu if navigating to a different base path
        if (!isSameBasePath) {
            appContext.isMenuOpen = false;
        }
        
        // Update URL if not browser navigation
        if (!isBrowserNavigation && this.urlRouter) {
            this.urlRouter.updateURL(pathInfo.fullPath, !replaceHistory);
        }
        
        return { 
            action: isSameBasePath ? 'parameter_change' : 'navigate', 
            path: pathInfo.fullPath, 
            parameters: pathInfo.parameters 
        };
    },

    /**
     * Update URL parameters without triggering full navigation
     * This is used for filter changes that should update the URL but not reload content
     * @param {string} basePath - The base path (without parameters)
     * @param {string} currentFullPath - The current full path (for dashboard detection)
     * @param {Object} newParams - The new parameters to apply
     */
    updatePathParametersSilently(basePath, currentFullPath, newParams) {
        const cleanPath = basePath.split('?')[0];
        const isOnDashboard = currentFullPath?.split('?')[0].split('/')[0] === 'dashboard';
        
        // Build new path with parameters
        const newPath = this.buildPathWithCurrentParams(cleanPath, currentFullPath, newParams);
        
        //console.log('[NavigationRegistry] Silently updating parameters:', { cleanPath, newPath, isOnDashboard });
        
        // Update URL without pushState ( using replaceState to avoid history pollution)
        if (this.urlRouter) {
            this.urlRouter.updateURL(newPath, false); // false = use replaceState
        }

        // Keep app state in sync with silent URL updates for non-dashboard navigation.
        // Without this, subsequent parameter merges can use stale currentPath and drop searchTerm.
        if (!isOnDashboard && this.urlRouter?.appContext) {
            this.urlRouter.appContext.currentPath = newPath;
        }
        
        // Cache parameters for this route
        const route = this.getRoute(cleanPath);
        if (route && newParams && Object.keys(newParams).length > 0) {
            route.lastParameters = { ...(route.lastParameters || {}), ...newParams };
            //console.log('[NavigationRegistry] Cached parameters for', cleanPath, ':', route.lastParameters);
        }
        
        // For dashboard, also update the stored container path (only if container exists on dashboard)
        if (isOnDashboard && this.dashboardRegistry.has(cleanPath)) {
            this.dashboardRegistry.updatePath(cleanPath, newPath);
        }
        
        return newPath;
    },

};