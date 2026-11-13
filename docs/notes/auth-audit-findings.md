# Authentication: findings and options

Audit of the tinkering branch, 2026-11-05. It replaces the earlier audit: the 401 retry in `withExponentialBackoff` no longer opens a login popup, and `GoogleSheetsAuth.authenticate()` now cancels an in-flight attempt before it starts a new one.

The audit covers three goals:

1. Sign-in shouldn't open Google popups. A frame or one redirect that doesn't break app flow is preferred.
2. Keeping the token current shouldn't flash a popup, or it should flash one only in response to a click on the site.
3. All authentication lives in one place, and the app can still react to each kind of failure.

---

## Summary

- **The flashing popup comes from background code.** `GoogleSheetsAuth.checkAuth()` runs a "silent" refresh once the token has expired. That refresh opens a Google popup. Every Sheets call checks auth this way, including auto-save, the cache poller and page load, so the popup opens with no click behind it, even while the tab is hidden. When the browser allows popups for the site, the popup takes focus from other applications.
- **Google doesn't allow sign-in in a frame.** Google's sign-in pages refuse to load in an iframe, and the in-page "Sign in with Google" button proves who the user is but gives no Sheets access. Sign-in can work two ways: a popup, or one full-page redirect.
- **Without a server, a new token needs a popup or a redirect.** The browser-only flow the app uses has no refresh tokens. Each new one-hour token needs a popup (it closes itself when nothing needs approval) or a page redirect. The best that is possible without a server: the popup opens only when the user clicks "Stay signed in".
- **Renewing with no popup needs a small token server.** It holds a refresh token and hands the app new access tokens over `fetch`. That is the only way to meet goal 2 fully.
- **Auth is handled in about twelve places.** There are five different "is this an auth error?" tests, and four modules restart or pause other modules after a sign-in. One session module with one state would replace them. Both options below need it.

---

## Where auth is handled today

| Place | What it does |
| --- | --- |
| `google_sheets_services/GoogleSheetsAuth.js`: `BaseTokenManager` | Saves the token to `localStorage` (`gapi_token`, `last_email`). Treats the token as expired 3500 s after it was saved, ignoring `expires_in`. |
| `GoogleSheetsAuth.initialize / authenticate / silentRefresh / checkAuth / getUserEmail / logout` | Loads GIS and gapi. Sign-in popup. A "silent" refresh that is also a popup. `checkAuth` refreshes on expiry. Blocks refresh for the rest of the session after one failure (`_silentRefreshBlocked`). |
| `GoogleSheetsData.js`: about 15 methods | Each one calls `checkAuth()` first. Some throw when it fails, others ignore the result (`getSheetData` L185, `batchGetValues` L211). |
| `GoogleSheetsData.withExponentialBackoff` (L87–95) | Rethrows auth errors, and treats `PERMISSION_DENIED` (a sheet not shared) as one. |
| `application/utils/auth.js`: `Auth` | Holds `authState`. Login, with a "popup blocked?" modal after 4 s. Logout, with a save first. `checkAuthWithPrompt` shows the "Session Expired" modal. A refresh timer that hijacks the next click or keypress at 55 min. An expiry timer with its own visibility fallback. Network monitoring. Registers the PriorityQueue handler. Restarts the poller and reloads failed stores after sign-in. |
| `application/utils/priorityQueue.js` L298 | Calls the Auth handler on 401 or 403, at most once every 5 s. |
| `application/utils/reactiveStores.js` L567, L628 | Load and save catch 401 only and call `checkAuthWithPrompt`. |
| `reactiveStores.js` L1513 (auto-save, every interval, even in a hidden tab) | `Auth.checkAuth()`, which can refresh, which opens the popup. |
| `application/utils/navigationSystem.js` L497 | `checkAuth`, then `checkAuthWithPrompt("Please log in to view content.")`. |
| `data_management/abstraction/application-utils.js` L854 | `readCacheTimestamps` calls `GoogleSheetsAuth.checkAuth()` directly and returns `null` to pause the poller. |
| `data_management/utils/caching.js` L1232 | Poller: its own auth-error test stops the poller. `auth.js` restarts it in three places. |
| `data_management/api.js` L2 | Imports `authState` from the application layer for `user.email`, a dependency that points up. |

Layering: `application/utils/auth.js` imports `google_sheets_services` directly, and `application-utils.js` imports `GoogleSheetsAuth.js` directly, bypassing `index.js`. CLAUDE.md says the UI doesn't touch the services layer.

---

## Why the popup flashes and takes focus

1. The token expires 3500 s after it was saved.
2. Whatever runs next calls `GoogleSheetsAuth.checkAuth()`. That can be auto-save on its interval (it runs in hidden tabs), the cache poller (every 60 s while the tab is visible, and right away when the tab becomes visible), `Auth.initialize()` on page load, or any store reload.
3. `checkAuth` calls `silentRefresh()`, which calls `requestAccessToken({prompt: ''})`. **With the GIS token client this always opens a popup window.** The window closes itself when no approval is needed.
4. No click led to it. Where popups are blocked, it fails and sets `_silentRefreshBlocked`, and from then on renewal waits for a full sign-in. Where the site is allowed to open popups, the window opens and takes focus from whatever the user is doing, in any application.

The 55-minute "next click" handler avoids this only when the user clicks within those 5 minutes. When it does fire, the popup opens in the middle of whatever the user clicked to do.

---

## Other problems found

1. **The expired-session modal can lose edits.** Clicking Log Out, X or the overlay calls `Auth.logout()`. The token has expired, so the save is skipped and the page reloads. Edits made since the last backup are gone, and the backup can't run either, because auto-save skips while the token is expired.
2. **One failed background refresh blocks renewal for the session.** `_silentRefreshBlocked` stops later refreshes, including ones made from a click, until a full sign-in.
3. **Five different auth-error tests.** reactiveStores: 401 only. PriorityQueue: 401 or 403. caching and application-utils: 401, 403, `UNAUTHENTICATED`, `PERMISSION_DENIED`. GoogleSheetsData: adds "insufficient auth". A 403 for a sheet that isn't shared triggers a sign-in prompt that can't fix it.
4. **Expiry ignores Google's lifetime.** It is a fixed 3500 s from save time, not `expires_in`.
5. **Some reads ignore the auth check.** They call `checkAuth()`, ignore `false`, and send the request anyway, so a 401 comes back.
6. **Modals are watched by polling.** Closing a modal is detected with a 100 ms `setInterval` (`checkAuthWithPrompt`, `_authenticateWithPopupWarning`).
7. **The "popup blocked?" warning appears after 4 s even when the popup is open.** A user choosing an account or doing 2FA sees "Retry Login", and clicking it cancels the attempt in progress. GIS reports a real block through `error_callback` with type `popup_failed_to_open`, which can replace the timer.
8. **The duplicate-modal guard is a flag.** It only partly works (`authPromptShowing`). The PriorityQueue handler, store errors and navigation can all race to it.
9. **After sign-in, each path restores state differently.** The modal path calls `clearCache()`, `reloadErrorStores()` and `restartCacheTimestampPoller()`. `login()` re-enables PriorityQueue, reloads and restarts. The 55-minute renewal only restarts the poller.

---

## What Google allows

- **Frames: not possible.** Google's sign-in and consent pages refuse to load in an iframe, and Google's OAuth policy forbids embedded sign-in. The in-page "Sign in with Google" button and One Tap return an ID token (who the user is), not an access token for Sheets or Drive.
- **Token model (current): popup only.** `initTokenClient` has no redirect mode and no refresh token. Every new one-hour token needs a popup, which closes itself when consent and a Google session already exist.
- **One redirect: possible.** Either an implicit-grant redirect (`response_type=token`, which needs no server; the token comes back in the URL fragment), or the code client with `ux_mode: 'redirect'`. The page leaves the app and comes back, so in-memory state is lost. That is fine for the first sign-in and not for renewal in the middle of work.
- **Refresh tokens: need a server.** A web client's authorization code is exchanged at Google's token endpoint with the client secret, so the exchange and later refreshes run on a server. Refresh tokens don't expire on a timer when the OAuth consent screen is **Internal** (Workspace). In "External / Testing" mode they expire after 7 days.

---

## Options

### A. Serverless, tidied up (no new infrastructure)

- **Sign-in:** one full-page redirect (implicit grant). On return, `GoogleSheetsAuth` reads the token from the URL fragment, saves it and clears the fragment. URL routing restores the page. The popup stays as the fallback for signing in again mid-session, because it keeps unsaved state.
- **Renewal:** the data layer never refreshes. About 5 minutes before expiry, a banner says "Session ends in 5 min · Stay signed in". Its button runs `requestAccessToken({prompt: '', login_hint})`. The popup still flashes, but only when the user clicks that button, at most once an hour. The banner shows in hidden tabs too, so it is waiting when the user comes back.
- **Expiry:** the banner becomes "Session ended · Sign in". Requests wait, and nothing is discarded or reloaded.
- **Meets:** goal 1 (one redirect), goal 2 partly (a popup on a deliberate click, never from background code), goal 3 fully.

### B. Token server (recommended if a small server is acceptable)

- A small endpoint holds the client secret and the refresh tokens. Options:
  - **Google Apps Script web app** under a company account: no new vendor, secret kept in Script Properties.
  - **Cloudflare Worker or Cloud Run function.**
- **Sign-in:** one redirect with the code client (`ux_mode: 'redirect'`, `state` checked). The server exchanges the code, keeps the refresh token, checks the domain (`hd = topshelfexhibits.com`), and returns an opaque session id and an access token.
- **Renewal:** `fetch(server, {session})` returns a new access token. **No popup, no click needed**, and it works in hidden tabs.
- **Signing in again** is needed only when the user or an admin revokes access. It is a banner with a button: popup to keep state, or redirect when nothing is unsaved.
- **Logout:** the server revokes the refresh token and deletes the session.
- **Costs and checks:**
  - A client secret to create and guard, and a deploy to maintain.
  - The consent screen must be **Internal**, or sessions die every 7 days.
  - A Workspace admin policy may block Apps Script web apps shared with "Anyone".
  - Apps Script calls take about 1–3 s, which is fine for once an hour.
  - The session id in `localStorage` is a long-lived credential, as a session cookie would be. Limit the damage: restrict the server to the app's origin and the company domain, and allow revocation.
- **Meets:** all three goals.

**Recommendation:** build the central session below first. Both options need it, and it alone ends the background popups that take focus. Then add B if a server is acceptable, or keep A.

---

## Proposed central design

A single `AuthSession` in `google_sheets_services/`, which already owns tokens. The data layer passes it through (`data_management` exposes the session state and the current user), so the UI never imports the services layer.

```
status: 'signed-out' | 'active' | 'expiring' | 'needs-user' | 'offline'
user: { email, name } | null
missingScopes: string[]
expiresAt: ms

getToken()          → a valid token, or throws AUTH_REQUIRED. Never opens UI.
                       Option B: refreshes over fetch; concurrent calls share one refresh.
signIn({ mode })    → 'redirect' | 'popup'; call only from a click
renew()             → Option A: token popup (click only). Option B: rarely needed.
signOut()
onChange(fn)        → subscribe to status changes
classifyError(err)  → 'auth' | 'permission' | 'quota' | 'network' | 'other'  (one test)
```

- **One request gate.** Every `GoogleSheetsService` call goes through one wrapper. It awaits `getToken()`, and on a 401 it tells the session once (Option B: refresh and retry once; Option A: status → `needs-user`). This replaces the per-method `checkAuth()` calls and the auth branch of `withExponentialBackoff`.
- **One UI.** One application component renders from `status`:
  - `expiring`: "Stay signed in" banner.
  - `needs-user`: "Session ended · Sign in" banner or modal.
  - Missing scopes: the existing banner.

  Because it is drawn from one state, there is one prompt, with no flags and no polling. Dismissing it never logs out. Unsaved edits stay in memory, and saves wait.
- **Consumers subscribe instead of calling auth.** On `active`, the poller resumes, PriorityQueue resumes and error stores reload. On anything else, they pause. Auto-save and the poller skip while not `active` and never trigger sign-in.
- **What gets removed:**
  - `checkAuthWithPrompt` and its callers (reactiveStores, navigation, PriorityQueue handler).
  - `_registerProactiveInteractionHandler`, the expiry timer and its visibility fallback.
  - `_authenticateWithPopupWarning` polling and `_silentRefreshBlocked`.
  - The five auth-error tests.
  - The `restartCacheTimestampPoller` calls in `auth.js`.
  - The `checkAuth` in `readCacheTimestamps`.
  - The `authState` import in `api.js`.
- **Timing:** `expiresAt` comes from `expires_in`. It is checked on each `getToken()` and on `visibilitychange`, so a throttled hidden tab still catches expiry when it comes back.
- **FakeGoogle** implements the same interface, with a way to force expiry, refresh failure and revocation. Tests:
  - Expiry leads to `needs-user` with no UI call from background code.
  - Concurrent `getToken()` calls share one refresh.
  - A 403 permission error doesn't prompt sign-in.
  - Dismissing the prompt keeps dirty stores.

### Backwards compatibility

- No sheet or preference changes.
- Option A keeps the `gapi_token` and `last_email` keys, so existing sessions carry over.
- Option B adds a session id key. Each user signs in once with the new flow and sees one consent screen for offline access. Old keys are cleared then.

---

## Questions to settle

1. Is the OAuth consent screen **Internal** to the topshelfexhibits.com Workspace? Option B needs this, or sessions die every 7 days.
2. Is a small server acceptable (Apps Script under a company account, or Cloudflare or Cloud Run)? Can the Workspace admin allow an Apps Script web app reachable from the app's origin?
3. In Option A, is the once-an-hour popup on clicking "Stay signed in" acceptable?

---

## Manual test checklist (after the rework)

- [ ] Token expires while the tab is hidden: no Google popup. The banner is waiting on return.
- [ ] Token expires during auto-save or a poll: no popup. Saves wait, nothing is lost.
- [ ] Dismiss the session prompt: still signed out, edits still in memory, nothing reloaded.
- [ ] Two saves fail with 401 at once: one prompt.
- [ ] Sheet not shared (403 `PERMISSION_DENIED`): an error on that store, no sign-in prompt.
- [ ] Popup blocked: GIS `popup_failed_to_open` shows the blocker message right away.
- [ ] First sign-in by redirect: returns to the same page path.
- [ ] Option B: renewal over fetch with the tab hidden. Revoke access in Google Account settings, and the next call shows the sign-in banner.
