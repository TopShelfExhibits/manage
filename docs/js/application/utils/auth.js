// Dynamically select GoogleSheetsAuth based on environment
import { isLocalhost } from '../../data_management/utils/helpers.js';
let GoogleSheetsAuth;
if (isLocalhost()) {
    // eslint-disable-next-line no-undef
    ({ GoogleSheetsAuth } = await import('../../google_sheets_services/FakeGoogle.js'));
} else {
    // eslint-disable-next-line no-undef
    ({ GoogleSheetsAuth } = await import('../../google_sheets_services/index.js'));
}

/**
 * Reactive authentication state
 */
export const authState = Vue.reactive({
    isAuthenticated: false,
    isLoading: false,
    user: null,
    error: null,
    isInitialized: false,
    permissionsWarning: null,
    isOffline: !navigator.onLine
});

// Import DashboardRegistry for cleanup on logout
import { DashboardRegistry } from './DashboardRegistry.js';
import { reloadErrorStores } from './reactiveStores.js';
import { restartCacheTimestampPoller, clearCache } from '../../data_management/utils/caching.js';
import { networkState } from '../../data_management/utils/networkState.js';

// Import modalManager for re-authentication prompts
let modalManager;
// Lazy load to avoid circular dependency
async function getModalManager() {
    if (!modalManager) {
        const module = await import('../components/interface/modalComponent.js');
        modalManager = module.modalManager;
    }
    return modalManager;
}

// Track if auth prompt is already showing to prevent multiple modals
let authPromptShowing = false;

/**
 * Test mode email override (for development/testing only)
 */
let testModeEmail = null;

/**
 * Simplified authentication utility class that wraps GoogleSheetsAuth
 */
export class Auth {
    static _loginPromise = null;
    static _cancelLogin = null;
    static _proactiveRefreshTimer = null;
    static _sessionExpiryTimer = null;
    static _proactiveInteractionHandler = null;
    static async initialize() {
        Auth._startNetworkMonitoring();
        Auth._registerPermissionErrorHandler();
        // Sync initial state in case page loaded while offline
        networkState.isOffline = !navigator.onLine;
        authState.isOffline = !navigator.onLine;
        authState.isLoading = true;
        authState.error = null;
        try {
            await GoogleSheetsAuth.initialize();
            // Check if user is already authenticated
            const isAuth = await GoogleSheetsAuth.checkAuth();
            if (isAuth) {
                let email = testModeEmail || await GoogleSheetsAuth.getUserEmail();
                authState.user = { email, name: email?.split('@')[0] || 'User' };
                authState.isAuthenticated = true;
                authState.permissionsWarning = Auth._buildPermissionsWarning();
                Auth._startProactiveRefreshTimer();
            }
            authState.isInitialized = true;
        } catch (error) {
            console.error('Auth initialization failed:', error);
            authState.error = error.message;
        } finally {
            authState.isLoading = false;
        }
    }

    static async login() {
        // Cancel any previous login attempt to ensure fresh start
        if (this._loginPromise && this._cancelLogin) {
            console.log('[Auth.login] Canceling previous login attempt');
            this._cancelLogin();
        }

        this._loginPromise = this._loginInternal()
            .finally(() => {
                this._loginPromise = null;
                this._cancelLogin = null;
            });

        return this._loginPromise;
    }

    static async _loginInternal() {
        authState.isLoading = true;
        authState.error = null;
        
        try {
            await Auth._authenticateWithPopupWarning();
            
            let email = testModeEmail || await GoogleSheetsAuth.getUserEmail();
            if (!email || email.length === 0) {
                throw new Error('Failed to retrieve user email');
            }

            authState.user = { email, name: email?.split('@')[0] || 'User' };
            authState.isAuthenticated = true;
            authState.permissionsWarning = Auth._buildPermissionsWarning();
            Auth._startProactiveRefreshTimer();
            
            // Re-enable priority queue if it was disabled during token expiry
            const { PriorityQueue } = await import('./priorityQueue.js');
            PriorityQueue.enable();

            // Reload any stores that failed during token expiry
            // Note: After logout, page is refreshed so this only applies to token refresh scenarios
            reloadErrorStores();

            // Restart the cache timestamp poller if it was paused due to auth expiry
            restartCacheTimestampPoller();
            
            return true;
        } catch (error) {
            console.error('Login failed:', error);
            authState.error = error.message;
            authState.isAuthenticated = false;
            authState.user = null;
            return false;
        } finally {
            authState.isLoading = false;
        }
    }

    static async logout() {
        //console.log('[Auth] Logout initiated');
        authState.isLoading = true;
        authState.error = null;
        authPromptShowing = false; // Clear any auth prompts immediately
        Auth._clearProactiveRefreshTimer();

        try {
            // Try to save data if token is valid and all permissions are granted
            const tokenValid = GoogleSheetsAuth.isAuthenticated();
            
            if (tokenValid && !authState.permissionsWarning) {
                //console.log('[Auth] Token still valid, attempting to save data before logout...');
                const manager = await getModalManager();
                
                let saveCompleted = false;
                let savingModal = null;
                let abortSave;
                const abortSavePromise = new Promise((_, reject) => {
                    abortSave = () => reject(new Error('Save canceled by user'));
                });
                
                // Set up a timer to show modal only if save takes longer than 3 seconds
                const modalTimer = setTimeout(() => {
                    if (!saveCompleted) {
                        savingModal = manager.confirm(
                            'Backing up your unsaved changes...',
                            null, // No confirm button
                            () => {
                                // User clicked cancel - abort the save and continue with logout
                                //console.log('[Auth] User canceled save during logout');
                                abortSave();
                            },
                            'Saving Changes',
                            null, // No confirm button
                            'Cancel and logout'
                        );
                    }
                }, 3000);
                
                try {
                    // Race the save against the user's cancel action
                    await Promise.race([this._saveDataBeforeLogout(), abortSavePromise]);
                    saveCompleted = true;
                    //console.log('[Auth] Data saved successfully before logout');
                } catch (saveError) {
                    console.warn('[Auth] Save failed during logout, continuing anyway:', saveError);
                }
                
                // Clear the timer if save completed quickly
                clearTimeout(modalTimer);
                
                // Remove the modal if it was shown
                if (savingModal) {
                    manager.removeModal(savingModal.id);
                }
            } else if (authState.permissionsWarning) {
                //console.log('[Auth] Missing permissions, skipping save during logout');
            } else {
                //console.log('[Auth] Token expired, skipping save during logout');
            }
            
            // Proceed with unconditional cleanup
            DashboardRegistry.cleanup();
            
            await GoogleSheetsAuth.logout();
            
            // Simplified logout: refresh the page instead of complex store clearing
            // This ensures a clean slate with all components properly re-initialized
            console.log('[Auth] Logout completed, reloading page for clean state...');
            window.location.reload();
        } catch (error) {
            console.error('[Auth] Logout error:', error);
            // Even on error, reload to ensure clean state
            window.location.reload();
        }
    }

    /**
     * Internal method to save data before logout
     * This method NEVER checks auth to avoid circular dependencies
     */
    static async _saveDataBeforeLogout() {
        // Save dashboard
        await DashboardRegistry.saveNow();
        
        // Import and call save function with skipAuthCheck flag
        const { saveDirtyStoresToUserData } = await import('./reactiveStores.js');
        await saveDirtyStoresToUserData({ skipAuthCheck: true });
    }

    static async checkAuth() {
        if (!authState.isInitialized) {
            await this.initialize();
        }
        return GoogleSheetsAuth.checkAuth();
    }

    /**
     * Check authentication and prompt for re-authentication if needed
     * @param {Object} options - Configuration options
     * @param {string} options.context - Context description for the modal (e.g., "auto-save", "data operation")
     * @param {string} options.message - Custom message to show in the modal (optional)
     * @param {boolean} options.showModal - Whether to show re-authentication modal (default: true)
     * @returns {Promise<boolean>} True if authenticated, false otherwise
     */
    static async checkAuthWithPrompt(options = {}) {
        const {
            context = 'operation',
            message = null,
            showModal = true
        } = options;

        try {
            const isAuthenticated = await this.checkAuth();

            // Layer 1: Token is valid — check if expiring within 10 minutes.
            // We're in a user-gesture context so requestAccessToken won't be blocked.
            // Fire-and-forget: don't hold up the current action while refreshing.
            if (isAuthenticated) {
                if (GoogleSheetsAuth.getTokenSecondsRemaining() < 600) {
                    GoogleSheetsAuth.silentRefresh().then(success => {
                        if (success) {
                            //console.log('[Auth] Proactive token renewal succeeded');
                            Auth._startProactiveRefreshTimer();
                        }
                    });
                }
                return true;
            }

            if (!showModal) return false;

            const waitedForAuthentication = await this._waitForPendingAuthentication();
            if (waitedForAuthentication) {
                const isAuthenticatedAfterWait = await this.checkAuth();
                if (isAuthenticatedAfterWait) {
                    return true;
                }
            }

            // Layer 2 / 3: Token expired — show modal.
            // The modal button is a guaranteed user gesture:
            //   Layer 2: silentRefresh() works  → no popup, session renewed silently.
            //   Layer 3: silentRefresh() fails  → Auth.login() opens the full Google popup.
            if (authPromptShowing) {
                //console.log(`[Auth] Auth prompt already showing, returning false`);
                return false;
            }

            //console.warn(`[Auth] Authentication check failed for ${context}`);
            authPromptShowing = true;
            // Remove proactive interaction handler so it doesn't interfere with modal interactions
            this._removeProactiveInteractionHandler();
            const manager = await getModalManager();

            return new Promise((resolve) => {
                const defaultMessage = `Stay logged in?`;
                let modalDismissed = false;

                const modal = manager.confirm(
                    message || defaultMessage,
                    async () => {
                        modalDismissed = true;
                        try {
                            // Layer 2: try silent refresh inside the button click gesture
                            //console.log(`[Auth] Attempting silent refresh for ${context}...`);
                            const refreshed = await GoogleSheetsAuth.silentRefresh();
                            if (refreshed) {
                                // Clear stale cache before reloading so date-sensitive
                                // queries re-run against today's date
                                clearCache();
                                reloadErrorStores();
                                
                                // Restart the cache timestamp poller if it was stopped due to auth expiry
                                restartCacheTimestampPoller();
                                
                                //console.log(`[Auth] Silent refresh succeeded for ${context}`);
                                resolve(true);
                                return;
                            }

                            // Layer 3: Google session gone — open full login popup
                            //console.log(`[Auth] Silent refresh failed, opening login for ${context}...`);
                            const success = await Auth.login();
                            if (success) {
                                //console.log(`[Auth] Re-authentication successful for ${context}`);
                                resolve(true);
                            } else {
                                //console.error(`[Auth] Re-authentication failed for ${context}`);
                                await Auth._showAuthErrorModal('Authentication Failed', 'Re-authentication failed. Please log in manually.');
                                resolve(false);
                            }
                        } catch (error) {
                            //console.error(`[Auth] Re-authentication error for ${context}:`, error);
                            await Auth._showAuthErrorModal('Authentication Error', 'Re-authentication failed: ' + error.message);
                            resolve(false);
                        } finally {
                            authPromptShowing = false;
                        }
                    },
                    () => {
                        modalDismissed = true;
                        //console.log(`[Auth] User declined re-authentication for ${context}, logging out`);
                        authPromptShowing = false;
                        Auth.logout();
                        resolve(false);
                    },
                    'Session Expired',
                    'Log In',
                    'Log Out'
                );

                // Watch for modal dismissal via X button or overlay click
                const checkModalDismissed = setInterval(() => {
                    if (!manager.modals.find(m => m.id === modal.id)) {
                        clearInterval(checkModalDismissed);
                        if (!modalDismissed) {
                            //console.log(`[Auth] Auth modal dismissed without action, logging out`);
                            authPromptShowing = false;
                            Auth.logout();
                            resolve(false);
                        }
                    }
                }, 100);
            }).finally(() => {
                authPromptShowing = false;
            });

        } catch (error) {
            console.error(`[Auth] Auth check error for ${context}:`, error);
            authPromptShowing = false;
            return false;
        }
    }

    static get state() {
        return authState;
    }

    /**
     * Check if auth prompt is currently showing
     */
    static get authPromptShowing() {
        return authPromptShowing;
    }


    static _buildPermissionsWarning() {
        const missing = GoogleSheetsAuth.getMissingScopes();
        if (missing.length === 0) return null;
        const names = missing.map(s => s.split('/').pop()).join(', ');
        return `Please log out and back in making sure to grant all requested permissions in the popup: ${names}.`;
    }

    static _startNetworkMonitoring() {
        window.addEventListener('offline', () => {
            console.warn('[Auth] Network offline detected');
            networkState.isOffline = true;
            authState.isOffline = true;
        });
        window.addEventListener('online', () => {
            console.log('[Auth] Network online — resuming operations');
            networkState.isOffline = false;
            authState.isOffline = false;
            // Reload any stores that errored during the outage
            reloadErrorStores();
        });
    }

    /**
     * Register a handler with PriorityQueue that triggers re-authentication when a
     * 401/403 API error is detected. The PriorityQueue debounces this to one call per
     * 5-second window, so a burst of permission errors only shows one modal.
     */
    static _registerPermissionErrorHandler() {
        import('./priorityQueue.js').then(({ PriorityQueue }) => {
            PriorityQueue.setPermissionErrorHandler(async () => {
                // Don't pile on if a modal is already showing or we're already authenticated
                if (authPromptShowing) return;
                const isAuthenticated = await GoogleSheetsAuth.checkAuth();
                if (isAuthenticated) return;
                await Auth.checkAuthWithPrompt({ context: 'permission error' });
            });
        });
    }

    /**
     * Schedule a proactive token renewal that fires on the next user interaction
     * at 55 minutes (5 min before expiry). Triggered within a real user gesture so
     * browsers allow the GIS popup if one is needed.
     */
    static _startProactiveRefreshTimer() {
        this._clearProactiveRefreshTimer();

        const secondsRemaining = GoogleSheetsAuth.getTokenSecondsRemaining();
        if (secondsRemaining <= 0) return;

        // Fire 5 minutes before expiry to register interaction handler for silent refresh
        const refreshInMs = Math.max(0, secondsRemaining - 300) * 1000;

        this._proactiveRefreshTimer = setTimeout(() => {
            this._registerProactiveInteractionHandler();
        }, refreshInMs);

        // Fire at token expiry to proactively show the session timeout modal
        this._sessionExpiryTimer = setTimeout(async () => {
            if (document.hidden) {
                // Tab inactive: skip checkAuth (which calls silentRefresh and may show a Google popup).
                // The application modal is safe to show while hidden — it waits in the DOM for the user.
                if (GoogleSheetsAuth.getTokenSecondsRemaining() <= 0 && !authPromptShowing) {
                    this.checkAuthWithPrompt({ context: 'session expiry' });
                }
                // Fallback for when the browser throttled JS and the timer fired late
                const onVisible = async () => {
                    if (document.visibilityState !== 'visible') return;
                    document.removeEventListener('visibilitychange', onVisible);
                    if (!authPromptShowing) {
                        const stillExpired = !(await GoogleSheetsAuth.checkAuth());
                        if (stillExpired) await this.checkAuthWithPrompt({ context: 'session expiry' });
                    }
                };
                document.addEventListener('visibilitychange', onVisible);
            } else {
                const isStillAuthenticated = await GoogleSheetsAuth.checkAuth();
                if (!isStillAuthenticated && !authPromptShowing) {
                    await this.checkAuthWithPrompt({ context: 'session expiry' });
                }
            }
        }, secondsRemaining * 1000);
    }

    static _clearProactiveRefreshTimer() {
        if (this._proactiveRefreshTimer) {
            clearTimeout(this._proactiveRefreshTimer);
            this._proactiveRefreshTimer = null;
        }
        if (this._sessionExpiryTimer) {
            clearTimeout(this._sessionExpiryTimer);
            this._sessionExpiryTimer = null;
        }
        this._removeProactiveInteractionHandler();
    }

    static _registerProactiveInteractionHandler() {
        this._removeProactiveInteractionHandler();

        const handler = () => {
            this._removeProactiveInteractionHandler();
            // Don't attempt refresh if auth modal is already showing
            if (authPromptShowing) return;
            GoogleSheetsAuth.silentRefresh().then(success => {
                if (success) {
                    console.log('[Auth] Proactive token renewal succeeded');
                    this._startProactiveRefreshTimer();
                    // Restart the cache timestamp poller if it was stopped due to auth expiry
                    restartCacheTimestampPoller();
                }
                // If failed, natural expiry flow (checkAuthWithPrompt) handles re-login
            });
        };

        this._proactiveInteractionHandler = handler;
        document.addEventListener('click', handler, { capture: true });
        document.addEventListener('keydown', handler, { capture: true });
    }

    static _removeProactiveInteractionHandler() {
        if (this._proactiveInteractionHandler) {
            document.removeEventListener('click', this._proactiveInteractionHandler, { capture: true });
            document.removeEventListener('keydown', this._proactiveInteractionHandler, { capture: true });
            this._proactiveInteractionHandler = null;
        }
    }

    static async _waitForPendingAuthentication(options = {}) {
        const excludedPromises = new Set((options.excludePromises || []).filter(Boolean));

        if (!this._loginPromise || excludedPromises.has(this._loginPromise)) {
            return false;
        }

        //console.log('[Auth] Waiting for in-flight authentication before showing modal');
        await Promise.allSettled([this._loginPromise]);
        return true;
    }

    static async _showAuthErrorModal(title, message) {
        const waitedForAuthentication = await this._waitForPendingAuthentication();
        if (waitedForAuthentication) {
            const isAuthenticated = await this.checkAuth();
            if (isAuthenticated) {
                return;
            }
        }

        const manager = await getModalManager();
        manager.error(message, title);
    }

    static async _authenticateWithPopupWarning() {
        const manager = await getModalManager();
        let warningModal = null;
        let warningTimer = null;
        let dismissalChecker = null;
        let authCompleted = false;

        const clearWarning = () => {
            clearTimeout(warningTimer);
            clearInterval(dismissalChecker);
            if (warningModal) { 
                manager.removeModal(warningModal.id); 
                warningModal = null; 
            }
        };

        // Store cancel function so login() can cancel this entire flow
        this._cancelLogin = () => {
            if (!authCompleted) {
                authCompleted = true;
                clearWarning();
                console.log('[Auth] Login flow cancelled by new attempt');
            }
        };

        return new Promise((resolve, reject) => {
            let modalDismissed = false;

            warningTimer = setTimeout(() => {
                // If auth hasn't completed after 4 seconds, show warning modal
                if (!authCompleted) {
                    warningModal = manager.confirm(
                        "A Google sign-in popup should be visible. \n \n If you don't see it, please check your browser's popup blocker settings and try again.",
                        async () => {
                            // User clicked "Retry Login"
                            modalDismissed = true;
                            clearWarning();
                            
                            // Start a completely fresh login attempt
                            try {
                                const result = await Auth.login();
                                if (result) {
                                    resolve(true);
                                } else {
                                    reject(new Error('Login failed'));
                                }
                            } catch (err) {
                                reject(err);
                            }
                        },
                        () => {
                            // User clicked "Cancel" - clean up and reject
                            modalDismissed = true;
                            authCompleted = true;
                            clearWarning();
                            reject(new Error('Login canceled'));
                        },
                        'Sign In',
                        'Retry Login',
                        'Cancel'
                    );

                    // Watch for modal dismissal via X button, Escape, or clicking outside
                    dismissalChecker = setInterval(() => {
                        if (warningModal && !manager.modals.find(m => m.id === warningModal.id)) {
                            clearInterval(dismissalChecker);
                            dismissalChecker = null;
                            if (!modalDismissed) {
                                // Modal was dismissed without clicking a button - treat as cancel
                                authCompleted = true;
                                clearWarning();
                                reject(new Error('Login canceled'));
                            }
                        }
                    }, 100);
                }
            }, 4000);

            const authAttemptPromise = GoogleSheetsAuth.authenticate();
            authAttemptPromise
                .then((result) => { 
                    authCompleted = true;
                    clearWarning(); 
                    resolve(result); 
                })
                .catch((err) => { 
                    authCompleted = true;
                    clearWarning(); 
                    reject(err); 
                });
        });
    }
}

/**
 * Returns a stable identifier for this browser/device profile.
 * Generated once using crypto.randomUUID() and persisted in localStorage.
 * Survives browser restarts. Clearing localStorage or using incognito produces a new ID,
 * which is safe — it will simply trigger the "Claim this device" banner rather than
 * silently releasing another session's lock.
 */
export function getDeviceId() {
    let id = localStorage.getItem('_tse_device_id');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('_tse_device_id', id);
    }
    return id;
}
