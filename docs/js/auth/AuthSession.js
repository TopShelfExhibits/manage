import { AUTH_STATUS, authRequiredError } from './authStatus.js';
import { SignInService } from './SignInService.js';
import { SignInWindow } from './SignInWindow.js';
import { networkState, onConnectionChange } from '../data_management/utils/networkState.js';

/**
 * The sign-in session: the one place that gets, keeps and renews access tokens, and decides
 * when the user is needed. It knows no provider and no data API:
 * - SignInWindow: the provider's sign-in page (Google), by redirect or popup.
 * - SignInService: the server that exchanges the provider's code for a session and renews
 *   tokens from it (the Apps Script broker today).
 * Requests take tokens only through getToken(). Background code never opens a window: getToken()
 * renews through the service, or throws AUTH_REQUIRED and the status tells the UI to ask the user.
 * On localhost, data_management/services.js swaps in fakes of both (FakeGoogle.js) and an
 * in-memory store; this code runs as it is. See docs/notes/auth-audit-findings.md.
 */

const SESSION_KEY = 'auth_session';         // the service's session, <id>.<secret>, replaced on every renewal
const TOKEN_KEY = 'gapi_token';             // the access token (name kept from earlier versions)
const EMAIL_KEY = 'last_email';             // the login hint; signing out forgets it
const CONSENTED_KEY = 'auth_service_used';  // this device signed in through the service (consent given)

const RENEW_LEAD_S = 600;    // renew this long before the token ends
const MIN_TOKEN_S = 60;      // a token with less left is renewed before it is used
const RETRY_MS = 60 * 1000;  // the service unreachable: try again after this

/** localStorage, shared by this browser's tabs; onChange hears the other tabs */
const browserStore = {
    get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: memory only */ } },
    remove: (key) => { try { localStorage.removeItem(key); } catch { /* nothing stored */ } },
    onChange: (listener) => window.addEventListener('storage', (event) => listener(event.key))
};

/** Seconds a token has left. Tokens saved by versions before expiresAt count 3500 s from timestamp. */
function secondsLeft(token) {
    const expiresAt = token?.expiresAt || (token?.timestamp ? token.timestamp + 3500 * 1000 : 0);
    return Math.max(0, (expiresAt - Date.now()) / 1000);
}

export class AuthSession {
    /** The session as the app sees it. Change it only through _set, which tells the listeners. */
    static state = {
        status: AUTH_STATUS.SIGNED_OUT,
        email: null,
        missingScopes: [],
        expiresAt: 0,
        // Why the status is needs-user: 'ended' (the service ended the session, or another tab
        // signed out), 'unavailable' (the service can't be reached; renewing retries by itself)
        reason: null,
        error: null      // the last sign-in failure, for the UI to show
    };
    static _service = SignInService;
    static _window = SignInWindow;
    static _store = browserStore;
    static _listeners = new Set();
    static _token = null;
    static _timer = null;
    static _renewPromise = null;
    // Ask for consent (when the provider hands out a refresh token) on this device's first sign-in
    // through the service, and whenever the service has no refresh token for the account
    static _needConsent = false;

    /** Swap the service, the sign-in window and the store (services.js: the fakes on localhost) */
    static use({ service, window, store }) {
        this._service = service;
        this._window = window;
        this._store = store;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /** @param {(state) => void} listener  @returns {() => void} unsubscribe */
    static onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    static _set(changes) {
        Object.assign(this.state, changes);
        this._listeners.forEach(listener => {
            try { listener(this.state); } catch (error) { console.error('[AuthSession] Listener failed:', error); }
        });
    }

    /** Whether requests can go out now */
    static isActive() {
        return this.state.status === AUTH_STATUS.ACTIVE;
    }

    /** The token the last request used, to tell a late 401 from a current one (handleUnauthorized) */
    static currentToken() {
        return this._token?.access_token || null;
    }

    // ── Start ─────────────────────────────────────────────────────────────────

    static async initialize() {
        if (!this._service.isConfigured()) {
            this._set({ error: 'Sign-in is not set up for this site (APP_CONFIG.AUTH_BROKER_URL is empty).' });
            return;
        }
        this._needConsent = !this._store.get(CONSENTED_KEY);
        this._store.onChange?.((key) => this._onStorage(key));
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this._checkClock(); });
        onConnectionChange((_, { reconnected }) => { if (reconnected) this._checkClock(); });

        // 1. A redirect sign-in that just came back
        const returned = this._window.takeRedirectResult();
        if (returned) {
            try {
                if (await this._finishSignIn(returned)) return;
            } catch (error) {
                this._set({ error: error.message });
            }
        }

        // 2. A token from earlier on this device that is still good
        const email = this._store.get(EMAIL_KEY);
        const token = this._storedToken();
        if (token && email && secondsLeft(token) > MIN_TOKEN_S) {
            this._useToken(token, email);
            return;
        }

        // 3. The service renews in the background: no window
        if (this._store.get(SESSION_KEY)) await this._renew();

        // 4. Still signed out, but someone signed in on this device before: ask the provider
        // without showing anything, once per tab. With a live provider session and the app
        // already allowed, the user comes straight back signed in; otherwise the page shows the
        // sign-in card. There's no unsaved work to lose on a page that is just loading.
        if (this.state.status === AUTH_STATUS.SIGNED_OUT && !returned && !this.state.error && email &&
            !networkState.isOffline && !this._window.silentTried()) {
            await this._window.open({ mode: 'redirect', silent: true, loginHint: email });   // never returns
        }
    }

    // ── Tokens for requests ───────────────────────────────────────────────────

    /**
     * A valid access token for a request. Renews through the service when the token is about to
     * end. Never opens a window: without a token it throws AUTH_REQUIRED, and the status says why.
     */
    static async getToken() {
        if (this.isActive() && secondsLeft(this._token) > MIN_TOKEN_S) return this._token.access_token;
        if (this.state.status !== AUTH_STATUS.SIGNED_OUT && await this._renew()) return this._token.access_token;
        if (this.isActive()) this._needsUser('ended');
        throw authRequiredError(this.state.status === AUTH_STATUS.SIGNED_OUT ? 'Sign in to continue.' : 'Sign in again to continue.');
    }

    /**
     * A request made with `usedToken` was refused as unauthorized. Returns whether a retry may
     * work: the token was already replaced, or the service renewed it.
     */
    static async handleUnauthorized(usedToken) {
        if (this._token && this._token.access_token !== usedToken) return true;
        this._token = null;
        // Forget the rejected token, so neither this tab nor another one takes it up again
        if (this._storedToken()?.access_token === usedToken) this._store.remove(TOKEN_KEY);
        if (await this._renew()) return true;
        if (this.isActive()) this._needsUser('ended');
        return false;
    }

    // ── User actions (call these from a click) ────────────────────────────────

    /** The header's sign-in: no window while the service still holds a session; else one redirect */
    static async signIn() {
        this._set({ error: null });
        if (this._store.get(SESSION_KEY) && await this._renew()) return true;
        return this._openSignIn('redirect');
    }

    /**
     * The session banner's button. It must run straight from the click: popups open only there.
     * Unreachable service: retry it (no window). Otherwise the provider's popup, which keeps
     * unsaved work.
     */
    static renew() {
        this._set({ error: null });
        if (this.state.reason === 'unavailable' && this._store.get(SESSION_KEY)) return this._renew();
        return this._openSignIn('popup');
    }

    static async signOut() {
        clearTimeout(this._timer);
        const session = this._store.get(SESSION_KEY);
        if (session) {
            try { await this._service.request({ action: 'signout', session }); } catch (error) { console.warn('[AuthSession] Sign-out at the service failed:', error); }
        }
        this._token = null;
        [SESSION_KEY, TOKEN_KEY, EMAIL_KEY].forEach(key => this._store.remove(key));
        this._set({ status: AUTH_STATUS.SIGNED_OUT, email: null, missingScopes: [], expiresAt: 0, reason: null });
    }

    // ── Session internals ─────────────────────────────────────────────────────

    static _storedToken() {
        try { return JSON.parse(this._store.get(TOKEN_KEY) || 'null'); } catch { return null; }
    }

    static _useToken(token, email) {
        this._token = token;
        this._set({
            status: AUTH_STATUS.ACTIVE,
            email: email || this.state.email,
            missingScopes: this._window.missingScopes(token.scope),
            expiresAt: Date.now() + secondsLeft(token) * 1000,
            reason: null,
            error: null
        });
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._checkClock(), Math.max(0, secondsLeft(token) - RENEW_LEAD_S) * 1000 + 50);
    }

    /** Only the user's click can get a new token now; their email and unsaved work stay */
    static _needsUser(reason) {
        this._token = null;
        this._set({ status: AUTH_STATUS.NEEDS_USER, reason });
    }

    /** Wake when the token needs renewing. Hidden tabs throttle timers, so also when the tab shows again. */
    static async _checkClock() {
        const unavailable = this.state.status === AUTH_STATUS.NEEDS_USER && this.state.reason === 'unavailable';
        if (!this.isActive() && !unavailable) return;
        const left = secondsLeft(this._token);
        if (!unavailable && left >= RENEW_LEAD_S) {
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this._checkClock(), (left - RENEW_LEAD_S) * 1000 + 50);
            return;
        }
        if (await this._renew() || !this.isActive() || this._store.get(SESSION_KEY)) return;
        // The service ended the session while the token has time left: it ends with the token
        clearTimeout(this._timer);
        if (left > MIN_TOKEN_S) this._timer = setTimeout(() => this._checkClock(), (left - MIN_TOKEN_S) * 1000);
        else this._needsUser('ended');
    }

    /** Another tab renewed, signed in or signed out */
    static _onStorage(key) {
        if (key !== TOKEN_KEY || this.state.status === AUTH_STATUS.SIGNED_OUT) return;
        const token = this._storedToken();
        if (token && token.access_token !== this._token?.access_token && secondsLeft(token) > MIN_TOKEN_S) {
            this._useToken(token, this._store.get(EMAIL_KEY));
        } else if (!token && !this._store.get(SESSION_KEY)) {
            // Signed out in another tab: keep this tab's work, and let its user sign in again
            this._needsUser('ended');
        }
    }

    /** Renew through the service, one renewal at a time across this page and other tabs */
    static _renew() {
        if (!this._store.get(SESSION_KEY)) return Promise.resolve(false);
        if (!this._renewPromise) {
            const run = () => this._renewOnce();
            this._renewPromise = (navigator.locks ? navigator.locks.request('tse-auth-renew', run) : run())
                .finally(() => { this._renewPromise = null; });
        }
        return this._renewPromise;
    }

    static async _renewOnce() {
        // Another tab may have renewed while this one waited for the lock
        const stored = this._storedToken();
        if (stored && stored.access_token !== this._token?.access_token && secondsLeft(stored) > RENEW_LEAD_S) {
            this._useToken(stored, this._store.get(EMAIL_KEY));
            return true;
        }
        const session = this._store.get(SESSION_KEY);
        if (!session) return false;
        try {
            this._acceptSession(await this._service.request({ action: 'refresh', session }));
            return true;
        } catch (error) {
            const signedIn = this.state.status !== AUTH_STATUS.SIGNED_OUT;
            const tokenLeft = secondsLeft(this._token) > MIN_TOKEN_S;
            if (error.refusal) {
                // The service ended the session (revoked, idle too long, or reused)
                console.warn('[AuthSession] The sign-in service ended the session:', error.refusal);
                this._store.remove(SESSION_KEY);
                if (error.refusal === 'NO_REFRESH_TOKEN' || error.refusal === 'GRANT_REVOKED') this._needConsent = true;
                if (signedIn && !tokenLeft) this._needsUser('ended');
            } else {
                console.warn('[AuthSession] Sign-in service unreachable, retrying in a minute:', error);
                clearTimeout(this._timer);
                this._timer = setTimeout(() => this._checkClock(), RETRY_MS);
                if (signedIn && !tokenLeft) this._needsUser('unavailable');
                else if (!signedIn) this._set({ error: 'Could not reach the sign-in service. Try signing in again in a moment.' });
            }
            return false;
        }
    }

    /** The service's answer to a sign-in or renewal: { session, accessToken, expiresIn, scope, email } */
    static _acceptSession(answer) {
        const now = Date.now();
        // timestamp: earlier versions read it, should a deploy be rolled back
        const token = { access_token: answer.accessToken, scope: answer.scope, timestamp: now, expiresAt: now + (Number(answer.expiresIn) || 3600) * 1000 };
        this._store.set(SESSION_KEY, answer.session);
        this._store.set(EMAIL_KEY, answer.email);
        this._store.set(CONSENTED_KEY, '1');
        this._store.set(TOKEN_KEY, JSON.stringify(token));
        this._needConsent = false;
        this._useToken(token, answer.email);
    }

    // ── Signing in ────────────────────────────────────────────────────────────

    /** The provider's sign-in, then the service's exchange. Returns whether it signed in. */
    static async _openSignIn(mode) {
        try {
            const answer = await this._window.open({ mode, consent: this._needConsent, loginHint: this._store.get(EMAIL_KEY) });
            return !!answer && await this._finishSignIn(answer);
        } catch (error) {
            this._set({ error: error.message });
            return false;
        }
    }

    /**
     * The provider's answer → the service exchanges the code → a session. Returns whether it
     * signed in; a silent attempt that the provider or the service turned down returns false
     * without an error, and the page shows the sign-in card.
     */
    static async _finishSignIn({ result, pending }) {
        if (!pending || result.state !== pending.state) throw new Error('Sign-in was interrupted. Please sign in again.');
        if (result.error) {
            if (pending.silent) return false;   // the provider needs the user (signed out there, or a new permission)
            throw new Error(result.error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed (${result.error}).`);
        }
        try {
            this._acceptSession(await this._service.request({ action: 'exchange', code: result.code, verifier: pending.verifier, redirectUri: pending.redirectUri }));
            return true;
        } catch (error) {
            if (error.refusal === 'NO_REFRESH_TOKEN') {
                // The service has no refresh token for this account yet: the provider gives one with consent
                this._needConsent = true;
                if (pending.silent) return false;   // the card's Log in asks for consent
                if (pending.consent) throw new Error('Google did not grant offline access. Please sign in again.');
                if (pending.mode === 'redirect') {
                    const again = await this._window.open({ mode: 'redirect', consent: true, loginHint: this._store.get(EMAIL_KEY) });
                    return !!again && this._finishSignIn(again);
                }
                throw new Error('One more step: click Sign in again to let the app stay signed in.');
            }
            if (error.refusal) throw error;   // refused, with the service's own message
            // No answer even after a retry; the provider's code is single-use, so it takes a new sign-in
            throw new Error(`Signing in didn't finish: ${error.message} Click Log in to try again.`);
        }
    }
}
