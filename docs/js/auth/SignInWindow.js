/**
 * The identity provider's sign-in page (Google): the one provider-specific part of signing in.
 *
 * It builds an OAuth 2 authorization request for a code (PKCE, and a state the page checks),
 * sends the user to the provider by a redirect (the page leaves and comes back) or a popup (the
 * page and its unsaved work stay), and brings the provider's answer back through
 * auth-callback.html. The sign-in service exchanges the code (AuthSession). Another provider
 * changes PROVIDER; a server that runs the OAuth flow itself replaces this file with a link to
 * its sign-in page.
 */

const PROVIDER = {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: window.APP_CONFIG?.CLIENT_ID,
    scopes: window.APP_CONFIG?.SCOPES || '',
    // offline: Google gives the service a refresh token. include_granted_scopes: incremental grants
    params: { access_type: 'offline', include_granted_scopes: 'true' },
    prompts: { silent: 'none', consent: 'consent', chooseAccount: 'select_account' }
};

const PENDING_KEY = 'auth_pending';       // sessionStorage: a redirect sign-in on its way to the provider
const RESULT_KEY = 'auth_result';         // sessionStorage: what auth-callback.html brought back
const SILENT_KEY = 'auth_silent_tried';   // sessionStorage: this tab already tried a sign-in without a click
const RELAY_CHANNEL = 'tse-auth';         // BroadcastChannel: auth-callback.html → the page, for a popup
const POPUP_WAIT_MS = 10 * 60 * 1000;
const POPUP_BLOCKED = 'The browser blocked the sign-in window. Allow pop-ups for this site, then try again.';

function _takeJson(key) {
    try {
        const value = JSON.parse(sessionStorage.getItem(key) || 'null');
        sessionStorage.removeItem(key);
        return value;
    } catch {
        return null;
    }
}

function _randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function _base64Url(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The provider sends the sign-in back here: the page beside the app's index.html */
function _callbackUrl() {
    return new URL('auth-callback.html', location.href.split('#')[0].split('?')[0]).href;
}

export class SignInWindow {
    static _cancelPopupWait = null;

    /** The scopes the app needs that a token's granted scope list lacks */
    static missingScopes(grantedScope) {
        const granted = String(grantedScope || '').split(' ');
        return PROVIDER.scopes.split(' ').filter(s => s && !granted.includes(s));
    }

    /** Whether this tab already tried a sign-in without a click (so a "no" can't loop) */
    static silentTried() {
        return !!sessionStorage.getItem(SILENT_KEY);
    }

    /** A redirect sign-in that just came back: { result, pending }, or null. Read once. */
    static takeRedirectResult() {
        const result = _takeJson(RESULT_KEY);
        const pending = _takeJson(PENDING_KEY);
        if (!result) return null;
        if (result.code) sessionStorage.removeItem(SILENT_KEY);
        return { result, pending };
    }

    /**
     * Open the provider's sign-in.
     * - 'redirect': the page leaves, and the promise never settles. The sign-in finishes in
     *   AuthSession.initialize when the page comes back (takeRedirectResult).
     * - 'popup': call it straight from a click (the window opens before the first await).
     *   Resolves { result, pending }, or null when the window was closed or timed out.
     * @param {{ mode: 'redirect'|'popup', consent?: boolean, silent?: boolean, loginHint?: string }} request
     *   consent: show the permissions page (the provider gives a refresh token only with it).
     *   silent: show nothing; the provider answers with an error when it needs the user.
     * @returns {Promise<{ result: { code?, state, error? }, pending: { mode, state, verifier, redirectUri, consent, silent } } | null>}
     */
    static async open({ mode, consent = false, silent = false, loginHint = null }) {
        const popup = mode === 'popup' ? window.open('', 'tse-sign-in', 'popup,width=500,height=650') : null;
        if (mode === 'popup' && !popup) throw new Error(POPUP_BLOCKED);

        const state = `${mode === 'popup' ? 'p' : 'r'}.${_randomString(32)}`;
        const verifier = _randomString(64);
        const challenge = _base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
        const pending = { mode, state, verifier, redirectUri: _callbackUrl(), consent: consent && !silent, silent };
        const params = new URLSearchParams({
            client_id: PROVIDER.clientId,
            redirect_uri: pending.redirectUri,
            response_type: 'code',
            scope: PROVIDER.scopes,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            ...PROVIDER.params
        });
        const prompt = silent ? PROVIDER.prompts.silent : consent ? PROVIDER.prompts.consent : loginHint ? null : PROVIDER.prompts.chooseAccount;
        if (prompt) params.set('prompt', prompt);
        if (loginHint) params.set('login_hint', loginHint);
        const url = `${PROVIDER.authorizeUrl}?${params}`;

        if (mode === 'popup') {
            popup.location.href = url;
            const result = await this._waitForPopup(state);
            return result && { result, pending };
        }
        if (silent) sessionStorage.setItem(SILENT_KEY, '1');
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending, returnUrl: location.href }));
        location.assign(url);
        return new Promise(() => {});   // the page is leaving
    }

    /** auth-callback.html, open in the popup, broadcasts the provider's answer to this page */
    static _waitForPopup(state) {
        this._cancelPopupWait?.();
        return new Promise((resolve) => {
            const channel = new BroadcastChannel(RELAY_CHANNEL);
            const finish = (result) => {
                clearTimeout(timer);
                channel.close();
                this._cancelPopupWait = null;
                resolve(result);
            };
            const timer = setTimeout(() => finish(null), POPUP_WAIT_MS);
            this._cancelPopupWait = () => finish(null);
            channel.onmessage = (event) => { if (event.data?.state === state) finish(event.data); };
        });
    }
}
