// Dynamically select GoogleSheetsAuth based on environment
import { isLocalhost } from '../../google_sheets_services/FakeGoogle.js';
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
    isInitialized: false
});

// Import DashboardRegistry for cleanup on logout
import { DashboardRegistry } from './DashboardRegistry.js';
import { clearAllReactiveStores } from './reactiveStores.js';

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
    static async initialize() {
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
        authState.isLoading = true;
        authState.error = null;
        
        try {
            await GoogleSheetsAuth.authenticate();
            
            let email = testModeEmail || await GoogleSheetsAuth.getUserEmail();
            if (!email || email.length === 0) {
                throw new Error('Failed to retrieve user email');
            }

            authState.user = { email, name: email?.split('@')[0] || 'User' };
            authState.isAuthenticated = true;
            
            // Re-enable priority queue if it was disabled during logout
            const { PriorityQueue } = await import('./priorityQueue.js');
            PriorityQueue.enable();
            
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
        console.log('[Auth] Logout initiated');
        authState.isLoading = true;
        authState.error = null;
        authPromptShowing = false; // Clear any auth prompts immediately

        try {
            // Try to save data if token is still valid, but don't block logout if it fails
            const tokenValid = GoogleSheetsAuth.isAuthenticated();
            
            if (tokenValid) {
                console.log('[Auth] Token still valid, attempting to save data before logout...');
                const manager = await getModalManager();
                
                let saveCompleted = false;
                let savingModal = null;
                
                // Set up a timer to show modal only if save takes longer than 3 seconds
                const modalTimer = setTimeout(() => {
                    if (!saveCompleted) {
                        savingModal = manager.confirm(
                            'Backing up your unsaved changes...',
                            null, // No confirm button
                            () => {
                                // User clicked cancel - continue with logout
                                console.log('[Auth] User canceled save during logout');
                            },
                            'Saving Changes',
                            null, // No confirm button
                            'Cancel and logout'
                        );
                    }
                }, 3000);
                
                try {
                    // Attempt to save
                    await this._saveDataBeforeLogout();
                    saveCompleted = true;
                    console.log('[Auth] Data saved successfully before logout');
                } catch (saveError) {
                    console.warn('[Auth] Save failed during logout, continuing anyway:', saveError);
                }
                
                // Clear the timer if save completed quickly
                clearTimeout(modalTimer);
                
                // Remove the modal if it was shown
                if (savingModal) {
                    manager.removeModal(savingModal.id);
                }
            } else {
                console.log('[Auth] Token expired, skipping save during logout');
            }
            
            // Proceed with unconditional cleanup
            DashboardRegistry.cleanup();
            
            // Disable priority queue to prevent restart from cache invalidations
            const { PriorityQueue } = await import('./priorityQueue.js');
            PriorityQueue.disable();
            
            // Clear all reactive stores without attempting to save (already tried above)
            await clearAllReactiveStores({ skipSave: true });
            
            await GoogleSheetsAuth.logout();
            
            // Clear auth state
            authState.isAuthenticated = false;
            authState.user = null;
            authState.error = null;
            authState.isInitialized = false;
            
            console.log('[Auth] Logout completed successfully');
        } catch (error) {
            console.error('[Auth] Logout error (non-fatal):', error);
            // Don't set authState.error - we're logging out anyway
            // Ensure auth state is cleared even if cleanup failed
            authState.isAuthenticated = false;
            authState.user = null;
            authState.isInitialized = false;
        } finally {
            authState.isLoading = false;
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
            // Check current auth state
            const isAuthenticated = await this.checkAuth();
            
            if (!isAuthenticated && showModal) {
                // If auth prompt is already showing, just return false immediately
                if (authPromptShowing) {
                    console.log(`[Auth] Auth prompt already showing, returning false`);
                    return false;
                }
                
                console.warn(`[Auth] Authentication check failed for ${context}`);
                
                authPromptShowing = true;
                const manager = await getModalManager();
                
                // Create promise that will be resolved by user action
                return new Promise((resolve) => {
                    const defaultMessage = `Your session has expired. Would you like to log in again to continue?`;
                    
                    let modalDismissed = false;
                    
                    const modal = manager.confirm(
                        message || defaultMessage,
                        async () => {
                            // User clicked "Log in"
                            modalDismissed = true;
                            try {
                                console.log(`[Auth] Attempting re-authentication for ${context}...`);
                                const success = await Auth.login();
                                
                                if (success) {
                                    console.log(`[Auth] Re-authentication successful for ${context}`);
                                    resolve(true);
                                } else {
                                    console.error(`[Auth] Re-authentication failed for ${context}`);
                                    manager.error('Re-authentication failed. Please log in manually.', 'Authentication Failed');
                                    resolve(false);
                                }
                            } catch (error) {
                                console.error(`[Auth] Re-authentication error for ${context}:`, error);
                                manager.error('Re-authentication failed: ' + error.message, 'Authentication Error');
                                resolve(false);
                            } finally {
                                authPromptShowing = false;
                            }
                        },
                        () => {
                            // User clicked "Cancel" - trigger logout
                            modalDismissed = true;
                            console.log(`[Auth] User declined re-authentication for ${context}, logging out`);
                            authPromptShowing = false;
                            Auth.logout();
                            resolve(false);
                        },
                        'Session Expired',
                        'Log In',
                        'Cancel'
                    );
                    
                    // Watch for modal dismissal (X button or overlay click)
                    const checkModalDismissed = setInterval(() => {
                        if (!manager.modals.find(m => m.id === modal.id)) {
                            clearInterval(checkModalDismissed);
                            if (!modalDismissed) {
                                // Modal was closed without clicking a button - trigger logout
                                console.log(`[Auth] Auth modal dismissed without action, logging out`);
                                authPromptShowing = false;
                                Auth.logout();
                                resolve(false);
                            }
                        }
                    }, 100);
                }).finally(() => {
                    // Ensure flag is always cleared, even if promise chain breaks
                    authPromptShowing = false;
                });
            }
            
            return isAuthenticated;
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

    /**
     * Set a test mode email override (for development/testing only)
     * This will make the application think the user is the specified email
     * without affecting actual authentication
     * @param {string|null} email - Email to use, or null to disable test mode
     */
    static setTestModeEmail(email) {
        if (email === null || email === undefined) {
            console.log('[Auth] Test mode disabled, using real user email');
            testModeEmail = null;
        } else {
            console.log(`[Auth] Test mode enabled, user email set to: ${email}`);
            testModeEmail = email;
        }
        
        // Update current auth state if user is already authenticated
        if (authState.isAuthenticated && authState.user) {
            const effectiveEmail = testModeEmail || authState.user.email;
            authState.user = {
                email: effectiveEmail,
                name: effectiveEmail?.split('@')[0] || 'User'
            };
            console.log('[Auth] User state updated with test email');
        }
    }

    /**
     * Get the current test mode email (if any)
     */
    static getTestModeEmail() {
        return testModeEmail;
    }
}

/**
 * Expose console function for easy testing
 * Usage: switchUser('test@example.com') or switchUser(null) to reset
 */
window.switchUser = function(email) {
    if (email === null || email === undefined || email === '') {
        Auth.setTestModeEmail(null);
        console.log('✅ Test mode disabled. Using real authenticated user.');
    } else {
        Auth.setTestModeEmail(email);
        console.log(`✅ Now testing as: ${email}`);
        console.log('💡 Note: This only affects the email returned by the app, not actual authentication.');
    }
    
    // Log current user state
    if (Auth.state.isAuthenticated && Auth.state.user) {
        console.log(`Current user state: ${Auth.state.user.email}`);
    } else {
        console.log('No user currently authenticated.');
    }
};
