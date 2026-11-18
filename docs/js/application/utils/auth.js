// The sign-in session (js/auth/AuthSession.js; over fakes on localhost, set up by services.js). It
// owns every token and decides when the user is needed; this module mirrors it into authState for
// the UI and runs the user's actions. See docs/notes/auth-audit-findings.md.
import { AuthSession, AUTH_STATUS } from '../../data_management/services.js';
import { isLocalhost } from '../../data_management/utils/helpers.js';
import { DashboardRegistry } from './DashboardRegistry.js';
import { reloadErrorStores } from './reactiveStores.js';
import { restartCacheTimestampPoller } from '../../data_management/utils/caching.js';
import { networkState, onConnectionChange } from '../../data_management/utils/networkState.js';

export { AUTH_STATUS, isAuthError, isNetworkError, isIntegrityError } from '../../data_management/services.js';

/**
 * Reactive authentication state, mirrored from the session.
 * isAuthenticated: someone is signed in. Their token may still need renewing: status says where
 * the session stands (AUTH_STATUS), and reason why it needs the user. Pages stay up while it
 * does, so unsaved work is kept.
 */
export const authState = Vue.reactive({
    status: AUTH_STATUS.SIGNED_OUT,
    reason: null,
    isAuthenticated: false,
    isLoading: false,
    user: null,
    error: null,
    isInitialized: false,
    permissionsWarning: null,
    // The connection to Google (networkState.js): isOffline while offline or unreachable;
    // connection is the CONNECTION status; reconnecting while a probe is out
    isOffline: networkState.isOffline,
    connection: networkState.status,
    reconnecting: false
});

// Mirror the connection for the UI. Back online: stores whose load failed reload.
onConnectionChange((state, { reconnected }) => {
    authState.isOffline = state.isOffline;
    authState.connection = state.status;
    authState.reconnecting = state.reconnecting;
    if (reconnected) reloadErrorStores();
});

// TEMPORARY admin check, until a real admin system with permissions replaces it: a hand-kept
// list of usernames (the part of the email before @), plus the fake test user on localhost so
// admin-only UI can be tested. Pages use it only to show or hide admin-only buttons.
const TEMPORARY_ADMINS = ['dschwab'];

/** TEMPORARY (to be replaced by the admin system): whether the logged-in user is an admin. */
export function isTemporaryAdmin() {
    const name = String(authState.user?.email || '').split('@')[0];
    return !!name && (TEMPORARY_ADMINS.includes(name) || (isLocalhost() && name === 'test'));
}

// Import modalManager lazily to avoid a circular dependency
let modalManager;
async function getModalManager() {
    if (!modalManager) {
        const module = await import('../components/interface/modalComponent.js');
        modalManager = module.modalManager;
    }
    return modalManager;
}

function permissionsWarning(missing) {
    if (!missing?.length) return null;
    const names = missing.map(s => s.split('/').pop()).join(', ');
    return `Please log out and back in, and grant every permission Google asks for: ${names}.`;
}

/** The session changed: mirror it, and resume what paused while it wasn't active */
function syncFromSession(session) {
    const email = session.status === AUTH_STATUS.SIGNED_OUT ? null : session.email;
    if (authState.user?.email && email && email !== authState.user.email) {
        // Another account signed in on this page: start clean, as after a logout
        window.location.reload();
        return;
    }
    const wasActive = authState.status === AUTH_STATUS.ACTIVE;
    authState.status = session.status;
    authState.reason = session.reason;
    authState.error = session.error;
    authState.permissionsWarning = permissionsWarning(session.missingScopes);
    if (!email) authState.user = null;
    else if (authState.user?.email !== email) authState.user = { email, name: email.split('@')[0] || 'User' };
    authState.isAuthenticated = !!email;
    if (!wasActive && session.status === AUTH_STATUS.ACTIVE && authState.isInitialized) {
        reloadErrorStores();
        restartCacheTimestampPoller();
    }
}

export class Auth {
    static async initialize() {
        if (authState.isInitialized) return;
        authState.isLoading = true;
        AuthSession.onChange(syncFromSession);
        let failure = null;
        try {
            await AuthSession.initialize();
        } catch (error) {
            console.error('Auth initialization failed:', error);
            failure = error.message;
        }
        syncFromSession(AuthSession.state);
        if (failure) authState.error = failure;
        if (AuthSession.isActive()) restartCacheTimestampPoller();
        authState.isInitialized = true;
        authState.isLoading = false;
    }

    /** Whether requests can go out now (no renewal waiting on the user) */
    static get isActive() {
        return authState.status === AUTH_STATUS.ACTIVE;
    }

    /** The header's sign-in button: one redirect to Google and back (none while a session is held) */
    static async login() {
        authState.isLoading = true;
        try {
            return await AuthSession.signIn();
        } finally {
            authState.isLoading = false;
        }
    }

    /**
     * The session banner's button ("Sign in", "Try again"). Call it straight
     * from the click: a popup, when one is needed, may open only there. The page stays as it is.
     */
    static renew() {
        return AuthSession.renew();
    }

    static async logout() {
        authState.isLoading = true;
        authState.error = null;

        try {
            // Try to save data if token is valid and all permissions are granted
            if (AuthSession.isActive() && !authState.permissionsWarning) {
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
                            () => abortSave(), // Cancel: abort the save and continue with logout
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
                } catch (saveError) {
                    console.warn('[Auth] Save failed during logout, continuing anyway:', saveError);
                }

                clearTimeout(modalTimer);
                if (savingModal) manager.removeModal(savingModal.id);
            }

            DashboardRegistry.cleanup();
            await AuthSession.signOut();

            // Refresh the page instead of clearing stores: a clean slate with every component re-initialized
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
        await DashboardRegistry.saveNow();
        const { saveDirtyStoresToUserData } = await import('./reactiveStores.js');
        await saveDirtyStoresToUserData({ skipAuthCheck: true });
    }
}
