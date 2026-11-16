/**
 * TopShelf Live Inventory: the sign-in service (an OAuth token broker).
 *
 * The app signs in once through Google (one redirect); this script exchanges the code for a
 * refresh token, keeps it, and hands the app new one-hour access tokens when it asks, so the app
 * never opens a window to renew. Setup and security notes: docs/notes/auth-audit-findings.md,
 * "Sign-in service setup".
 *
 * Deploy as a web app: Execute as "Me", Who has access "Anyone". The browser can only reach the
 * script anonymously; every request proves itself with a session or a fresh Google code.
 *
 * Script Properties you set (Project Settings → Script Properties):
 *   CLIENT_ID       the app's OAuth client ID (the same as the app's CLIENT_ID)
 *   CLIENT_SECRET   that client's secret. It lives only here: never in the app or the repo.
 *   ALLOWED_DOMAIN  the company's Google Workspace domain, e.g. topshelfexhibits.com
 *                   (several: comma-separated)
 *   IDLE_DAYS       optional, default 30: a session not used for this many days ends
 * Script Properties the script writes:
 *   SESSION_HMAC_KEY  a random key, made on first use
 *   user:<email>      { rt, updated }: the account's refresh token, shared by its sessions
 *   session:<id>      { email, cur, prev, rotatedAt, created, lastUsed }: hashes of the session
 *                     secret, never the secret itself
 *
 * A session is "<id>.<secret>". Every renewal replaces the secret (the app stores the new one).
 * The previous secret still works for two minutes, for an answer lost on the way; after that it
 * means a copy is in someone else's hands, and the session ends.
 *
 * Dropbox (optional): read-only access to the company project folder, through one dedicated
 * Dropbox account the script holds. The browser never gets a Dropbox token: it asks for a folder
 * listing or a file's temporary link with the user's Google access token, which the script checks
 * with Google. Setup: docs/notes/auth-audit-findings.md, "Dropbox setup".
 * Script Properties you set:
 *   DROPBOX_APP_KEY, DROPBOX_APP_SECRET  the Dropbox app's key and secret (scoped, read only)
 *   DROPBOX_FOLDER   optional: the shared folder's path in the Dropbox account. Empty: the account's
 *                    whole Dropbox (an account that sees only the company folder)
 *   DROPBOX_AUTH_CODE  briefly: the code Dropbox shows when approving; connectDropbox uses it up
 * Script Properties the script writes:
 *   DROPBOX_REFRESH_TOKEN, DROPBOX_NAMESPACE_ID  (connectDropbox)
 */

var GRACE_MS = 2 * 60 * 1000;
var MAX_BODY = 16384;
var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
var USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
var TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

// ── Web app ───────────────────────────────────────────────────────────────────

function doGet() {
  return ContentService.createTextOutput('TopShelf sign-in service is running.');
}

/** The app POSTs plain-text JSON: { action: 'exchange' | 'refresh' | 'signout' | 'dropbox_list' | 'dropbox_link' | 'dropbox_changes', ... } */
function doPost(e) {
  // Junk is turned away here, before any lock, Google call or property write, so a flood of it
  // can't hold up real renewals. The URL is public: only well-formed requests for a session that
  // exists, carrying a Google code, or (Dropbox) carrying a Google token go further.
  var contents = e && e.postData && e.postData.contents;
  if (!contents || contents.length > MAX_BODY) return reply_({ ok: false, error: 'BAD_REQUEST' });
  var request;
  try {
    request = JSON.parse(contents);
  } catch (err) {
    return reply_({ ok: false, error: 'BAD_REQUEST' });
  }
  if (!request || typeof request !== 'object') return reply_({ ok: false, error: 'BAD_REQUEST' });
  try {
    if (request.action === 'exchange') {
      if (!isWellFormedExchange_(request)) return reply_({ ok: false, error: 'BAD_REQUEST' });
      return reply_(exchange_(request));
    }
    if (request.action === 'refresh' || request.action === 'signout') {
      var parsed = parseSession_(request.session);
      var known = parsed && PropertiesService.getScriptProperties().getProperty('session:' + parsed.id);
      if (!known) return reply_(request.action === 'refresh' ? { ok: false, error: 'SESSION_ENDED' } : { ok: true });
      return reply_(withLock_(function () {
        return request.action === 'refresh' ? refresh_(request) : signOut_(request);
      }));
    }
    if (request.action === 'dropbox_list' || request.action === 'dropbox_link' || request.action === 'dropbox_changes') {
      // Reads only, so no lock: they never touch sessions or properties
      if (!isWellFormedDropbox_(request)) return reply_({ ok: false, error: 'BAD_REQUEST' });
      var caller = verifyGoogleToken_(request.token);
      if (caller.error) return reply_({ ok: false, error: caller.error });
      if (!dropboxConnected_()) return reply_({ ok: false, error: 'DROPBOX_NOT_CONNECTED' });
      if (request.action === 'dropbox_changes') return reply_(dropboxChanges_(request));
      return reply_(request.action === 'dropbox_list' ? dropboxList_(request) : dropboxLink_(request, caller.email));
    }
    return reply_({ ok: false, error: 'BAD_REQUEST' });
  } catch (err) {
    // Never log tokens or secrets: editors can read the logs
    console.error('Sign-in service failure: ' + (err && err.message));
    return reply_({ ok: false, error: 'SERVER_ERROR' });
  }
}

/** Runs fn holding the script lock: session rotation and property writes happen one at a time */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function isWellFormedExchange_(request) {
  return typeof request.code === 'string' && request.code.length > 0 && request.code.length <= 512 &&
    typeof request.redirectUri === 'string' && /^https:\/\/[^\s]{1,500}$/.test(request.redirectUri) &&
    (request.verifier === undefined || (typeof request.verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(request.verifier)));
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** A Google sign-in code (with its PKCE verifier) → a new session */
function exchange_(request) {
  var tokens = googleToken_({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier
  });
  if (tokens.error) return { ok: false, error: 'CODE_REJECTED', message: 'Google refused the sign-in. Please sign in again.' };

  var user = userInfo_(tokens.access_token);
  var email = user && user.email_verified && user.email ? String(user.email).toLowerCase() : null;
  if (!email || !isAllowed_(email)) {
    revoke_(tokens.refresh_token || tokens.access_token);
    return { ok: false, error: 'ACCOUNT_NOT_ALLOWED', message: 'Sign in with your company Google account.' };
  }

  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    if (tokens.refresh_token) {
      props.setProperty('user:' + email, JSON.stringify({ rt: tokens.refresh_token, updated: Date.now() }));
    } else if (!props.getProperty('user:' + email)) {
      // Google gives a refresh token only with consent: the app asks again with prompt=consent
      return { ok: false, error: 'NO_REFRESH_TOKEN' };
    }
    cleanUp_(props);

    var id = Utilities.getUuid().replace(/-/g, '');
    var secret = randomSecret_();
    var now = Date.now();
    props.setProperty('session:' + id, JSON.stringify({ email: email, cur: hash_(secret), prev: null, rotatedAt: 0, created: now, lastUsed: now }));
    return answer_(id + '.' + secret, email, tokens);
  });
}

/** A session → a new access token, and the session's next secret */
function refresh_(request) {
  var parsed = parseSession_(request.session);
  var props = PropertiesService.getScriptProperties();
  var key = parsed && 'session:' + parsed.id;
  var record = key && readJson_(props, key);
  if (!record) return { ok: false, error: 'SESSION_ENDED' };

  var now = Date.now();
  if (now - record.lastUsed > idleMs_()) {
    props.deleteProperty(key);
    return { ok: false, error: 'SESSION_ENDED' };
  }

  var hash = hash_(parsed.secret);
  var next;
  if (hash === record.cur) {
    next = nextSecret_(props, parsed.secret);
  } else if (hash === record.prev && now - record.rotatedAt < GRACE_MS) {
    // The answer to the last renewal was lost: the same next secret again
    next = nextSecret_(props, parsed.secret);
  } else {
    props.deleteProperty(key);
    console.warn('An old session secret was used after the grace period; the session for ' + record.email + ' ended.');
    return { ok: false, error: 'SESSION_REUSED' };
  }

  var user = readJson_(props, 'user:' + record.email);
  if (!user) {
    props.deleteProperty(key);
    return { ok: false, error: 'GRANT_REVOKED' };
  }
  var tokens = googleToken_({ grant_type: 'refresh_token', refresh_token: user.rt });
  if (tokens.error === 'invalid_grant') {
    // The user or an admin removed the app's access: every session of this account ends
    endAccount_(props, record.email, false);
    return { ok: false, error: 'GRANT_REVOKED' };
  }
  if (tokens.error) throw new Error('Google refused the refresh: ' + tokens.error);

  if (hash === record.cur) {
    record.prev = record.cur;
    record.cur = hash_(next);
    record.rotatedAt = now;
  }
  record.lastUsed = now;
  props.setProperty(key, JSON.stringify(record));
  return answer_(parsed.id + '.' + next, record.email, tokens);
}

/**
 * Ends this session only. The account's other devices stay signed in, so the Google grant is
 * not revoked (endSessionsFor does that).
 */
function signOut_(request) {
  var parsed = parseSession_(request.session);
  var props = PropertiesService.getScriptProperties();
  var key = parsed && 'session:' + parsed.id;
  var record = key && readJson_(props, key);
  if (record) {
    var hash = hash_(parsed.secret);
    if (hash === record.cur || hash === record.prev) props.deleteProperty(key);
  }
  return { ok: true };
}

// ── Dropbox: read-only access to the company project folder ──────────────────
//
// What keeps it read-only and inside the folder, each on its own:
//   1. The token has only the read scopes (connectDropbox refuses any other grant).
//   2. The Dropbox account the script holds has view-only access to the folder (set up in Dropbox).
//   3. Every call is pinned to the folder's namespace (Dropbox-API-Path-Root): Dropbox resolves
//      every path inside it, so no path can reach outside.
//   4. This script offers only listings, temporary links and change lists, to company accounts.
//
// The app keeps listings until Dropbox says they changed, as it keeps sheet data: its first listing
// asks for a cursor (watch), and its poller asks what changed since (dropbox_changes). Listings are
// not cached here, so every listing is as new as the cursor that watches it.

var DROPBOX_API = 'https://api.dropboxapi.com/2/';
var DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
var DROPBOX_READ_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read'];
var DROPBOX_MAX_PATHS = 25;      // folders per listing request (fetched in parallel)
var DROPBOX_MAX_ENTRIES = 2000;  // entries per folder; more comes back marked truncated
var DROPBOX_CHANGE_PAGES = 5;    // pages of changes per answer; more resets the watch
var DROPBOX_MAX_CHANGES = 1000;  // changed folders per answer; more resets the watch

function isWellFormedDropbox_(request) {
  if (typeof request.token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{20,2048}$/.test(request.token)) return false;
  if (request.action === 'dropbox_link') return isDropboxPath_(request.path) && request.path !== '';
  // A Dropbox cursor is opaque: printable, no spaces. None: start watching
  if (request.action === 'dropbox_changes') return request.cursor === undefined || (typeof request.cursor === 'string' && /^[\x21-\x7e]{1,4000}$/.test(request.cursor));
  return Array.isArray(request.paths) && request.paths.length > 0 && request.paths.length <= DROPBOX_MAX_PATHS &&
    request.paths.every(isDropboxPath_) && (request.recursive === undefined || typeof request.recursive === 'boolean') &&
    (request.watch === undefined || typeof request.watch === 'boolean');
}

/** '' (the folder itself) or '/A/B': no empty, '.' or '..' parts, no control characters */
function isDropboxPath_(path) {
  if (path === '') return true;
  if (typeof path !== 'string' || path.length > 1000 || path.charAt(0) !== '/' || /[\u0000-\u001f\\]/.test(path)) return false;
  return path.slice(1).split('/').every(function (part) { return part !== '' && part !== '.' && part !== '..'; });
}

/**
 * The caller's Google access token, checked with Google: issued to this app's client, for a
 * verified company account. { email } or { error }. A good token is remembered (by its hash) for
 * up to ten minutes, so a page's requests cost one check.
 */
function verifyGoogleToken_(token) {
  var cache = CacheService.getScriptCache();
  var key = 'gtok:' + hash_(token);
  var known = cache.get(key);
  if (known) return { email: known };
  // POST keeps the token out of URLs
  var response = UrlFetchApp.fetch(TOKENINFO_URL, { method: 'post', payload: { access_token: token }, muteHttpExceptions: true });
  if (response.getResponseCode() >= 500) throw new Error('Google tokeninfo answered ' + response.getResponseCode());
  if (response.getResponseCode() !== 200) return { error: 'TOKEN_REJECTED' };
  var info = JSON.parse(response.getContentText());
  var email = info.email ? String(info.email).toLowerCase() : '';
  if (info.aud !== config_('CLIENT_ID')) return { error: 'TOKEN_REJECTED' };
  if (String(info.email_verified) !== 'true' || !email || !isAllowed_(email)) return { error: 'ACCOUNT_NOT_ALLOWED' };
  var seconds = Math.min(Number(info.expires_in) || 0, 600) - 30;
  if (seconds > 0) cache.put(key, email, seconds);
  return { email: email };
}

function dropboxConnected_() {
  var props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('DROPBOX_REFRESH_TOKEN') && props.getProperty('DROPBOX_NAMESPACE_ID'));
}

/** Folder listings: { ok, folders: { path: { entries: [{ name, path, folder, size, modified }], missing?, truncated? } } } */
function dropboxList_(request) {
  // watch: the cursor comes first, so a change made during the listing is reported later
  var cursor = request.watch ? latestDropboxCursor_() : null;
  var listings = listDropboxFolders_(request.paths, !!request.recursive);
  var folders = {};
  request.paths.forEach(function (path, i) { folders[path] = listings[i]; });
  return cursor ? { ok: true, folders: folders, cursor: cursor } : { ok: true, folders: folders };
}

/**
 * What changed in the folder since the cursor: { ok, cursor, changed, touched } or, when it can't
 * say (no cursor, Dropbox reset it, too many changes), { ok, cursor, reset: true }.
 *   changed  folders whose own entries changed (an entry added, edited, moved or deleted in them)
 *   touched  entries that may have been folders: deleted, or a folder added. Anything at or below
 *            them changed.
 * Paths are lowercase.
 */
function dropboxChanges_(request) {
  if (!request.cursor) return { ok: true, reset: true, cursor: latestDropboxCursor_() };
  var cursor = request.cursor;
  var changed = {};
  var touched = {};
  var count = 0;
  for (var page = 0; page < DROPBOX_CHANGE_PAGES; page++) {
    var answer = dropboxCalls_([{ endpoint: 'files/list_folder/continue', body: { cursor: cursor } }])[0];
    if (!answer.ok) break;   // reset, or a cursor Dropbox no longer knows
    answer.body.entries.forEach(function (entry) {
      var path = String(entry.path_lower || '');
      if (!path) return;
      var parent = path.slice(0, path.lastIndexOf('/'));
      if (!changed[parent]) { changed[parent] = true; count++; }
      if (entry['.tag'] !== 'file' && !touched[path]) { touched[path] = true; count++; }
    });
    cursor = answer.body.cursor;
    if (count > DROPBOX_MAX_CHANGES) break;
    if (!answer.body.has_more) return { ok: true, cursor: cursor, changed: Object.keys(changed), touched: Object.keys(touched) };
  }
  return { ok: true, reset: true, cursor: latestDropboxCursor_() };
}

/** A cursor for every change in the folder from now on */
function latestDropboxCursor_() {
  var answer = dropboxCalls_([{ endpoint: 'files/list_folder/get_latest_cursor', body: { path: '', recursive: true, include_non_downloadable_files: false } }])[0];
  if (!answer.ok) throw new Error('Dropbox refused a cursor: ' + answer.summary);
  return answer.body.cursor;
}

function listDropboxFolders_(paths, recursive) {
  var results = paths.map(function () { return { entries: [] }; });
  var calls = paths.map(function (path, i) {
    return { i: i, endpoint: 'files/list_folder', body: { path: path, recursive: recursive, include_non_downloadable_files: false, limit: 2000 } };
  });
  while (calls.length) {
    var answers = dropboxCalls_(calls);
    var more = [];
    answers.forEach(function (answer, k) {
      var result = results[calls[k].i];
      if (!answer.ok) {
        if (/^path\/(not_found|not_folder)/.test(answer.summary)) { result.missing = true; return; }
        throw new Error('Dropbox refused a listing: ' + answer.summary);
      }
      answer.body.entries.forEach(function (entry) {
        if (result.entries.length >= DROPBOX_MAX_ENTRIES) { result.truncated = true; return; }
        var out = { name: entry.name, path: entry.path_display || entry.path_lower, folder: entry['.tag'] === 'folder' };
        if (!out.folder) { out.size = entry.size; out.modified = entry.server_modified; }
        result.entries.push(out);
      });
      if (answer.body.has_more && !result.truncated) more.push({ i: calls[k].i, endpoint: 'files/list_folder/continue', body: { cursor: answer.body.cursor } });
    });
    calls = more;
  }
  return results;
}

/** A link that downloads one file, valid for four hours: { ok, link } */
function dropboxLink_(request, email) {
  var answer = dropboxCalls_([{ endpoint: 'files/get_temporary_link', body: { path: request.path } }])[0];
  if (!answer.ok) return { ok: false, error: 'NOT_FOUND' };
  console.log('Dropbox file opened by ' + email + ': ' + request.path);   // the link itself is never logged
  return { ok: true, link: answer.body.link };
}

/**
 * Dropbox API calls, in parallel, pinned to the folder's namespace. Each answer: { ok, body } or,
 * for Dropbox's "can't do that" (409), { ok: false, summary }. Anything else throws (the app retries).
 */
function dropboxCalls_(calls) {
  var send = function (accessToken) {
    return UrlFetchApp.fetchAll(calls.map(function (call) {
      return {
        url: DROPBOX_API + call.endpoint,
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(call.body),
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'namespace_id', namespace_id: config_('DROPBOX_NAMESPACE_ID') })
        },
        muteHttpExceptions: true
      };
    }));
  };
  var responses = send(dropboxAccessToken_());
  if (responses.some(function (r) { return r.getResponseCode() === 401; })) {
    // The remembered access token stopped working: one fresh one, once
    CacheService.getScriptCache().remove('dropbox_access');
    responses = send(dropboxAccessToken_());
  }
  return responses.map(function (response) {
    var code = response.getResponseCode();
    var text = response.getContentText() || '';
    var body = {};
    try { body = JSON.parse(text || '{}'); } catch (err) { body = {}; }
    if (code === 200) return { ok: true, body: body };
    if (code === 409) return { ok: false, summary: String(body.error_summary || '') };
    // A 400 explains itself in plain text (about the request, never the token)
    throw new Error('Dropbox answered ' + code + ': ' + (body.error_summary || text.slice(0, 300)));
  });
}

/** A Dropbox access token (four hours), remembered in the script cache until shortly before it ends */
function dropboxAccessToken_() {
  var cache = CacheService.getScriptCache();
  var token = cache.get('dropbox_access');
  if (token) return token;
  var tokens = dropboxToken_({ grant_type: 'refresh_token', refresh_token: config_('DROPBOX_REFRESH_TOKEN') });
  if (tokens.error) throw new Error('Dropbox refused the refresh: ' + tokens.error);
  cache.put('dropbox_access', tokens.access_token, Math.max(60, Math.min(21600, (Number(tokens.expires_in) || 14400) - 300)));
  return tokens.access_token;
}

/** POST to Dropbox's token endpoint with the app key and secret. 4xx: { error }. 5xx throws. */
function dropboxToken_(params) {
  var response = UrlFetchApp.fetch(DROPBOX_TOKEN_URL, {
    method: 'post',
    payload: params,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(config_('DROPBOX_APP_KEY') + ':' + config_('DROPBOX_APP_SECRET')) },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 500) throw new Error('Dropbox token endpoint answered ' + response.getResponseCode());
  var body = {};
  try { body = JSON.parse(response.getContentText() || '{}'); } catch (err) { body = { error: 'unreadable' }; }
  if (response.getResponseCode() >= 400 && !body.error) body.error = 'http_' + response.getResponseCode();
  return body;
}

function revokeDropbox_(accessToken) {
  // Revoking an access token also ends the refresh token it came from
  UrlFetchApp.fetch(DROPBOX_API + 'auth/token/revoke', { method: 'post', headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true });
}

/** The namespace every call is pinned to: DROPBOX_FOLDER's shared folder, or the account's root */
function findDropboxNamespace_(accessToken) {
  var call = function (endpoint, body, root) {
    var headers = { Authorization: 'Bearer ' + accessToken };
    if (root) headers['Dropbox-API-Path-Root'] = JSON.stringify({ '.tag': 'root', root: root });
    var response = UrlFetchApp.fetch(DROPBOX_API + endpoint, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body), headers: headers, muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('Dropbox ' + endpoint + ' answered ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 300));
    return JSON.parse(response.getContentText());
  };
  var account = call('users/get_current_account', null);
  var root = account.root_info.root_namespace_id;
  var folder = (PropertiesService.getScriptProperties().getProperty('DROPBOX_FOLDER') || '').trim();
  if (!folder) return { id: root, name: 'the whole Dropbox', account: account.email };
  var meta = call('files/get_metadata', { path: folder }, root);
  var sharing = meta.sharing_info || {};
  var id = meta['.tag'] === 'folder' && (sharing.shared_folder_id || meta.shared_folder_id);
  if (!id) throw new Error('DROPBOX_FOLDER "' + folder + '" is not a shared folder. Share it with this Dropbox account (can view), or leave DROPBOX_FOLDER empty to use the account\'s whole Dropbox.');
  if (sharing.read_only === false) console.warn('This Dropbox account can edit "' + meta.path_display + '". Give it view-only access: the token can\'t write either way, but view-only is a second lock.');
  return { id: id, name: meta.path_display, account: account.email };
}

// ── Admin: run these from the editor (Run ▸ function) ────────────────────────

/** Dropbox step 1: logs the approval page. Open it signed in as the app's Dropbox account. */
function dropboxApprovalUrl() {
  console.log('https://www.dropbox.com/oauth2/authorize?response_type=code&token_access_type=offline' +
    '&client_id=' + encodeURIComponent(config_('DROPBOX_APP_KEY')) +
    '&scope=' + encodeURIComponent(DROPBOX_READ_SCOPES.join(' ')));
}

/** Dropbox step 2: put the code Dropbox showed into Script Property DROPBOX_AUTH_CODE, then run this */
function connectDropbox() {
  var props = PropertiesService.getScriptProperties();
  var code = config_('DROPBOX_AUTH_CODE').trim();
  props.deleteProperty('DROPBOX_AUTH_CODE');   // single-use either way
  var tokens = dropboxToken_({ grant_type: 'authorization_code', code: code });
  if (tokens.error) throw new Error('Dropbox refused the code (' + tokens.error + '). Run dropboxApprovalUrl for a new one.');
  var granted = String(tokens.scope || '').split(' ').filter(Boolean);
  var extra = granted.filter(function (s) { return DROPBOX_READ_SCOPES.indexOf(s) === -1; });
  var missing = DROPBOX_READ_SCOPES.filter(function (s) { return granted.indexOf(s) === -1; });
  if (extra.length || missing.length) {
    revokeDropbox_(tokens.access_token);
    throw new Error(extra.length
      ? 'Dropbox granted more than reading (' + extra.join(', ') + '). Turn those permissions off in the Dropbox app, then start again.'
      : 'Dropbox did not grant ' + missing.join(', ') + '. Tick it under Permissions in the Dropbox app, Submit, then start again.');
  }
  var namespace = findDropboxNamespace_(tokens.access_token);
  props.setProperties({ DROPBOX_REFRESH_TOKEN: tokens.refresh_token, DROPBOX_NAMESPACE_ID: String(namespace.id) });
  CacheService.getScriptCache().remove('dropbox_access');
  console.log('Dropbox connected, read only: ' + namespace.account + ', ' + namespace.name + '.');
}

/** Ends the script's Dropbox access (revokes it at Dropbox) */
function disconnectDropbox() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DROPBOX_REFRESH_TOKEN')) {
    try { revokeDropbox_(dropboxAccessToken_()); } catch (err) { console.warn('Revoking at Dropbox failed: ' + err.message); }
  }
  props.deleteProperty('DROPBOX_REFRESH_TOKEN');
  props.deleteProperty('DROPBOX_NAMESPACE_ID');
  CacheService.getScriptCache().remove('dropbox_access');
  console.log('Dropbox disconnected');
}

/**
 * Runs the app's top-level Dropbox listing and logs what it found, or the error. The web app's
 * own runs often can't be opened under Executions, so run this to see why the app's Dropbox
 * requests fail. Logs folder names only.
 */
function checkDropbox() {
  if (!dropboxConnected_()) { console.log('Dropbox is not connected. Run dropboxApprovalUrl, then connectDropbox.'); return; }
  CacheService.getScriptCache().remove('dropbox_access');   // test the whole path, token included
  var folders = listDropboxFolders_([''], false)[0].entries.filter(function (e) { return e.folder; });
  latestDropboxCursor_();   // the change watch
  console.log('Dropbox works. ' + folders.length + ' folders at the top: ' +
    folders.slice(0, 15).map(function (e) { return e.name; }).join(', ') + (folders.length > 15 ? ', …' : ''));
}

/** Logs every session: account, started, last used. No secrets. */
function listSessions() {
  var all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).filter(function (k) { return k.indexOf('session:') === 0; }).forEach(function (k) {
    var r = JSON.parse(all[k]);
    console.log(r.email + '  started ' + new Date(r.created).toISOString() + '  last used ' + new Date(r.lastUsed).toISOString());
  });
}

/** Signs an account out everywhere and revokes the app's Google access for it. Edit the email, then run. */
function endSessionsFor() {
  var email = 'someone@example.com';
  endAccount_(PropertiesService.getScriptProperties(), email.toLowerCase(), true);
  console.log('Ended every session of ' + email);
}

/** Emergency: signs everyone out and revokes every account's grant */
function endAllSessions() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).filter(function (k) { return k.indexOf('user:') === 0; }).forEach(function (k) {
    endAccount_(props, k.slice(5), true);
  });
  Object.keys(all).filter(function (k) { return k.indexOf('session:') === 0; }).forEach(function (k) { props.deleteProperty(k); });
  console.log('Ended every session');
}

/** Run once: removes idle sessions every night */
function installCleanUpTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyCleanUp') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCleanUp').timeBased().everyDays(1).atHour(3).create();
}

function dailyCleanUp() {
  withLock_(function () { cleanUp_(PropertiesService.getScriptProperties()); });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function config_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Script Property ' + name + ' is not set');
  return value;
}

function isAllowed_(email) {
  return config_('ALLOWED_DOMAIN').split(',').some(function (domain) {
    return email.slice(-(domain.trim().length + 1)) === '@' + domain.trim().toLowerCase();
  });
}

function idleMs_() {
  var days = Number(PropertiesService.getScriptProperties().getProperty('IDLE_DAYS')) || 30;
  return days * 24 * 60 * 60 * 1000;
}

/** POST to Google's token endpoint with the client secret. 4xx: { error }. 5xx throws (the app retries). */
function googleToken_(params) {
  var payload = { client_id: config_('CLIENT_ID'), client_secret: config_('CLIENT_SECRET') };
  Object.keys(params).forEach(function (k) { if (params[k]) payload[k] = params[k]; });
  var response = UrlFetchApp.fetch(TOKEN_URL, { method: 'post', payload: payload, muteHttpExceptions: true });
  if (response.getResponseCode() >= 500) throw new Error('Google token endpoint answered ' + response.getResponseCode());
  var body = {};
  try { body = JSON.parse(response.getContentText() || '{}'); } catch (err) { body = { error: 'unreadable' }; }
  if (response.getResponseCode() >= 400 && !body.error) body.error = 'http_' + response.getResponseCode();
  return body;
}

function userInfo_(accessToken) {
  var response = UrlFetchApp.fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return null;
  return JSON.parse(response.getContentText());
}

function revoke_(token) {
  if (!token) return;
  UrlFetchApp.fetch(REVOKE_URL, { method: 'post', payload: { token: token }, muteHttpExceptions: true });
}

function answer_(session, email, tokens) {
  return { ok: true, session: session, accessToken: tokens.access_token, expiresIn: tokens.expires_in, scope: tokens.scope, email: email };
}

function parseSession_(session) {
  var match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(session || ''));
  return match ? { id: match[1], secret: match[2] } : null;
}

function readJson_(props, key) {
  var value = props.getProperty(key);
  return value ? JSON.parse(value) : null;
}

function randomSecret_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function hash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function toHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** The secret that follows `secret`: the same answer every time, so a lost answer can be repeated */
function nextSecret_(props, secret) {
  var key = props.getProperty('SESSION_HMAC_KEY');
  if (!key) {
    key = randomSecret_();
    props.setProperty('SESSION_HMAC_KEY', key);
  }
  return toHex_(Utilities.computeHmacSha256Signature(secret, key)).slice(0, 64);
}

/** Deletes an account's sessions and refresh token; with revoke, also removes its Google grant */
function endAccount_(props, email, revoke) {
  var user = readJson_(props, 'user:' + email);
  if (revoke && user) revoke_(user.rt);
  props.deleteProperty('user:' + email);
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('session:') === 0 && JSON.parse(all[k]).email === email) props.deleteProperty(k);
  });
}

function cleanUp_(props) {
  var all = props.getProperties();
  var cutoff = Date.now() - idleMs_();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('session:') === 0 && JSON.parse(all[k]).lastUsed < cutoff) props.deleteProperty(k);
  });
}
