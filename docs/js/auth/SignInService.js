import { requestError } from './authStatus.js';

/**
 * The sign-in service: the app's one server (apps-script/auth-broker today). It holds the OAuth
 * client secret and each account's refresh token, hands out access tokens, and reads the company
 * Dropbox. This is its only client. A server that answers the same actions replaces the Apps
 * Script by changing APP_CONFIG.AUTH_BROKER_URL; nothing else in the app changes.
 *
 * Every call is a POST of a JSON body, sent as plain text (a simple request: Apps Script can't
 * answer a CORS preflight). Every answer is JSON: { ok: true, ... } or { ok: false, error, message? }.
 * - exchange { code, verifier, redirectUri }, refresh { session }, signout { session }: AuthSession
 * - dropbox_list { paths, recursive, token }, dropbox_link { path, token }: DropboxFiles
 * Setup and protocol notes: docs/notes/auth-audit-findings.md.
 */

const SERVICE_URL = window.APP_CONFIG?.AUTH_BROKER_URL || '';
const TIMEOUT_MS = 60 * 1000;   // Apps Script can take seconds to wake, and the network can be slow
const RETRY_MS = 2000;          // a session action with no readable answer is sent once more after this

export class SignInService {
    static isConfigured() {
        return !!SERVICE_URL;
    }

    /**
     * One call: the service's parsed answer, whether ok or a refusal. Throws when no readable
     * answer came back: fetch's TypeError or a TimeoutError (no connection), an HTTP error status,
     * or an error page in place of JSON (502). The errors classify like Google's (classifyError).
     */
    static async post(body) {
        if (!SERVICE_URL) throw requestError('The sign-in service is not set up for this site (APP_CONFIG.AUTH_BROKER_URL).', 503);
        const response = await fetch(SERVICE_URL, {
            method: 'POST',
            body: JSON.stringify(body),
            signal: AbortSignal.timeout?.(TIMEOUT_MS)
        });
        if (!response.ok) throw requestError(`The sign-in service answered ${response.status}.`, response.status);
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            // An Apps Script or Google error page (never a token), kept for diagnosis
            console.warn('[SignInService] The answer was not JSON:', text.slice(0, 300));
            throw requestError('The sign-in service sent something other than JSON.', 502);
        }
    }

    /**
     * A session action (exchange, refresh, signout): the answer when ok. A call with no readable
     * answer is sent once more: renewing twice is safe (the service repeats its answer for two
     * minutes), and a sign-in code the service already used comes back refused.
     * Throws an error with `refusal` (the service's error code) when the service refused. Any
     * other throw means it couldn't be reached; its own failure (SERVER_ERROR) counts as that.
     */
    static async request(body) {
        let answer;
        try {
            answer = await this.post(body);
        } catch (error) {
            console.warn(`[SignInService] ${body.action} failed (${error.name}: ${error.message}); trying once more`);
            await new Promise(resolve => setTimeout(resolve, RETRY_MS));
            try {
                answer = await this.post(body);
            } catch (retryError) {
                const timedOut = retryError.name === 'TimeoutError' || retryError.name === 'AbortError';
                throw new Error(timedOut ? 'The sign-in service took too long to answer.' : 'Could not reach the sign-in service.');
            }
        }
        if (answer.ok) return answer;
        const error = new Error(answer.message || answer.error || 'Sign-in refused');
        if (answer.error !== 'SERVER_ERROR') error.refusal = answer.error;
        throw error;
    }
}
