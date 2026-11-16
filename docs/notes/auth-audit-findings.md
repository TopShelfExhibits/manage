# Authentication

How sign-in works, how to set up the sign-in service, and what protects what. Built on the `auth-apps-script` branch (2026-11-10), and unified into `js/auth/` on 2026-11-16. It replaces the 2026-11-05 audit, summarized at the end.

---

## How it works

**One session owns every token.** `AuthSession` (`js/auth/AuthSession.js`) gets, keeps and renews tokens, and decides when the user is needed. It knows no provider and no data API. It works through two parts:

| Part | File | What it does | Moving to a server |
| --- | --- | --- | --- |
| The sign-in service | `js/auth/SignInService.js` | The only client of the service: `exchange`, `refresh`, `signout` (the session) and `dropbox_list`, `dropbox_link`, `dropbox_changes` (`DropboxFiles`). One POST format, timeout and retry. | Port `apps-script/auth-broker/Code.gs` to answer the same actions, and point `AUTH_BROKER_URL` at it. Nothing else changes. |
| The provider's sign-in page | `js/auth/SignInWindow.js` | The only Google-specific part of sign-in: the OAuth code request (PKCE, `state`), redirect or popup, and the answer from `auth-callback.html`. | Unchanged. Or, if the server runs the OAuth flow itself, this file becomes a link to its sign-in page. |

`authStatus.js` holds the statuses, `classifyError` and the error shapes. The services take tokens from the session. `GoogleSheetsService.withExponentialBackoff` gets one for each attempt, sets it on Google's API client (`gapi`) and passes it to the request function. Google's API client loads on the first request, not at sign-in.

**On localhost**, `data_management/services.js` runs the same session over `fakeSignIn` from `FakeGoogle.js`: `FakeSignInService`, `FakeSignInWindow` (each open is one window, answered at once) and an in-memory store. Only the edges are fake, so the AUTH tests exercise the real session. The page starts signed out on every reload.

**The sign-in service is required.** It is set by `APP_CONFIG.AUTH_BROKER_URL` (`config.js`, injected by `deploy.yml` from the `AUTH_BROKER_URL` Actions variable). Without it, the page shows "Sign-in is not set up for this site". Google's hourly token popup, the earlier fallback, was removed on 2026-11-16, along with the `expiring` status and the "Stay signed in" banner.

| Event | What happens |
| --- | --- |
| Sign in (header button, or "Log in" on the sign-in card) | One redirect: Google, then `auth-callback.html`, then back to the same page. If the service still holds a session, there is no redirect at all. |
| Keeping the token | A background `fetch` to the service about 10 minutes before expiry. No window, and it works in hidden tabs. |
| The service ends the session (revoked, idle 30 days, reused secret) | The banner says "Your sign-in has ended". Its click opens Google's sign-in in a popup, so the page and unsaved work stay. |
| The service is unreachable | Retries every minute, when the tab shows again, and when the connection comes back. The banner says so and offers "Try again". |

**Page load, in order:**
1. Finish a sign-in that just came back from Google.
2. Else use a stored token that is still good.
3. Else renew through the service (a fetch).
4. Else, on a device someone signed in on (`last_email`), try once per tab to sign in without a click: a redirect with `prompt=none`, and `auth_silent_tried` in sessionStorage. It is skipped while `networkState` says offline. With a live Google session and the app already allowed, Google sends the user straight back signed in. If Google needs the user, or the service has no refresh token for the account, the page quietly shows the sign-in card. Logging out forgets `last_email`, so a logout stays a logout.

**Slow networks:** calls to the service time out after 60 s. A session action with no readable answer (timed out, cut off, or an error page in place of JSON, whose first 300 characters go to the console) is sent once more. Repeating a renewal is safe within the two-minute grace. A sign-in exchange that still gets no answer asks the user to log in again, because Google's code is single-use. Dropbox reads go through the request gate instead, with its backoff.

**Statuses** (`AUTH_STATUS`, `authStatus.js`): `signed-out`, `active`, or `needs-user` (signed in, but only the user's click can get a new token). `reason` is `ended` (the service ended the session, or another tab signed out) or `unavailable` (the service can't be reached).

**Rules the code keeps:**

- **Background code never opens a window.** Every Sheets, Drive and Dropbox request takes its token from `getToken()` through the request gate. That call renews through the service, or throws `AUTH_REQUIRED` and turns the status `needs-user`. A popup opens only from `renew()`, called straight from the banner's click.
- **One request gate.** `GoogleSheetsService.withExponentialBackoff` sends a 401 to `handleUnauthorized(token)`, which renews once, and the call retries. Concurrent 401s share one renewal, and a 401 for a token already replaced just retries.
- **One error test.** `classifyError` (`authStatus.js`) returns `auth`, `permission`, `quota`, `network` or `other`. A 403 for a sheet that isn't shared is `permission`: it never prompts sign-in.
- **One prompt.** `app.js`'s `sessionBanner` is the only place the app asks about sign-in. It is drawn from `authState`, which `auth.js` mirrors from the session, so there is never a second modal. Dismissing never logs out.
- **The data layer reads the user from the session.** `api.js` records `AuthSession.state.email` in edit history. Only the UI reads `authState`.
- **Pages stay up while the session needs the user.** `authState.isAuthenticated` means "someone is signed in" and doesn't flip on expiry. While the session needs the user:
  - Store loads fail with "Sign in again to load this data." and reload when the session is active again (`reloadErrorStores`).
  - Saves keep the edits.
  - Auto-save skips its turn.
  - The cache poller pauses (`readCacheTimestamps` returns null) and restarts when the session is active again.
- **Tabs agree.** One tab renews at a time (Web Locks, `tse-auth-renew`). Other tabs pick up its token through the `storage` event. Signing out in one tab turns the others `needs-user`, so their unsaved work stays.
- **Another account.** If a different account signs in on a page, the page reloads.

**Storage** (the key names are unchanged from earlier versions, so sessions carry over):

| Key | Where | What |
| --- | --- | --- |
| `gapi_token` | localStorage | The access token, with `expiresAt` (and `timestamp`, which older versions read). Older tokens without `expiresAt` count as 3500 s from `timestamp`. |
| `last_email` | localStorage | The login hint |
| `auth_session` | localStorage | The service's session, `<id>.<secret>`, replaced on every renewal |
| `auth_service_used` | localStorage | This device has given consent through the service |
| `auth_pending`, `auth_result`, `auth_silent_tried` | sessionStorage | A redirect sign-in in flight: the `state`, the PKCE verifier and the page to come back to; then Google's answer; and whether this tab tried signing in without a click |

**Files:**
- `js/auth/`: `AuthSession.js`, `SignInService.js`, `SignInWindow.js`, `authStatus.js`
- `google_sheets_services/GoogleSheetsData.js` (the request gate), `DropboxFiles.js`, `FakeGoogle.js` (`fakeSignIn`)
- `data_management/services.js`
- `application/utils/auth.js`
- `application/app.js` (banner, sign-in card)
- `docs/auth-callback.html`
- `apps-script/auth-broker/` (the service; not published with the site)

---

## Sign-in service setup

The service is a Google Apps Script web app. It holds the OAuth client secret and each account's refresh token in its Script Properties, and hands the app new access tokens. The app needs it: deploy the service and set `AUTH_BROKER_URL` before this branch goes live, or nobody can sign in.

### 1. Google Cloud Console (the project that owns the app's OAuth client)

1. **OAuth consent screen → User type: Internal.** If it is External in Testing, Google expires refresh tokens after 7 days, and everyone would sign in weekly.
2. **Credentials → the app's OAuth 2.0 Client ID (Web application):**
   - Under **Authorized redirect URIs**, add the deployed app's address with `auth-callback.html` in place of `index.html`, for example `https://<user>.github.io/<repo>/auth-callback.html`. It must match exactly: scheme, host, path, no trailing slash.
   - Leave the JavaScript origins as they are.
   - Under **Client secrets**, copy the secret, or **Add secret**. It goes only into Script Properties: never into the repo, `config.js` or a GitHub variable.

### 2. Apps Script (as a dedicated company account, not a person's)

The account that owns the script runs every request. If it is suspended or deleted, sign-in stops.

1. At [script.google.com](https://script.google.com), create **New project** and name it "TopShelf sign-in service".
2. In **Project Settings**, turn on "Show appsscript.json manifest file in editor". Replace `appsscript.json` with [apps-script/auth-broker/appsscript.json](../../apps-script/auth-broker/appsscript.json), and `Code.gs` with [apps-script/auth-broker/Code.gs](../../apps-script/auth-broker/Code.gs).
3. Under **Project Settings → Script Properties**, add:
   - `CLIENT_ID`: the same client ID as the app's `CLIENT_ID`
   - `CLIENT_SECRET`: the secret from step 1
   - `ALLOWED_DOMAIN`: `topshelfexhibits.com`
   - `IDLE_DAYS` (optional): days unused before a session ends; default 30
4. In the editor, run `installCleanUpTrigger` once. It asks the owner to authorize external requests and triggers, and from then on removes idle sessions nightly.
5. **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**. Copy the URL ending in `/exec`.
   - If "Anyone" isn't offered, a Workspace admin must allow sharing outside the organization for this account (Apps Script ties that option to it).
   - "Anyone" only means the URL is reachable: requests prove themselves with a session or a fresh Google code.
6. Open the `/exec` URL in a private window. It should say "TopShelf sign-in service is running."

### 3. GitHub

1. Under **Settings → Secrets and variables → Actions → Variables**, add `AUTH_BROKER_URL` with the `/exec` URL. Put it beside the other app variables (repository or the `github-pages` environment).
2. Push, or re-run the deploy, and the app uses the service.

**Updating the script later:** use **Deploy → Manage deployments → Edit → Version: New version**, which keeps the same URL. "New deployment" would change the URL.

**Turning it off:** not possible without losing sign-in: the app has no sign-in without the service. To stop every session, run `endAllSessions` (see Security).

### First use after the switch

- A token from before keeps working until it expires. Then the banner asks the user to sign in once, in a popup.
- A user whose token already expired sees the sign-in page and redirects once.
- A device's first sign-in through the service asks Google for consent (`prompt=consent`, flagged by `auth_service_used`). Google gives a refresh token only with consent, and accounts that signed in with the popup before hold a grant without offline access. Without consent up front, the first sign-in would come back with no refresh token and redirect a second time. Later sign-ins on that device skip the permissions page.
- Signed out, the page shows one "Sign in" card with a Log in button.

---

## Dropbox (read only, through the service)

The app reads the company Dropbox project folder through the sign-in service. The service holds one Dropbox connection, made once by an admin. Users never see a Dropbox screen, and no Dropbox token reaches a browser.

**How it works:**

- The app (`DropboxFiles.js`, faked by `FakeDropboxFiles` in `FakeGoogle.js`) asks the service with the user's Google access token, which the service checks with Google's tokeninfo. The token must be issued to the app's `CLIENT_ID` for a verified `ALLOWED_DOMAIN` account. A good token is remembered by its hash for up to ten minutes. These reads take no lock and never touch sessions, so they work with or without the service's sign-in.
- **Actions:**
  - `dropbox_list`: up to 25 folders, listed in parallel. Listings aren't cached in the service, so each is as new as the cursor that watches it. With `watch`, the answer also carries a cursor, taken before the listing.
  - `dropbox_changes`: what changed in the folder since a cursor. It returns the folders whose entries changed (`changed`), the deleted entries and added folders (`touched`), and the next cursor. With no cursor, a cursor Dropbox reset, or more than 1,000 changed folders, it answers `reset` with a fresh cursor. The app's poller asks it at most once a minute ("Spreadsheet watch" in [caching-tab-structure.md](caching-tab-structure.md)).
  - `dropbox_link`: a temporary link to one file, valid for four hours. The app fetches the file from the link into a local `blob:` URL, so a PDF opens in the browser's viewer even if Dropbox sends it as a download. Each open asks for a new link, and the service logs who opened which path, never the link.
- **First use:** a show's details on the schedule page list its PDFs from `CLIENT/YEAR/SHOW/OUTPUT`, grouped by subfolder, each opening in a new tab. `DropboxUtils.findProjectFolders` resolves the schedule row as its identifier does (`resolveIdentifierParts`), and the client and show folder names strictly through the Clients and Shows index (`resolveIndexName`: the index name or an abbreviation, never a near name). A client folder named by an abbreviation matches; a folder that only resembles the name doesn't. The year folder must be named exactly the year, and is read by its path, so a show takes three requests: the client folders (read ahead when the schedule page opens), the year folder and OUTPUT. The panel reads through a reactive store.
- Before an admin connects Dropbox, the panel says "Dropbox is not connected to the app yet."

**What keeps it read only and inside the folder.** Each safeguard holds on its own:

1. **The token has only the read scopes.** `connectDropbox` asks for `files.metadata.read` and `files.content.read` (plus `account_info.read`), and refuses and revokes any grant with more.
2. **The Dropbox account has view-only access** to the company folder, and to nothing else.
3. **Every call is pinned to the folder's namespace** (`Dropbox-API-Path-Root`). Dropbox resolves every path inside it. The service also refuses `..`, empty or `.` path parts and control characters before calling Dropbox.
4. **The service offers only listings and links,** and only to company accounts.

**What remains:**

- A temporary link opens its one file for up to four hours, for anyone who has the link.
- A stolen Google token can list and read the folder until it expires (an hour). The same token already reads the sheets.
- The script's editors can read the Dropbox refresh token, as they can the Google ones.

### Dropbox setup

1. **A Dropbox account for the app**, for example `liveinventory@topshelfexhibits.com`. Share the company project folder with it as **Can view**, and nothing else. It needs a team seat, or the team's sharing policy must allow a view-only outside member.
2. **A Dropbox app** at [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps), created as the admin:
   - **Scoped access, Full Dropbox.** The namespace pin and the account's view-only access keep it to the one folder.
   - Under **Permissions**, tick only `files.metadata.read` and `files.content.read`, then **Submit**. Do this before approving: a connection keeps the permissions it was approved with, so a later change needs `disconnectDropbox` and a new approval. `connectDropbox` refuses a connection that has more or fewer.
   - Copy the **App key** and **App secret**. The secret goes only into Script Properties.
3. **Script Properties** on the sign-in service:
   - `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`
   - `DROPBOX_FOLDER` (optional): the shared folder's path as the app's account sees it, for example `/Top Shelf Projects`. Leave it empty when the account's whole Dropbox is the company folder.
4. **Connect, in the script editor:**
   - Paste the new `Code.gs` and **Deploy → Manage deployments → Edit → New version**.
   - Run `dropboxApprovalUrl`. Open the logged URL signed in to Dropbox as the app's account, and approve.
   - Put the code Dropbox shows into Script Property `DROPBOX_AUTH_CODE`, then run `connectDropbox`. It logs the account and folder, and uses up the code.
5. Open a 2025 show's details on the schedule page. Its OUTPUT PDFs should be listed.

**Turning it off:** run `disconnectDropbox`, which revokes the token at Dropbox.

---

## Security

**What protects what:**

- **The client secret** lives only in Script Properties, which only the script's editors can read.
- **Sign-in codes** are bound to the browser that asked: a `state` the page checks, and a PKCE verifier (S256) the service sends with the code. A code is useless without the secret anyway.
- **Accounts:** the service refuses accounts outside `ALLOWED_DOMAIN`, and revokes what Google gave them. An Internal consent screen already stops outside accounts at Google.
- **Sessions:**
  - The service stores only hashes of session secrets.
  - Every renewal replaces the secret. The previous one works for two more minutes, for an answer lost on the way.
  - An older secret means a copy is elsewhere, and the session ends (`SESSION_REUSED`).
  - A session unused for `IDLE_DAYS` ends.
- **Logs** never carry tokens or secrets.
- **No third-party script runs on the page.** Any script on the app's origin could read the session, so Vue is served from the repo (`docs/js/vendor/vue.global.prod.js`, 3.5.45) instead of a CDN. Google's `api.js` and `gsi/client` are the only outside scripts. To upgrade Vue, replace the file with the new release's `dist/vue.global.prod.js`, after checking that two CDNs serve the same bytes.
- **Junk can't hold up renewals.** The service turns away malformed requests, oversize bodies and unknown sessions before it takes its lock or calls Google. The lock covers only session rotation and property writes.
- **Signing out** ends that device's session at the service. The account's Google grant stays, so its other devices stay signed in.
- **Admin, from the script editor:**
  - `listSessions` lists accounts and last-used dates, with no secrets.
  - `endSessionsFor` (edit the email in it) signs an account out everywhere and revokes the app's Google access for it.
  - `endAllSessions` is the emergency stop.

**What remains:**

- **The session in localStorage is a long-lived credential.** A script injected into the app's page could take it and mint tokens until the session ends. Rotation turns the theft into a forced sign-in the next time either copy is used after the other. Before, the same attack got a one-hour token.
- **The script's editors and Workspace super admins can read the refresh tokens.** Keep editors to one or two people.
- **The service can't check which site calls it,** because Apps Script doesn't expose request headers. The session secret is the only gate.

---

## Tests

- **AUTH group** in `tests/tests.js` (13 tests): the real `AuthSession` over `FakeSignInService` and `FakeSignInWindow`. Covered: signed-out requests, sign-in (one window), sign-in while a session is held (no window), silent renewal, one shared renewal, 401 handling, an ended session (needs-user, no window, the poller pauses), renew, an unreachable service and "Try again", `classifyError`, and sign-out.
- **Not covered by the suite:** the real `SignInService.js` (HTTP, timeout, retry), `SignInWindow.js` (PKCE URL, the popup and redirect relay), other-tab pickup, and `Code.gs`. They were checked on 2026-11-10 against stand-ins for `fetch` and the Apps Script services, before they were split out of `GoogleSheetsAuth.js` on 2026-11-16; the split kept their code as it was.
- **DROPBOX group** (`FakeDropboxFiles`): output PDFs grouped by subfolder, folder matching through the index (strict, with near-name and year decoys), a missing OUTPUT or project folder, three batched and cached requests a show, the schedule's read-ahead, fresh links, no Dropbox connected, and no answer. `Code.gs`'s Dropbox actions were checked on 2026-11-13 against stand-ins for Google's tokeninfo and the Dropbox API. Covered: the token and account checks, the scope refusal, the namespace pin, path refusal, paging, the change watch (cursor before listing, changes deduplicated, reset), access-token renewal and disconnecting. The real `DropboxFiles.js`, and whether Dropbox's temporary links allow the `blob:` fetch (it falls back to opening the link), wait for the deployed site.

**After deploying with the service:**

- [ ] Sign in from a fresh browser: one redirect, back on the same page.
- [ ] Leave a tab open past an hour, hidden and visible: no window opens, and requests keep working.
- [ ] Two tabs open across a renewal: both keep working, and the service logs no `SESSION_REUSED`.
- [ ] Remove the app's access in Google Account → Security → Third-party access. The next renewal shows "Your sign-in has ended"; Sign in opens a popup, and unsaved edits are still there.
- [ ] Block popups and click Sign in: the banner says the browser blocked the window.
- [ ] Log out: the page reloads signed out, and a second tab shows the sign-in banner with its edits kept.
- [ ] Dropbox: a show's details list its OUTPUT PDFs, and one opens in a new tab in the browser's PDF viewer, not as a download.
- [ ] Dropbox: the service's log names who opened the file, with no link or token in it.

---

## Background: the 2026-11-05 audit

- **The flashing popup.** `GoogleSheetsAuth.checkAuth()` ran a "silent" refresh when the token had expired. That refresh opens a Google popup, and every Sheets call, auto-save and the poller called it, so popups opened without a click. In hidden tabs they took focus from other applications.
- **Auth was handled in about twelve places:**
  - five different auth-error tests;
  - a PriorityQueue 401/403 handler;
  - a click hijacked at 55 minutes;
  - an expiry timer;
  - a "Session Expired" modal whose dismissal logged out and reloaded, losing edits;
  - a 4-second "popup blocked?" modal that cancelled sign-ins still in progress.
- **The fix:** all of it was replaced by the session, the request gate, `classifyError` and the session banner above.
- **What Google allows:**
  - Google's sign-in won't load in an iframe.
  - The browser-only token model has no refresh tokens, so renewing needs a popup or a redirect.
  - Renewing without a window needs a server holding a refresh token, which is why the Apps Script service exists.

## Background: the 2026-11-16 unification

- **Two session implementations.** `FakeGoogleSheetsAuth` re-implemented the session, so the tests checked the fake. Now one `AuthSession` runs everywhere, and only the service and the window are faked.
- **Two clients of the service.** The session and `DropboxFiles` each built their own POST and parsing. Both now use `SignInService`.
- **Two modes.** The no-service popup mode (Google's token client, the `expiring` status, the warning timer, browser-side revocation, two versions of the banner and card) was removed. The service is required.
- **Sign-in owned the Sheets client.** The session loaded `gapi`, ran discovery and set its token. The request gate now does that, and the session knows no data API.
- **Tokens read around the session.** Drive downloads and uploads read `gapi.client.getToken()` and skipped renewal. They now take the gate's token, so a 401 renews once like every other request.
- **The data layer imported the UI.** `api.js` read `authState` for the user's email. It reads `AuthSession.state.email` now.
- **Removed as unused or misplaced:** `isAuthenticated()`, `getMissingScopes()`, `getUserEmail()`, `Auth.state`, `BaseTokenManager`, `getDriveFileThumbnailLink` (real and fake), and the Drive search's token-scope logging. `getDeviceId` moved from `auth.js` to `sheetLockMixin.js`, the only place that uses it. The silent sign-in checks `networkState` instead of `navigator.onLine`.
