/**
 * What the sign-in session and the code around it share: the session statuses and the one test
 * of what kind of failure a request ended in. Pure: no imports, no state.
 */

/** Where the sign-in session stands (AuthSession.state.status) */
export const AUTH_STATUS = Object.freeze({
    SIGNED_OUT: 'signed-out',  // nobody is signed in on this page
    ACTIVE: 'active',          // a valid token
    NEEDS_USER: 'needs-user'   // signed in, but only the user's click can get a new token
});

// A failed fetch: Chrome and Edge, Firefox, Safari (three wordings), Deno and Node
const FETCH_FAILED = /failed to fetch|networkerror when attempting to fetch|load failed|internet connection appears to be offline|network connection was lost|fetch failed/i;
// A write to a frozen object: V8 (assign, add, delete, define), SpiderMonkey, JavaScriptCore
const FROZEN_WRITE = /read only property|object is not extensible|cannot delete property|cannot redefine property|is read-only|can't define property|can't be deleted|can't redefine|readonly property|not extensible|unable to delete property/i;

/**
 * The kind of failure a request (or the session) ended in. Requests to Google's APIs and to the
 * sign-in service throw errors of the same shape: { status, result: { error: { code, status, message } } }.
 * - 'auth': the token is missing, expired or revoked. Renewing or signing in again fixes it.
 * - 'permission': the account may not do this (a sheet not shared, a scope not granted).
 * - 'quota': rate limit or quota. Waiting fixes it.
 * - 'network': no response at all: fetch's failure (a TypeError with one of the browsers' fetch
 *   messages), Google's API library's code -1 ("A network error occurred"), or a request that timed
 *   out (TimeoutError). Any other TypeError is a bug, never a network failure: it is 'other'.
 * - 'integrity': code tried to change a frozen cached value (caching.js freezes them). The write
 *   was blocked, so the cached data is intact; the code that tried it has a bug.
 * - 'other'
 * @param {*} err
 * @returns {'auth'|'permission'|'quota'|'network'|'integrity'|'other'}
 */
export function classifyError(err) {
    if (!err) return 'other';
    if (err.code === 'AUTH_REQUIRED') return 'auth';
    if (err instanceof TypeError && FROZEN_WRITE.test(err.message)) return 'integrity';
    if (err instanceof TypeError && !err.status && !err.result && FETCH_FAILED.test(err.message)) return 'network';
    if (err.name === 'TimeoutError') return 'network';
    if (err.status === -1 || err.result?.error?.code === -1) return 'network';
    const status = err.status ?? err.result?.error?.code;
    const apiStatus = err.result?.error?.status;
    const message = String(err.result?.error?.message || '').toLowerCase();
    if (status === 401 || apiStatus === 'UNAUTHENTICATED') return 'auth';
    if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED' || message.includes('rate limit') || message.includes('quota')) return 'quota';
    if (status === 403 || apiStatus === 'PERMISSION_DENIED') return 'permission';
    return 'other';
}

/** Whether signing in again (or renewing) would fix this failure */
export function isAuthError(err) {
    return classifyError(err) === 'auth';
}

/** Whether the request got no answer at all (no connection, or it timed out) */
export function isNetworkError(err) {
    return classifyError(err) === 'network';
}

/** Whether code tried to change a frozen cached value (the write was blocked) */
export function isIntegrityError(err) {
    return classifyError(err) === 'integrity';
}

/** An error with an HTTP status, shaped like the errors Google's API library throws */
export function requestError(message, status) {
    return Object.assign(new Error(message), { status, result: { error: { code: status, message } } });
}

/** The error a request gets when there is no token and none can be had without the user */
export function authRequiredError(message = 'Sign in to continue.') {
    const err = requestError(message, 401);
    err.code = 'AUTH_REQUIRED';
    err.result.error.status = 'UNAUTHENTICATED';
    return err;
}
