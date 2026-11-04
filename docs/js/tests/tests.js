/**
 * Console test suite — runs automatically on localhost against FakeGoogle test data.
 * Add new tests here when building features that depend on existing behavior.
 * Each test group covers a distinct layer of the stack; cross-group tests intentionally
 * exercise multiple layers together to catch integration regressions.
 *
 * FakeGoogle test data used here lives in google_sheets_services/FakeGoogle.js.
 * The transship test shows are:
 *   Two-show chain:   CHAINCO 2026 SPRING EXPO  →  CHAINCO 2026 SUMMER SHOW
 *   Three-show chain: TRICHAIN 2026 STAGE A  →  STAGE B  →  STAGE C
 *   Overlap show:     OVERLAPCO 2026 OVERLAP TEST  (overlaps SPRING EXPO's March window)
 *
 * FakeGoogle item quantities:
 *   SPRING EXPO:  TABLE-001=2, CHAIR-002=5
 *   SUMMER SHOW:  TABLE-001=3, CHAIR-002=4    → chain max: TABLE-001=3, CHAIR-002=5
 *   STAGE A:      STOOL-001=2, COUCH-001=1
 *   STAGE B:      STOOL-001=4, COUCH-001=2
 *   STAGE C:      STOOL-001=3, COUCH-001=1    → chain max: STOOL-001=4, COUCH-001=2
 *   OVERLAPCO:    TABLE-001=1
 *
 * Additional FakeGoogle fixtures used in Groups 17-20:
 *   ATSC 2025 NAB:                  CAB-004=11 (4+4+3 across crates 4/5/6)
 *   LOCKHEED MARTIN 2025 NGAUS:     TABLE-001=2 (two unquantified refs in primary tab)
 *   LOCKHEED MARTIN 2025 NGAUS MEETING ROOM:  TABLE-001=2
 *   AUSTAL 2026 SNA packlist tab  →  AUSTAL USA 2026 SURFACE NAVY schedule row (year 2026)
 *   AUSTAL 2023 WORKBOAT           (year 2023 — must NOT be matched by AUSTAL 2026 SNA)
 *   TEST CLIENT 2025 HIMSS packlist tab — client absent from index; falls back to raw name
 */

import { Requests } from '../data_management/api.js';
import { isAppOutdated, checkAppVersion } from '../data_management/index.js';
import { FakeGoogleSheetsAuth, setFakeDelaysEnabled } from '../google_sheets_services/FakeGoogle.js';
import { CacheInvalidationBus, ApplicationUtils, ProductionUtils, triggerCachePoll } from '../data_management/index.js';

// ── Runner ────────────────────────────────────────────────────────────────────

const _tests = [];

function test(group, name, fn) {
    _tests.push({ group, name, fn });
}

function assertEqual(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) throw new Error(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

function assertContains(arr, value, label) {
    if (!Array.isArray(arr) || !arr.includes(value))
        throw new Error(`${label}\n    expected array to contain: ${JSON.stringify(value)}\n    actual: ${JSON.stringify(arr)}`);
}

function assertNotContains(arr, value, label) {
    if (Array.isArray(arr) && arr.includes(value))
        throw new Error(`${label}\n    expected array NOT to contain: ${JSON.stringify(value)}\n    actual: ${JSON.stringify(arr)}`);
}

function assertFiniteNumber(val, label) {
    if (typeof val !== 'number' || !isFinite(val))
        throw new Error(`${label}\n    expected a finite number, got: ${JSON.stringify(val)}`);
}

function assertLessThan(val, threshold, label) {
    if (!(val < threshold))
        throw new Error(`${label}\n    expected ${val} < ${threshold}`);
}

// ── Group 0: Authentication ──────────────────────────────────────────────────
// Tests the full FakeGoogleSheetsAuth lifecycle. This group runs first and ends
// authenticated so all subsequent API-dependent groups have a valid session.
// The tests also confirm that the auth state machine transitions correctly and
// that silent refresh resets the token clock, which the real app relies on.

test('AUTH', 'checkAuth returns false before authenticate', async () => {
    await FakeGoogleSheetsAuth.logout();
    const result = await FakeGoogleSheetsAuth.checkAuth();
    assertEqual(result, false, 'checkAuth before authenticate');
});

test('AUTH', 'authenticate completes and returns true', async () => {
    const result = await FakeGoogleSheetsAuth.authenticate();
    assertEqual(result, true, 'authenticate() return value');
});

test('AUTH', 'checkAuth returns true after authenticate', async () => {
    const result = await FakeGoogleSheetsAuth.checkAuth();
    assertEqual(result, true, 'checkAuth after authenticate');
});

test('AUTH', 'getUserEmail returns the test account email', async () => {
    const email = await FakeGoogleSheetsAuth.getUserEmail();
    assertEqual(email, 'test@example.com', 'getUserEmail');
});

test('AUTH', 'token has time remaining after authenticate', async () => {
    const remaining = FakeGoogleSheetsAuth.getTokenSecondsRemaining();
    if (remaining <= 0) throw new Error(`expected > 0 seconds remaining, got ${remaining}`);
});

test('AUTH', 'silentRefresh returns true when authenticated', async () => {
    const result = await FakeGoogleSheetsAuth.silentRefresh();
    assertEqual(result, true, 'silentRefresh when authenticated');
});

test('AUTH', 'silentRefresh resets token to near-full time', async () => {
    // Let the token age slightly, then refresh and verify it was renewed
    await new Promise(r => setTimeout(r, 200));
    await FakeGoogleSheetsAuth.silentRefresh();
    const remaining = FakeGoogleSheetsAuth.getTokenSecondsRemaining();
    if (remaining < 3499) throw new Error(`expected ~3500s after silentRefresh, got ${remaining.toFixed(1)}s`);
});

test('AUTH', 'silentRefresh returns false when not authenticated', async () => {
    await FakeGoogleSheetsAuth.logout();
    const result = await FakeGoogleSheetsAuth.silentRefresh();
    assertEqual(result, false, 'silentRefresh when not authenticated');
    // Re-authenticate so subsequent test groups have a valid session
    await FakeGoogleSheetsAuth.authenticate();
});

// ── Group 1: Identifier Resolution ───────────────────────────────────────────
// computeIdentifier fuzzy-matches raw Show/Client/Year values against the Clients
// and Shows index tables. These tests confirm the canonical output used by all
// downstream identifier-keyed lookups (ScheduleOverrides, NameOverrides, etc.).

test('IDENTIFIER RESOLUTION', 'ChainCo/Spring Expo resolves to canonical form', async () => {
    const result = await Requests.computeIdentifier('Spring Expo', 'ChainCo', '2026');
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'computeIdentifier("Spring Expo", "ChainCo", "2026")');
});

test('IDENTIFIER RESOLUTION', 'ATSC/NAB resolves correctly', async () => {
    const result = await Requests.computeIdentifier('NAB', 'ATSC', '2025');
    assertEqual(result, 'ATSC 2025 NAB', 'computeIdentifier("NAB", "ATSC", "2025")');
});

test('IDENTIFIER RESOLUTION', 'Allen Arms/SHOT Show resolves correctly', async () => {
    const result = await Requests.computeIdentifier('SHOT Show', 'Allen Arms', '2025');
    assertEqual(result, 'ALLEN ARMS 2025 SHOT', 'computeIdentifier("SHOT Show", "Allen Arms", "2025")');
});

test('IDENTIFIER RESOLUTION', 'blank show name returns empty string', async () => {
    const result = await Requests.computeIdentifier('', 'ATSC', '2025');
    assertEqual(result, '', 'computeIdentifier("", "ATSC", "2025")');
});

// ── Group 2: Transship Chain Links ────────────────────────────────────────────
// getTransshipSourceForShow returns the source identifier for a destination show.
// getTransshipDestinationsForShow returns the destination for a source show.
// Both validate show ordering (source must precede destination by S.Start date)
// before returning; invalid or reversed links return null.

test('TRANSSHIP LINKS', 'destination show returns its source', async () => {
    const result = await Requests.getTransshipSourceForShow('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'getTransshipSourceForShow(SUMMER SHOW)');
});

test('TRANSSHIP LINKS', 'source show has no source', async () => {
    const result = await Requests.getTransshipSourceForShow('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, null, 'getTransshipSourceForShow(SPRING EXPO)');
});

test('TRANSSHIP LINKS', 'source show returns its destination', async () => {
    const result = await Requests.getTransshipDestinationsForShow('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, 'CHAINCO 2026 SUMMER SHOW', 'getTransshipDestinationsForShow(SPRING EXPO)');
});

test('TRANSSHIP LINKS', 'destination show has no further destination', async () => {
    const result = await Requests.getTransshipDestinationsForShow('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, null, 'getTransshipDestinationsForShow(SUMMER SHOW)');
});

test('TRANSSHIP LINKS', 'three-show chain: middle node source is Stage A', async () => {
    const result = await Requests.getTransshipSourceForShow('TRICHAIN 2026 STAGE B');
    assertEqual(result, 'TRICHAIN 2026 STAGE A', 'getTransshipSourceForShow(STAGE B)');
});

test('TRANSSHIP LINKS', 'three-show chain: middle node destination is Stage C', async () => {
    const result = await Requests.getTransshipDestinationsForShow('TRICHAIN 2026 STAGE B');
    assertEqual(result, 'TRICHAIN 2026 STAGE C', 'getTransshipDestinationsForShow(STAGE B)');
});

test('TRANSSHIP LINKS', 'end of three-show chain has no destination', async () => {
    const result = await Requests.getTransshipDestinationsForShow('TRICHAIN 2026 STAGE C');
    assertEqual(result, null, 'getTransshipDestinationsForShow(STAGE C)');
});

test('TRANSSHIP LINKS', 'unlinked show returns null', async () => {
    const result = await Requests.getTransshipSourceForShow('ATSC 2025 NAB');
    assertEqual(result, null, 'getTransshipSourceForShow(ATSC 2025 NAB)');
});

// ── Group 3: Chain-Aware Ship and Returns ────────────────────────────────
// getProjectShipDate walks the ScheduleOverrides source chain and returns the
// earliest ship date (the chain root's date). getProjectReturnDate walks the
// destination chain and returns the latest return date (the last show's date).
// This ensures items are treated as unavailable for the full duration of
// all shows in the chain, not just the individual show.

test('CHAIN DATES', 'destination show uses source ship date', async () => {
    const result = await Requests.getProjectShipDate('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, '2026-03-01', 'getProjectShipDate(SUMMER SHOW) should resolve to SPRING EXPO ship date');
});

test('CHAIN DATES', 'source show returns own ship date', async () => {
    const result = await Requests.getProjectShipDate('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, '2026-03-01', 'getProjectShipDate(SPRING EXPO)');
});

test('CHAIN DATES', 'source show return extends to destination return date', async () => {
    const result = await Requests.getProjectReturnDate('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, '2026-06-11', 'getProjectReturnDate(SPRING EXPO) should resolve to SUMMER SHOW return date');
});

test('CHAIN DATES', 'destination show returns own return date', async () => {
    const result = await Requests.getProjectReturnDate('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, '2026-06-11', 'getProjectReturnDate(SUMMER SHOW)');
});

test('CHAIN DATES', 'three-show chain: end show ship date resolves to Stage A', async () => {
    const result = await Requests.getProjectShipDate('TRICHAIN 2026 STAGE C');
    assertEqual(result, '2026-04-01', 'getProjectShipDate(STAGE C) should resolve to STAGE A ship date');
});

test('CHAIN DATES', 'three-show chain: root show return extends to Stage C', async () => {
    const result = await Requests.getProjectReturnDate('TRICHAIN 2026 STAGE A');
    assertEqual(result, '2026-06-16', 'getProjectReturnDate(STAGE A) should resolve to STAGE C return date');
});

// ── Group 4: Item Timeline Structure for Chain Shows ─────────────────────────
// getItemTimeline should produce exactly one Ships event per chain (from the root),
// a Transship event at each intermediate node's own return date (zero-delta), and
// a Returns event at the last node's return date. The Ships/Returns quantity is the
// chain max (highest qty across all members), not the root's own quantity alone.
// Destination shows must NOT appear as independent Ships events.

test('TIMELINE STRUCTURE', 'TABLE-001 Ships event originates from chain root', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const ships = events.filter(e => e.event === 'Ships' && e.note === 'CHAINCO 2026 SPRING EXPO');
    if (ships.length !== 1) throw new Error(`expected exactly 1 Ships event for SPRING EXPO, got ${ships.length}`);
});

test('TIMELINE STRUCTURE', 'TABLE-001 Ships quantity equals chain max (3, not root-only 2)', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'CHAINCO 2026 SPRING EXPO');
    if (!ship) throw new Error('Ships event for SPRING EXPO not found');
    assertEqual(ship.change, 'quantity: -3', 'Ships change should reflect chain max TABLE-001=3');
});

test('TIMELINE STRUCTURE', 'TABLE-001 has Transship event pointing to SUMMER SHOW', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const transship = events.find(e => e.event === 'Transship' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (!transship) throw new Error('Transship event pointing to SUMMER SHOW not found');
    assertEqual(transship.change, '', 'Transship event must not alter quantity');
});

test('TIMELINE STRUCTURE', 'TABLE-001 Returns event notes the last show in chain', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const ret = events.find(e => e.event === 'Returns' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (!ret) throw new Error('Returns event for SUMMER SHOW not found');
    assertEqual(ret.change, 'quantity: +3', 'Returns change should reflect chain max TABLE-001=3');
});

test('TIMELINE STRUCTURE', 'SUMMER SHOW does not appear as an independent Ships event', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const badShip = events.find(e => e.event === 'Ships' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (badShip) throw new Error('SUMMER SHOW should not have its own Ships event — it is a transship destination');
});

test('TIMELINE STRUCTURE', 'Transship event date precedes Returns date', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const transship = events.find(e => e.event === 'Transship' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    const ret = events.find(e => e.event === 'Returns' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (!transship || !ret) throw new Error('Transship or Returns event not found');
    if (transship.date >= ret.date) throw new Error(`Transship date (${transship.date}) must be before Returns date (${ret.date})`);
});

test('TIMELINE STRUCTURE', 'three-show chain: STOOL-001 Ships delta equals chain max (4)', async () => {
    const events = await Requests.getItemTimeline('STOOL-001', '2026-03-15', '2026-07-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'TRICHAIN 2026 STAGE A');
    if (!ship) throw new Error('Ships event for STAGE A not found');
    assertEqual(ship.change, 'quantity: -4', 'Ships change should reflect chain max STOOL-001=4');
});

test('TIMELINE STRUCTURE', 'three-show chain: two Transship events in order A→B, B→C', async () => {
    const events = await Requests.getItemTimeline('STOOL-001', '2026-03-15', '2026-07-01');
    const toB = events.find(e => e.event === 'Transship' && e.note === 'TRICHAIN 2026 STAGE B');
    const toC = events.find(e => e.event === 'Transship' && e.note === 'TRICHAIN 2026 STAGE C');
    if (!toB) throw new Error('Transship event pointing to STAGE B not found');
    if (!toC) throw new Error('Transship event pointing to STAGE C not found');
    if (toB.date >= toC.date) throw new Error(`Stage A→B transship (${toB.date}) must precede Stage B→C (${toC.date})`);
});

// ── Group 5: Overlap Conflict Detection ──────────────────────────────────────
// getItemOverlappingPacklists returns shows that (a) overlap the current show's
// date window AND (b) use the specified item. Transship destination shows must be
// skipped — their demand is already represented by the chain root. The chain root's
// transship source must also be excluded (it is the current show's own supply chain,
// not a competing show). All identifiers in results must be canonical schedule ids.

test('OVERLAP DETECTION', 'OVERLAPCO conflict list includes SPRING EXPO (chain root)', async () => {
    const result = await Requests.getItemOverlappingPacklists('OVERLAPCO 2026 OVERLAP TEST', 'TABLE-001');
    assertContains(result, 'CHAINCO 2026 SPRING EXPO',
        'getItemOverlappingPacklists(OVERLAPCO, TABLE-001) should include SPRING EXPO');
});

test('OVERLAP DETECTION', 'OVERLAPCO conflict list does not include SUMMER SHOW (destination)', async () => {
    const result = await Requests.getItemOverlappingPacklists('OVERLAPCO 2026 OVERLAP TEST', 'TABLE-001');
    assertNotContains(result, 'CHAINCO 2026 SUMMER SHOW',
        'SUMMER SHOW is a transship destination and must not appear as a separate conflict');
});

test('OVERLAP DETECTION', 'SPRING EXPO conflict list includes OVERLAPCO', async () => {
    const result = await Requests.getItemOverlappingPacklists('CHAINCO 2026 SPRING EXPO', 'TABLE-001');
    assertContains(result, 'OVERLAPCO 2026 OVERLAP TEST',
        'getItemOverlappingPacklists(SPRING EXPO, TABLE-001) should include OVERLAPCO');
});

test('OVERLAP DETECTION', 'SUMMER SHOW conflict list excludes SPRING EXPO (own source)', async () => {
    // The transship source of SUMMER SHOW is SPRING EXPO; it must be excluded as competing demand
    const result = await Requests.getItemOverlappingPacklists('CHAINCO 2026 SUMMER SHOW', 'TABLE-001');
    assertNotContains(result, 'CHAINCO 2026 SPRING EXPO',
        'SPRING EXPO is SUMMER SHOWs transship source — not competing demand');
});

// ── Group 6: Remaining Quantity ───────────────────────────────────────────────
// calculateRemainingQuantity uses the timeline min-quantity pathway: it finds the
// worst-case available quantity across [referenceDate, chainReturnDate]. The chain
// always accounts for all members (ship date = earliest, return = latest, qty = max).
// SPRING EXPO's chain needs 3 TABLE-001 but inventory only has 2, so remaining < 2.

test('REMAINING QUANTITY', 'returns a finite number for a chain root show', async () => {
    const result = await Requests.calculateRemainingQuantity('CHAINCO 2026 SPRING EXPO', 'TABLE-001', '2026-03-01');
    assertFiniteNumber(result, 'calculateRemainingQuantity(SPRING EXPO, TABLE-001)');
});

test('REMAINING QUANTITY', 'chain show over-demand produces negative remaining', async () => {
    // Inventory has 2 TABLE-001; chain needs 3 → worst-case remaining must be < 2
    const result = await Requests.calculateRemainingQuantity('CHAINCO 2026 SPRING EXPO', 'TABLE-001', '2026-03-01');
    assertLessThan(result, 2, 'remaining TABLE-001 for SPRING EXPO chain should be < 2 (needs 3, has 2)');
});

test('REMAINING QUANTITY', 'returns a finite number for an unlinked show', async () => {
    const result = await Requests.calculateRemainingQuantity('ATSC 2025 NAB', 'TABLE-001', '2026-01-10');
    assertFiniteNumber(result, 'calculateRemainingQuantity(ATSC 2025 NAB, TABLE-001)');
});

// ── Group 7: Inventory Data Integrity ────────────────────────────────────────
// Basic sanity checks that the inventory layer is intact and returns the correct
// quantities from FakeGoogle. These catch regressions in unrelated refactors that
// accidentally alter the inventory data path.

test('INVENTORY DATA', 'TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getInventoryInfo('TABLE-001', ['quantity']);
    const row = rows?.find(r => r.itemName === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in inventory');
    assertEqual(row.quantity, '2', 'TABLE-001 quantity');
});

test('INVENTORY DATA', 'STOOL-001 quantity is 12', async () => {
    const rows = await Requests.getInventoryInfo('STOOL-001', ['quantity']);
    const row = rows?.find(r => r.itemName === 'STOOL-001');
    if (!row) throw new Error('STOOL-001 not found in inventory');
    assertEqual(row.quantity, '12', 'STOOL-001 quantity');
});

test('INVENTORY DATA', 'CHAIR-002 quantity is 15', async () => {
    const rows = await Requests.getInventoryInfo('CHAIR-002', ['quantity']);
    const row = rows?.find(r => r.itemName === 'CHAIR-002');
    if (!row) throw new Error('CHAIR-002 not found in inventory');
    assertEqual(row.quantity, '15', 'CHAIR-002 quantity');
});

test('INVENTORY DATA', 'COUCH-001 quantity is 2', async () => {
    const rows = await Requests.getInventoryInfo('COUCH-001', ['quantity']);
    const row = rows?.find(r => r.itemName === 'COUCH-001');
    if (!row) throw new Error('COUCH-001 not found in inventory');
    assertEqual(row.quantity, '2', 'COUCH-001 quantity');
});

// ── Group 8: Multi-Booth Override Linking ────────────────────────────────────
// When a schedule row has two associated packlist tabs — one matched naturally by name
// and one linked via NameOverride — both tabs must be included. Quantities from all
// tabs for the same show are SUMMED (not maxed), because both booths are active
// simultaneously and their items come from the same warehouse stock.
//
// FakeGoogle data: MULTIBOOTHCO 2026 MULTI BOOTH
//   Primary tab (natural match):      CHAIR-001=5
//   Secondary tab (NameOverride):     CHAIR-001=2, STOOL-002=4
//   Expected combined:                CHAIR-001=7 (5+2), STOOL-002=4

test('MULTI BOOTH', 'items from both tabs are summed in the timeline Ships event', async () => {
    // If both tabs are included, CHAIR-001 Ships change = 'quantity: -7' (5+2)
    const events = await Requests.getItemTimeline('CHAIR-001', '2026-10-01', '2026-11-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'MULTIBOOTHCO 2026 MULTI BOOTH');
    if (!ship) throw new Error('Ships event for MULTIBOOTHCO not found');
    assertEqual(ship.change, 'quantity: -7', 'Ships change should sum both tabs: primary(5) + secondary(2) = 7');
});

test('MULTI BOOTH', 'item from override-only tab appears in the timeline', async () => {
    // STOOL-002 exists only in the NameOverride-linked secondary tab
    const events = await Requests.getItemTimeline('STOOL-002', '2026-10-01', '2026-11-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'MULTIBOOTHCO 2026 MULTI BOOTH');
    if (!ship) throw new Error('Ships event for MULTIBOOTHCO not found for STOOL-002 — secondary tab was not included');
    assertEqual(ship.change, 'quantity: -4', 'Ships change should be -4 (from secondary tab only)');
});

test('MULTI BOOTH', 'override-linked tab does not displace the natural-match tab', async () => {
    // After adding the override, the natural-match tab MUST still be present.
    // If findPacklistTabsForScheduleRow incorrectly early-returned on the override, CHAIR-001 would be -2 not -7.
    const events = await Requests.getItemTimeline('CHAIR-001', '2026-10-01', '2026-11-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'MULTIBOOTHCO 2026 MULTI BOOTH');
    if (!ship) throw new Error('Ships event for MULTIBOOTHCO not found');
    if (ship.change === 'quantity: -2') throw new Error(
        'Ships change is -2 — override replaced the natural tab instead of adding to it. Both tabs must be included.'
    );
});

// ── Group 9: Packlist Text Extraction ────────────────────────────────────────
// extractItemNumber / extractQuantity parse the "(qty) ITEM-NUM description" format
// used in packlist cells. These are the foundation of the full extraction pipeline;
// a regression here silently corrupts all downstream timeline and quantity results.

test('PACKLIST EXTRACTION', 'item number extracted from formatted text', async () => {
    const result = await Requests.extractItemNumber('(3) TABLE-001 conference table');
    assertEqual(result, 'TABLE-001', 'extractItemNumber("(3) TABLE-001 conference table")');
});

test('PACKLIST EXTRACTION', 'quantity extracted from formatted text', async () => {
    const result = await Requests.extractQuantity('(3) TABLE-001 conference table');
    assertEqual(result, 3, 'extractQuantity("(3) TABLE-001 conference table")');
});

test('PACKLIST EXTRACTION', 'text with no item code returns null item number', async () => {
    const result = await Requests.extractItemNumber('no item code in this text');
    assertEqual(result, null, 'extractItemNumber with no recognizable item code');
});

test('PACKLIST EXTRACTION', 'item without qty prefix defaults to quantity 1', async () => {
    const result = await Requests.extractQuantity('TABLE-001 conference table');
    assertEqual(result, 1, 'extractQuantity without qty prefix defaults to 1');
});

// ── Group 9: Packlist Structure ───────────────────────────────────────────────
// getPackList returns an array of crate objects each containing an Items array.
// The crate structure is consumed by every downstream item-extraction function.
// FakeGoogle CHAINCO 2026 SPRING EXPO has 1 crate with 2 item rows.

test('PACKLIST STRUCTURE', 'SPRING EXPO returns non-empty array', async () => {
    const result = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
    if (!Array.isArray(result) || result.length === 0)
        throw new Error(`expected non-empty array, got ${JSON.stringify(result)}`);
});

test('PACKLIST STRUCTURE', 'each crate has an Items array', async () => {
    const result = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
    const allHaveItems = Array.isArray(result) && result.every(crate => Array.isArray(crate.Items));
    if (!allHaveItems) throw new Error('one or more crates missing Items array');
});

test('PACKLIST STRUCTURE', 'SPRING EXPO has 2 item rows total', async () => {
    const result = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
    const totalItems = (result || []).reduce((n, c) => n + c.Items.length, 0);
    assertEqual(totalItems, 2, 'CHAINCO SPRING EXPO total item rows');
});

test('PACKLIST STRUCTURE', 'nonexistent packlist returns null', async () => {
    const result = await Requests.getPackList('NONEXISTENT SHOW 9999 FAKE');
    assertEqual(result, null, 'getPackList for unknown identifier');
});

// ── Group 10: Inventory Routing ───────────────────────────────────────────────
// getTabNameForItem maps item numbers to their inventory tab via the INDEX prefix table.
// A regression here silently breaks getInventoryInfo, getItemTimeline, and calculateRemainingQuantity.
// FakeGoogle index: TABLE/CHAIR/STOOL/COUCH → FURNITURE, CAB → CABINETS.

test('INVENTORY ROUTING', 'TABLE-001 resolves to FURNITURE tab', async () => {
    const result = await Requests.getTabNameForItem('TABLE-001');
    assertEqual(result, 'FURNITURE', 'getTabNameForItem("TABLE-001")');
});

test('INVENTORY ROUTING', 'CHAIR-002 resolves to FURNITURE tab', async () => {
    const result = await Requests.getTabNameForItem('CHAIR-002');
    assertEqual(result, 'FURNITURE', 'getTabNameForItem("CHAIR-002")');
});

test('INVENTORY ROUTING', 'CAB-004 resolves to CABINETS tab', async () => {
    const result = await Requests.getTabNameForItem('CAB-004');
    assertEqual(result, 'CABINETS', 'getTabNameForItem("CAB-004")');
});

test('INVENTORY ROUTING', 'unknown item returns null', async () => {
    const result = await Requests.getTabNameForItem('NONEXISTENT-999');
    assertEqual(result, null, 'getTabNameForItem for unknown prefix');
});

// ── Group 11: Schedule Attachment ─────────────────────────────────────────────
// getShowDetails (packlist id → schedule row) is the reverse direction of computeIdentifier.
// Both code paths are independent and have historically diverged. checkPacklistExists
// uses the same path and gates the "Create Packlist" button in the UI.

test('SCHEDULE ATTACHMENT', 'getShowDetails returns row for known identifier', async () => {
    const result = await Requests.getShowDetails('CHAINCO 2026 SPRING EXPO');
    if (!result) throw new Error('expected non-null show details for CHAINCO 2026 SPRING EXPO');
    if (!result.Show) throw new Error('expected Show field in result');
});

test('SCHEDULE ATTACHMENT', 'getShowDetails returns null for unknown identifier', async () => {
    const result = await Requests.getShowDetails('NONEXISTENT 9999 FAKE SHOW');
    assertEqual(result, null, 'getShowDetails for unknown identifier');
});

test('SCHEDULE ATTACHMENT', 'checkPacklistExists returns true for SPRING EXPO', async () => {
    const row = { Show: 'Spring Expo', Client: 'ChainCo', Year: '2026', Identifier: 'CHAINCO 2026 SPRING EXPO' };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.exists, true, 'checkPacklistExists(SPRING EXPO).exists');
});

test('SCHEDULE ATTACHMENT', 'checkPacklistExists identifier matches packlist tab title', async () => {
    const row = { Show: 'Spring Expo', Client: 'ChainCo', Year: '2026', Identifier: 'CHAINCO 2026 SPRING EXPO' };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.identifier, 'CHAINCO 2026 SPRING EXPO', 'checkPacklistExists identifier field');
});

test('SCHEDULE ATTACHMENT', 'checkPacklistExists returns false for show with no packlist', async () => {
    // Allen Arms SHOT has a schedule row but no packlist tab in FakeGoogle
    const row = { Show: 'SHOT Show', Client: 'Allen Arms', Year: '2025', Identifier: 'ALLEN ARMS 2025 SHOT' };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.exists, false, 'checkPacklistExists(ALLEN ARMS 2025 SHOT).exists');
});

// ── Group 12: Item Min Quantity In Range ──────────────────────────────────────
// getItemMinQuantityInRange is the building block beneath calculateRemainingQuantity.
// Testing this layer separately ensures that a regression in the intermediate step
// shows up even if the top-level wrapper happens to produce the same wrong result.
// FakeGoogle: TABLE-001 inventory qty=2; SPRING EXPO chain needs 3 (min dips below 2).

test('ITEM MIN QUANTITY', 'TABLE-001 min during chain window is a finite number', async () => {
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2026-03-01', '2026-06-11');
    assertFiniteNumber(result, 'getItemMinQuantityInRange(TABLE-001, chain window)');
});

test('ITEM MIN QUANTITY', 'TABLE-001 min during chain window drops below inventory quantity', async () => {
    // Chain needs 3 TABLE-001, inventory has 2 — min must be < 2
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2026-03-01', '2026-06-11');
    assertLessThan(result, 2, 'TABLE-001 chain window min should be < 2');
});

test('ITEM MIN QUANTITY', 'TABLE-001 min in empty 2024 window equals inventory quantity', async () => {
    // No shows use TABLE-001 in 2024, so quantity stays at the raw inventory value
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2024-01-01', '2024-12-31');
    assertEqual(result, 2, 'TABLE-001 min in 2024 should equal inventory qty 2');
});

// ── Group 13: Sheet Locking ────────────────────────────────────────────────────
// getSheetLock gates all save operations. FakeGoogle has a lock fixture for
// PACK_LISTS:ATSC 2025 NAB held by locked.user@example.com.

test('SHEET LOCKING', 'locked tab returns a lock object', async () => {
    const result = await Requests.getSheetLock('PACK_LISTS', 'ATSC 2025 NAB');
    if (!result) throw new Error('expected lock object, got null');
});

test('SHEET LOCKING', 'locked tab returns the correct lock owner', async () => {
    const result = await Requests.getSheetLock('PACK_LISTS', 'ATSC 2025 NAB');
    assertEqual(result?.user, 'locked.user@example.com', 'lock owner for ATSC 2025 NAB');
});

test('SHEET LOCKING', 'unlocked tab returns null', async () => {
    const result = await Requests.getSheetLock('PACK_LISTS', 'CHAINCO 2026 SPRING EXPO');
    assertEqual(result, null, 'getSheetLock for tab with no lock');
});

test('SHEET LOCKING', 'currentUser matching lock owner returns null', async () => {
    // The current user is excluded — their own lock should not block themselves
    const result = await Requests.getSheetLock('PACK_LISTS', 'ATSC 2025 NAB', 'locked.user@example.com');
    assertEqual(result, null, 'own lock is excluded when currentUser matches');
});

// ── Group 14: Production Schedule Date Filters ───────────────────────────────
// getProductionScheduleData applies Ship/Return date-filter logic including
// calculated columns and year-boundary correction. FakeGoogle has SPRING EXPO
// (ship 3/1/2026) and ALLEN ARMS 2025 SHOT (ship 1/13/2025) as contrasting fixtures.

test('SCHEDULE FILTERS', 'null filter returns all shows', async () => {
    const result = await Requests.getProductionScheduleData(null);
    if (!Array.isArray(result) || result.length === 0)
        throw new Error('expected non-empty result for null filter');
});

test('SCHEDULE FILTERS', '2026 ship-date window includes SPRING EXPO', async () => {
    const result = await Requests.getProductionScheduleData({ dateFilters: [
        { column: 'Ship', type: 'after',  value: '2026-01-01' },
        { column: 'Ship', type: 'before', value: '2026-12-31' }
    ]});
    const identifiers = result.map(r => r.Identifier);
    assertContains(identifiers, 'CHAINCO 2026 SPRING EXPO', '2026 filter must include SPRING EXPO');
});

test('SCHEDULE FILTERS', '2026 ship-date window excludes 2025 shows', async () => {
    const result = await Requests.getProductionScheduleData({ dateFilters: [
        { column: 'Ship', type: 'after',  value: '2026-01-01' },
        { column: 'Ship', type: 'before', value: '2026-12-31' }
    ]});
    const identifiers = result.map(r => r.Identifier);
    assertNotContains(identifiers, 'ALLEN ARMS 2025 SHOT', '2026 filter must exclude ALLEN ARMS 2025 SHOT');
});

// ── Group 15: CAD Source History ──────────────────────────────────────────────
// checkCadSourceHistory returns an alert when the most-recent edit is from CAD
// and a prior web edit exists (a human's work may have been overwritten).
// The ATSC 2025 NAB packlist in FakeGoogle has a known cad-over-web fixture.

test('CAD SOURCE HISTORY', 'null input returns null', async () => {
    const result = await Requests.checkCadSourceHistory(null);
    assertEqual(result, null, 'checkCadSourceHistory(null)');
});

test('CAD SOURCE HISTORY', 'empty string returns null', async () => {
    const result = await Requests.checkCadSourceHistory('');
    assertEqual(result, null, 'checkCadSourceHistory("")');
});

test('CAD SOURCE HISTORY', 'most-recent cad after prior web returns alert', async () => {
    const history = JSON.stringify({ h: [
        { u: 'cadbot', t: 17309064100, s: 'cad', c: [{ n: 'Description', o: 'old cad value' }] },
        { u: 'dan',    t: 17309064000, s: 'web', c: [{ n: 'Description', o: 'original web value' }] }
    ]});
    const result = await Requests.checkCadSourceHistory(history);
    if (!result) throw new Error('expected alert object, got null');
    assertEqual(result.type, 'cad-source-change', 'alert type for cad-over-web');
});

test('CAD SOURCE HISTORY', 'cad with no prior web returns null', async () => {
    const history = JSON.stringify({ h: [
        { u: 'cadbot', t: 17309064100, s: 'cad', c: [{ n: 'Description', o: 'cad value' }] }
    ]});
    const result = await Requests.checkCadSourceHistory(history);
    assertEqual(result, null, 'cad-only history should return null');
});

test('CAD SOURCE HISTORY', 'most-recent web returns null', async () => {
    const history = JSON.stringify({ h: [
        { u: 'dan',    t: 17309064100, s: 'web', c: [{ n: 'Description', o: 'web value' }] },
        { u: 'cadbot', t: 17309064000, s: 'cad', c: [{ n: 'Description', o: 'cad value' }] }
    ]});
    const result = await Requests.checkCadSourceHistory(history);
    assertEqual(result, null, 'most-recent-web history should return null');
});

test('CAD SOURCE HISTORY', 'FakeGoogle ATSC NAB fixture produces cad alert', async () => {
    // FakeGoogle ATSC 2025 NAB first item row has a known cad-over-web EditHistory
    const crates = await Requests.getPackList('ATSC 2025 NAB');
    const firstItem = crates?.[0]?.Items?.[0];
    if (!firstItem) throw new Error('ATSC 2025 NAB first item row not found');
    const result = await Requests.checkCadSourceHistory(firstItem.EditHistory);
    if (!result) throw new Error('expected cad alert for ATSC NAB fixture item, got null');
    assertEqual(result.type, 'cad-source-change', 'ATSC NAB fixture cad alert type');
});

// ── Group 16: Deduplication ────────────────────────────────────────────────────
// getDeduplicatedShowDates collapses schedule rows with the same canonical show name
// and year into one entry (ignoring client). FakeGoogle has four rows for HIMSS year
// 2024 (Codametrix + Harmony Health + QGenda×2) that must all collapse to one entry.
// Ship-date window 2024-02-20 → 2024-03-01 isolates exactly those four rows.

test('DEDUPLICATION', 'returns an array', async () => {
    const result = await Requests.getDeduplicatedShowDates(null);
    if (!Array.isArray(result)) throw new Error('expected array from getDeduplicatedShowDates');
});

test('DEDUPLICATION', 'HIMSS 2024 four-row window collapses to one entry', async () => {
    const filter = { dateFilters: [
        { column: 'Ship', type: 'after',  value: '2024-02-20' },
        { column: 'Ship', type: 'before', value: '2024-03-01' }
    ]};
    const deduped = await Requests.getDeduplicatedShowDates(filter);
    assertEqual(deduped.length, 1, 'four HIMSS 2024 rows should deduplicate to exactly 1');
});

test('DEDUPLICATION', 'deduplicated count is less than raw schedule count', async () => {
    const raw    = await Requests.getProductionScheduleData(null);
    const deduped = await Requests.getDeduplicatedShowDates(null);
    if (deduped.length >= raw.length)
        throw new Error(`deduped (${deduped.length}) should be < raw (${raw.length})`);
});

// ── Group 17: Cross-Year Matching ─────────────────────────────────────────────
// findScheduleRowsForPacklist parses the year out of a packlist tab title and
// year-filters the schedule before matching. This prevents AUSTAL 2026 SNA from
// resolving to AUSTAL 2023 WORKBOAT despite both having similar client names.
// FakeGoogle has both shows; the 2026 match uses the 'SNA' abbreviation for
// 'SURFACE NAVY' in the Shows index.
// Production-utils comment: "IMPORTANT: Always prefer matches within the same year"

test('CROSS-YEAR MATCHING', 'AUSTAL 2026 SNA resolves to year 2026 show', async () => {
    const result = await Requests.getShowDetails('AUSTAL 2026 SNA');
    if (!result) throw new Error('expected non-null show details for AUSTAL 2026 SNA');
    assertEqual(result.Year, '2026', 'AUSTAL 2026 SNA Year field');
});

test('CROSS-YEAR MATCHING', 'AUSTAL 2026 SNA does not resolve to 2023 Workboat show', async () => {
    const result = await Requests.getShowDetails('AUSTAL 2026 SNA');
    if (result?.Year === '2023') throw new Error('AUSTAL 2026 SNA incorrectly matched 2023 Workboat row');
});

test('CROSS-YEAR MATCHING', 'AUSTAL 2026 SNA resolves to Surface Navy show name', async () => {
    const result = await Requests.getShowDetails('AUSTAL 2026 SNA');
    if (!result?.Show) throw new Error('expected Show field in result');
    // 'SNA' is an abbreviation for 'SURFACE NAVY' in the Shows index
    if (!result.Show.toUpperCase().includes('SURFACE') && !result.Show.toUpperCase().includes('NAVY'))
        throw new Error(`expected Surface Navy show, got: ${result.Show}`);
});

// ── Group 18: Unknown Client Fallback ─────────────────────────────────────────
// GetTopFuzzyMatch throws 'No good matches found' when no candidate clears the
// distance threshold. computeIdentifier catches that and substitutes the raw
// (normalized) client name so identifiers can still be formed for unindexed clients.
// FakeGoogle has 'Test Client' deliberately absent from the Clients index and a
// matching packlist tab 'TEST CLIENT 2025 HIMSS' to exercise this path.

test('UNKNOWN CLIENT FALLBACK', 'computeIdentifier with unindexed client does not throw', async () => {
    // Should complete without throwing; raw client name is the fallback
    let threw = false;
    try { await Requests.computeIdentifier('HIMSS', 'Test Client', '2025'); }
    catch (e) { threw = true; }
    if (threw) throw new Error('computeIdentifier threw for unindexed client');
});

test('UNKNOWN CLIENT FALLBACK', 'unindexed client falls back to raw name in identifier', async () => {
    // computeIdentifier does not uppercase the fallback — it uses the trimmed input as-is
    const result = await Requests.computeIdentifier('HIMSS', 'Test Client', '2025');
    assertEqual(result, 'Test Client 2025 HIMSS', 'computeIdentifier fallback for unknown client');
});

test('UNKNOWN CLIENT FALLBACK', 'packlist tab for unindexed client is found by getShowDetails', async () => {
    // The schedule row for Test Client has a blank Identifier column, so getShowDetails
    // must compute it via computeIdentifier (which falls back to raw name)
    const result = await Requests.getShowDetails('TEST CLIENT 2025 HIMSS');
    if (!result) throw new Error('expected show details for TEST CLIENT 2025 HIMSS');
});

// ── Group 19: Identifier Safety Regressions ──────────────────────────────────
// These tests guard against accidental aliasing where a non-existent show identifier
// is fuzzy-mapped onto an existing show for the same client/year (e.g. AAP -> AAO),
// and against stale Identifier fields creating duplicate analytics keys.

test('IDENTIFIER SAFETY', 'same-client/year show typo does not fuzzy-match to a different show', async () => {
    const candidates = ['LEICA 2026 AAO', 'LEICA 2026 CNS'];
    const result = await ProductionUtils.findBestProjectIdentifierMatch('LEICA 2026 AAP', candidates);
    assertEqual(result, null, 'findBestProjectIdentifierMatch should reject aliasing AAP -> AAO/CNS');
});

test('IDENTIFIER SAFETY', 'short show token does not fuzzy-alias AANS to AANA', async () => {
    const candidates = ['LEICA MICROSYSTEMS 2026 AANA'];
    const result = await ProductionUtils.findBestProjectIdentifierMatch('LEICA MICROSYSTEMS 2026 AANS', candidates);
    assertEqual(result, null, 'findBestProjectIdentifierMatch should reject AANS -> AANA short-token alias');
});

test('IDENTIFIER SAFETY', 'computeIdentifier preserves unmatched short show token instead of fuzzy-aliasing', async () => {
    const result = await Requests.computeIdentifier('AANS', 'Leica Microsystems', '2026');
    assertEqual(result, 'Leica Microsystems 2026 AANS', 'computeIdentifier should keep short unmatched show token AANS');
});

test('IDENTIFIER SAFETY', 'getShowDetails rejects non-existent same-client/year show typo', async () => {
    const result = await Requests.getShowDetails('CHAINCO 2026 SPRING EXPOO');
    assertEqual(result, null, 'getShowDetails should not map SPRING EXPOO to SPRING EXPO');
});

test('IDENTIFIER SAFETY', 'checkPacklistExists ignores stale row.Identifier and uses canonical schedule id', async () => {
    const row = {
        Show: 'Spring Expo',
        Client: 'ChainCo',
        Year: '2026',
        Identifier: 'CHAINCO 2026 SPRING EXP0'
    };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.exists, true, 'checkPacklistExists should still find canonical packlist');
    assertEqual(result.identifier, 'CHAINCO 2026 SPRING EXPO', 'checkPacklistExists should return canonical tab title');
});

test('IDENTIFIER SAFETY', 'deduplicateScheduleByShow uses canonical identifiers, not stale Identifier fields', async () => {
    const rows = [
        {
            Show: 'Spring Expo',
            Client: 'ChainCo',
            Year: '2026',
            Identifier: 'CHAINCO 2026 SPRING EXPO'
        },
        {
            Show: 'Spring Expo',
            Client: 'ChainCo',
            Year: '2026',
            Identifier: 'CHAINCO 2026 SPRING EXPO TYPO'
        }
    ];
    const deduped = await ProductionUtils.deduplicateScheduleByShow(rows);
    assertEqual(deduped.length, 1, 'deduplicateScheduleByShow should collapse stale-identifier duplicates');
});

// ── Group 20: Item Quantities Summary ─────────────────────────────────────────
// getItemQuantitiesSummary extracts item quantities from a single packlist tab.
// The extractItems loop explicitly skips EditHistory and MetaData fields to prevent
// old description values in the EditHistory JSON from being parsed as item codes.
// Tests cover: known simple extractions, EditHistory-skip regression (ATSC NAB),
// and the Lockheed suffix variant tabs (primary and MEETING ROOM).

test('ITEM QUANTITIES SUMMARY', 'SPRING EXPO TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getItemQuantitiesSummary('CHAINCO 2026 SPRING EXPO');
    const row = rows?.find(r => r.itemId === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in SPRING EXPO summary');
    assertEqual(row.quantity, 2, 'SPRING EXPO TABLE-001 quantity');
});

test('ITEM QUANTITIES SUMMARY', 'SPRING EXPO CHAIR-002 quantity is 5', async () => {
    const rows = await Requests.getItemQuantitiesSummary('CHAINCO 2026 SPRING EXPO');
    const row = rows?.find(r => r.itemId === 'CHAIR-002');
    if (!row) throw new Error('CHAIR-002 not found in SPRING EXPO summary');
    assertEqual(row.quantity, 5, 'SPRING EXPO CHAIR-002 quantity');
});

test('ITEM QUANTITIES SUMMARY', 'ATSC NAB CAB-004 quantity is 11 (EditHistory skip regression)', async () => {
    // Crates 4/5/6 contribute 4+4+3=11. EditHistory cells contain old description text;
    // if not skipped they could inflate this count.
    const rows = await Requests.getItemQuantitiesSummary('ATSC 2025 NAB');
    const row = rows?.find(r => r.itemId === 'CAB-004');
    if (!row) throw new Error('CAB-004 not found in ATSC NAB summary');
    assertEqual(row.quantity, 11, 'ATSC NAB CAB-004 quantity (4+4+3)');
});

test('ITEM QUANTITIES SUMMARY', 'Lockheed NGAUS primary tab TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getItemQuantitiesSummary('LOCKHEED MARTIN 2025 NGAUS');
    const row = rows?.find(r => r.itemId === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in LOCKHEED MARTIN 2025 NGAUS summary');
    assertEqual(row.quantity, 2, 'LOCKHEED NGAUS primary TABLE-001 quantity');
});

test('ITEM QUANTITIES SUMMARY', 'Lockheed NGAUS MEETING ROOM suffix tab TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getItemQuantitiesSummary('LOCKHEED MARTIN 2025 NGAUS MEETING ROOM');
    const row = rows?.find(r => r.itemId === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in LOCKHEED MARTIN 2025 NGAUS MEETING ROOM summary');
    assertEqual(row.quantity, 2, 'LOCKHEED NGAUS MEETING ROOM TABLE-001 quantity');
});

// ── Group 20: Timeline Balance Event ─────────────────────────────────────────
// getItemTimeline emits a Balance event at the window start whose quantity reflects
// the inventory level just before the window opens. The NOTE in inventory-utils reads:
// "Balance row is pushed AFTER Phase 4 so pre-window ship adjustments are captured
// in startQty before the anchor row is written."
// For TABLE-001 with no pre-2026 history in FakeGoogle, the balance must equal the
// raw inventory quantity (2) at the start of the chain window.

test('TIMELINE BALANCE', 'timeline includes a Balance event', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-03-01', '2026-06-30');
    const balance = events.find(e => e.event === 'Balance');
    if (!balance) throw new Error('expected Balance event in TABLE-001 timeline');
});

test('TIMELINE BALANCE', 'Balance event is dated at window start', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-03-01', '2026-06-30');
    const balance = events.find(e => e.event === 'Balance');
    if (!balance) throw new Error('Balance event not found');
    assertEqual(balance.date, '2026-03-01', 'Balance event date');
});

test('TIMELINE BALANCE', 'Balance quantity equals inventory quantity before any ships', async () => {
    // No TABLE-001 history exists before 2026-03-01 in FakeGoogle, so balance = inventory qty 2
    const events = await Requests.getItemTimeline('TABLE-001', '2026-03-01', '2026-06-30');
    const balance = events.find(e => e.event === 'Balance');
    if (!balance) throw new Error('Balance event not found');
    assertEqual(balance.quantity, 2, 'Balance quantity should equal inventory qty 2');
});

// ── Group 21: Available Tabs ──────────────────────────────────────────────────

test('AVAILABLE TABS', 'INVENTORY tabs include FURNITURE', async () => {
    const tabs = await Requests.getAvailableTabs('INVENTORY');
    if (!Array.isArray(tabs) || tabs.length === 0) throw new Error('expected non-empty tabs array');
    assertContains(tabs.map(t => t.title), 'FURNITURE', 'INVENTORY tabs must include FURNITURE');
});

test('AVAILABLE TABS', 'PACK_LISTS without hidden excludes _TEMPLATE', async () => {
    const tabs = await Requests.getAvailableTabs('PACK_LISTS', false);
    assertNotContains(tabs.map(t => t.title), '_TEMPLATE', 'hidden=false must exclude _TEMPLATE');
});

test('AVAILABLE TABS', 'PACK_LISTS with hidden includes _TEMPLATE', async () => {
    const tabs = await Requests.getAvailableTabs('PACK_LISTS', true);
    assertContains(tabs.map(t => t.title), '_TEMPLATE', 'hidden=true must include _TEMPLATE');
});

// ── Group 22: Inventory Tab and Index ────────────────────────────────────────

test('INVENTORY TAB AND INDEX', 'getInventoryTabData returns TABLE-001 with quantity 2', async () => {
    const rows = await Requests.getInventoryTabData('FURNITURE');
    const row = rows?.find(r => r.itemNumber === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in FURNITURE tab data');
    assertEqual(row.quantity, '2', 'TABLE-001 quantity in FURNITURE tab');
});

test('INVENTORY TAB AND INDEX', 'getInventoryIndexData includes TABLE→FURNITURE entry', async () => {
    const index = await Requests.getInventoryIndexData();
    const entry = index?.find(r => r.prefix === 'TABLE');
    if (!entry) throw new Error('TABLE prefix not found in inventory index');
    assertEqual(entry.tab, 'FURNITURE', 'TABLE prefix maps to FURNITURE');
});

test('INVENTORY TAB AND INDEX', 'InventoryCustomItemNumbers preference contains HARDWARE', async () => {
    const prefs = await Requests.getPreferences();
    const pref = prefs?.find(p => p.id === 'InventoryCustomItemNumbers');
    if (!pref) throw new Error('InventoryCustomItemNumbers preference not found');
    let tabs = [];
    try { tabs = JSON.parse(pref.value); } catch {}
    assertContains(tabs, 'HARDWARE', 'InventoryCustomItemNumbers must include HARDWARE');
});

test('INVENTORY TAB AND INDEX', 'getInventoryHiddenSearchData FURNITURE includes TABLE-001 item number', async () => {
    const fields = await Requests.getInventoryHiddenSearchData('FURNITURE');
    if (!Array.isArray(fields)) throw new Error('expected array from getInventoryHiddenSearchData');
    const entry = fields.find(f => f.fieldName === 'Item#' && f.value === 'TABLE-001');
    if (!entry) throw new Error('TABLE-001 item# field not found in FURNITURE hidden search data');
});

// ── Group 23: Item Details ────────────────────────────────────────────────────

test('ITEM DETAILS', 'getItemInventoryQuantity returns integer 2 for TABLE-001', async () => {
    const result = await Requests.getItemInventoryQuantity('TABLE-001');
    assertEqual(result, 2, 'getItemInventoryQuantity(TABLE-001)');
});

test('ITEM DETAILS', 'getItemInventoryQuantity returns null for unknown item', async () => {
    const result = await Requests.getItemInventoryQuantity('NONEXISTENT-999');
    assertEqual(result, null, 'getItemInventoryQuantity for unknown item');
});

test('ITEM DETAILS', 'getItemDescription returns inventory description for TABLE-001', async () => {
    const result = await Requests.getItemDescription('TABLE-001');
    if (!result || typeof result !== 'string') throw new Error(`expected non-null string, got ${JSON.stringify(result)}`);
    if (!result.toLowerCase().includes('table')) throw new Error(`unexpected description: ${result}`);
});

// ── Group 24: User Data ───────────────────────────────────────────────────────
// FakeGoogle has a CACHE/UserData_test_example_com tab with 'dashboard_containers' key.

test('USER DATA', 'getUserData returns stored value for test account', async () => {
    const result = await Requests.getUserData('test@example.com', 'dashboard_containers');
    if (result === null || result === undefined) throw new Error('expected non-null user data for dashboard_containers');
});

test('USER DATA', 'hasUserDataKey returns true for existing key', async () => {
    const result = await Requests.hasUserDataKey('test@example.com', 'dashboard_containers');
    assertEqual(result, true, 'hasUserDataKey for existing key');
});

test('USER DATA', 'hasUserDataKey returns false for nonexistent key', async () => {
    const result = await Requests.hasUserDataKey('test@example.com', 'definitely_nonexistent_key_xyz');
    assertEqual(result, false, 'hasUserDataKey for nonexistent key');
});

test('USER DATA', 'getUserDataByPrefix returns entry for dashboard prefix', async () => {
    const result = await Requests.getUserDataByPrefix('test@example.com', 'dashboard');
    if (result === null || result === undefined) throw new Error('expected match for prefix "dashboard"');
});

// ── Group 25: Hardware Inventory Resolution ───────────────────────────────────
// Hardware items use non-standard item number formats that fail the prefix lookup
// in getTabNameForItem and are resolved instead by scanning the HARDWARE tab's
// customItemNumbers flag. Three distinct failure modes have been found historically:
//
//   Multi-hyphen  VUE-V2C-LP / LED-EXL21-SL
//     Standard regex extracts only the first segment (VUE-V2C); that partial ID
//     has no tab match; hardware fallback catches the full item number.
//   Spaced-numeric  901 00 030 MKII / 615 11 01 ANO
//     Standard regex never fires (no [A-Z]+-digits prefix); direct hardware path.
//   Text-based  HH BOLTHOG M8 LONG / HH BOLTHOG 1-4 20 x 2.5
//     No standard prefix match; customItemNumbers scan finds exact row.
//     HH BOLTHOG 1-4 20 x 2.5 also tests the getItemInfo hyphen-split fallback:
//     split('-')[1] yields '4 20 x 2.5' which doesn't exist; code retries with
//     the full original item name.
//
// FakeGoogle HARDWARE quantities:
//   VUE-V2C-LP=20, 901 00 030 MKII=50, HH BOLTHOG M8 LONG=100, HH BOLTHOG 1-4 20 x 2.5=150
//
// FakeGoogle TEST 2025 ENHANCED packlist hardware quantities:
//   901 00 030 MKII=10, VUE-V2C-LP=3, HH BOLTHOG M8 LONG=25, HH BOLTHOG 1-4 20 x 2.5=15

test('HARDWARE INVENTORY', 'multi-hyphen item VUE-V2C-LP routes to HARDWARE tab', async () => {
    const result = await Requests.getTabNameForItem('VUE-V2C-LP');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("VUE-V2C-LP")');
});

test('HARDWARE INVENTORY', 'spaced-numeric item 901 00 030 MKII routes to HARDWARE tab', async () => {
    const result = await Requests.getTabNameForItem('901 00 030 MKII');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("901 00 030 MKII")');
});

test('HARDWARE INVENTORY', 'text-based item HH BOLTHOG M8 LONG routes to HARDWARE tab', async () => {
    const result = await Requests.getTabNameForItem('HH BOLTHOG M8 LONG');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("HH BOLTHOG M8 LONG")');
});

test('HARDWARE INVENTORY', 'hyphen-containing text item HH BOLTHOG 1-4 20 x 2.5 routes to HARDWARE tab', async () => {
    // split('-')[1] = '4 20 x 2.5' has no tab match; customItemNumbers fallback finds exact row
    const result = await Requests.getTabNameForItem('HH BOLTHOG 1-4 20 x 2.5');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("HH BOLTHOG 1-4 20 x 2.5")');
});

test('HARDWARE INVENTORY', 'getInventoryInfo returns correct quantity for multi-hyphen hardware item', async () => {
    // getItemInfo: split('-')[1]='V2C' not found → falls back to full original item name
    const rows = await Requests.getInventoryInfo('VUE-V2C-LP', ['quantity']);
    const row = rows?.find(r => r.itemName === 'VUE-V2C-LP');
    if (!row) throw new Error('VUE-V2C-LP not found in inventory info');
    assertEqual(row.quantity, '20', 'VUE-V2C-LP quantity');
});

test('HARDWARE INVENTORY', 'getInventoryInfo returns correct quantity for spaced-numeric hardware item', async () => {
    const rows = await Requests.getInventoryInfo('901 00 030 MKII', ['quantity']);
    const row = rows?.find(r => r.itemName === '901 00 030 MKII');
    if (!row) throw new Error('901 00 030 MKII not found in inventory info');
    assertEqual(row.quantity, '50', '901 00 030 MKII quantity');
});

test('HARDWARE INVENTORY', 'getInventoryInfo returns correct quantity for hyphen-containing text item', async () => {
    // getItemInfo hyphen-split fallback: split('-')[1]='4 20 x 2.5' not found; retries with full name
    const rows = await Requests.getInventoryInfo('HH BOLTHOG 1-4 20 x 2.5', ['quantity']);
    const row = rows?.find(r => r.itemName === 'HH BOLTHOG 1-4 20 x 2.5');
    if (!row) throw new Error('HH BOLTHOG 1-4 20 x 2.5 not found in inventory info');
    assertEqual(row.quantity, '150', 'HH BOLTHOG 1-4 20 x 2.5 quantity');
});

test('HARDWARE INVENTORY', 'extractItemNumber falls through to hardware for spaced-numeric item', async () => {
    // Standard regex [A-Z]+-[0-9...] never fires; hardware fallback catches the full item number
    const result = await Requests.extractItemNumber('(10) 901 00 030 MKII Mounting brackets');
    assertEqual(result, '901 00 030 MKII', 'extractItemNumber spaced-numeric hardware');
});

test('HARDWARE INVENTORY', 'extractItemNumber falls through to hardware for multi-hyphen item', async () => {
    // Standard regex matches partial VUE-V2C; that ID has no tab → hardware fallback catches VUE-V2C-LP
    const result = await Requests.extractItemNumber('(3) VUE-V2C-LP Low profile connectors');
    assertEqual(result, 'VUE-V2C-LP', 'extractItemNumber multi-hyphen hardware');
});

test('HARDWARE INVENTORY', 'extractItemNumber falls through to hardware for text-based HH item', async () => {
    const result = await Requests.extractItemNumber('(25) HH BOLTHOG M8 LONG Long bolts');
    assertEqual(result, 'HH BOLTHOG M8 LONG', 'extractItemNumber text-based hardware');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts 901 00 030 MKII correctly in TEST 2025 ENHANCED', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === '901 00 030 MKII');
    if (!row) throw new Error('901 00 030 MKII not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 10, 'TEST 2025 ENHANCED 901 00 030 MKII quantity');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts VUE-V2C-LP correctly in TEST 2025 ENHANCED', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === 'VUE-V2C-LP');
    if (!row) throw new Error('VUE-V2C-LP not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 3, 'TEST 2025 ENHANCED VUE-V2C-LP quantity');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts HH BOLTHOG M8 LONG correctly in TEST 2025 ENHANCED', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === 'HH BOLTHOG M8 LONG');
    if (!row) throw new Error('HH BOLTHOG M8 LONG not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 25, 'TEST 2025 ENHANCED HH BOLTHOG M8 LONG quantity');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts HH BOLTHOG 1-4 20 x 2.5 correctly in TEST 2025 ENHANCED', async () => {
    // Verifies the special-character hardware item (dot, spaces in item number) is extracted via hardware fallback
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === 'HH BOLTHOG 1-4 20 x 2.5');
    if (!row) throw new Error('HH BOLTHOG 1-4 20 x 2.5 not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 15, 'TEST 2025 ENHANCED HH BOLTHOG 1-4 20 x 2.5 quantity');
});

// ── Group 26: Thumbnail Records ───────────────────────────────────────────────
// FakeGoogle CACHE/Thumbnails has entries for TABLE-001 (file_id_table_001) and others.

test('THUMBNAIL RECORDS', 'getThumbnailRecord returns file id for TABLE-001', async () => {
    const result = await Requests.getThumbnailRecord('TABLE-001');
    if (!result) throw new Error('expected thumbnail record for TABLE-001, got null');
    assertEqual(result.file, 'file_id_table_001', 'getThumbnailRecord TABLE-001 file id');
});

test('THUMBNAIL RECORDS', 'getThumbnailRecord returns null for unknown item', async () => {
    const result = await Requests.getThumbnailRecord('NONEXISTENT-999');
    assertEqual(result, null, 'getThumbnailRecord for unknown item');
});

test('THUMBNAIL RECORDS', 'getAllThumbnailRecords returns array including TABLE-001', async () => {
    const records = await Requests.getAllThumbnailRecords();
    if (!Array.isArray(records) || records.length === 0) throw new Error('expected non-empty thumbnail records array');
    const entry = records.find(r => r.itemNumber === 'TABLE-001');
    if (!entry) throw new Error('TABLE-001 not found in all thumbnail records');
});

// ── Group 26: Row-Based Transship and Date Normalization ──────────────────────
// getTransshipSourceForScheduleRow / getTransshipDestinationsForScheduleRow accept
// a schedule row object instead of a canonical identifier. guessShipDate,
// normalizeStartDate, and normalizeEndDate apply year context to partial date strings.

test('ROW TRANSSHIP AND DATES', 'getTransshipSourceForScheduleRow from Summer Show row returns SPRING EXPO', async () => {
    const result = await Requests.getTransshipSourceForScheduleRow({
        Show: 'Summer Show', Client: 'ChainCo', Year: '2026'
    });
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'getTransshipSourceForScheduleRow(Summer Show)');
});

test('ROW TRANSSHIP AND DATES', 'getTransshipDestinationsForScheduleRow from Spring Expo row returns SUMMER SHOW', async () => {
    const result = await Requests.getTransshipDestinationsForScheduleRow({
        Show: 'Spring Expo', Client: 'ChainCo', Year: '2026'
    });
    assertEqual(result, 'CHAINCO 2026 SUMMER SHOW', 'getTransshipDestinationsForScheduleRow(Spring Expo)');
});

test('ROW TRANSSHIP AND DATES', 'guessShipDate returns full MM/DD/YYYY for explicit ship date', async () => {
    const result = await Requests.guessShipDate({
        Ship: '3/1/2026', Year: '2026', 'S. Start': '3/8', 'S. End': '3/11'
    });
    assertEqual(result, '03/01/2026', 'guessShipDate with explicit Ship field');
});

test('ROW TRANSSHIP AND DATES', 'normalizeStartDate returns full MM/DD/YYYY', async () => {
    const result = await Requests.normalizeStartDate({
        'S. Start': '3/8', 'S. End': '3/11', Year: '2026'
    });
    assertEqual(result, '03/08/2026', 'normalizeStartDate M/D with Year context');
});

test('ROW TRANSSHIP AND DATES', 'normalizeEndDate returns full MM/DD/YYYY', async () => {
    const result = await Requests.normalizeEndDate({
        'S. Start': '3/8', 'S. End': '3/11', Year: '2026'
    });
    assertEqual(result, '03/11/2026', 'normalizeEndDate M/D with Year context');
});

// ── Group 27: Packlist Convenience Queries ────────────────────────────────────

test('PACKLIST QUERIES', 'getPacklists with show-all returns non-empty array', async () => {
    const result = await Requests.getPacklists({ type: 'show-all' });
    if (!Array.isArray(result) || result.length === 0) throw new Error('expected non-empty packlists array');
});

test('PACKLIST QUERIES', 'getPacklists with null returns empty array by design', async () => {
    const result = await Requests.getPacklists(null);
    assertEqual(result.length, 0, 'getPacklists(null) should return empty array');
});

test('PACKLIST QUERIES', 'getItemHeaders returns array including Description', async () => {
    const result = await Requests.getItemHeaders('CHAINCO 2026 SPRING EXPO');
    if (!Array.isArray(result)) throw new Error('expected array from getItemHeaders');
    assertContains(result, 'Description', 'item headers must include Description');
});

test('PACKLIST QUERIES', 'resolvePacklistIdentifier returns canonical tab title', async () => {
    const result = await Requests.resolvePacklistIdentifier('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'resolvePacklistIdentifier canonical title');
});

test('PACKLIST QUERIES', 'getPacklistDescription returns string containing crate count', async () => {
    const result = await Requests.getPacklistDescription('CHAINCO 2026 SPRING EXPO');
    if (typeof result !== 'string' || result.length === 0) throw new Error(`expected non-empty string, got: ${JSON.stringify(result)}`);
    if (!result.includes('crate')) throw new Error(`expected "crate" in description, got: ${result}`);
});

test('PACKLIST QUERIES', 'getPacklistScheduleAttachment returns attached for known packlist', async () => {
    const result = await Requests.getPacklistScheduleAttachment('CHAINCO 2026 SPRING EXPO');
    assertEqual(result?.attached, true, 'CHAINCO 2026 SPRING EXPO must be attached');
});

test('PACKLIST QUERIES', 'getPacklistScheduleAttachment returns not-attached for _TEMPLATE', async () => {
    const result = await Requests.getPacklistScheduleAttachment('_TEMPLATE');
    assertEqual(result?.attached, false, '_TEMPLATE must not be attached');
    assertEqual(result?.hasIdentifierParts, false, '_TEMPLATE has no identifier structure');
});

// ── Group 28: Schedule Index Queries ─────────────────────────────────────────

test('SCHEDULE INDEX', 'getNameOverrides returns an array', async () => {
    const result = await Requests.getNameOverrides();
    if (!Array.isArray(result)) throw new Error(`expected array, got ${typeof result}`);
});

test('SCHEDULE INDEX', 'getAllScheduleIdentifiers includes CHAINCO 2026 SPRING EXPO', async () => {
    const result = await Requests.getAllScheduleIdentifiers();
    assertContains(result, 'CHAINCO 2026 SPRING EXPO', 'getAllScheduleIdentifiers must include SPRING EXPO');
});

test('SCHEDULE INDEX', 'getUnattachedPacklistTabNames does not include matched SPRING EXPO', async () => {
    const result = await Requests.getUnattachedPacklistTabNames();
    if (!Array.isArray(result)) throw new Error('expected array from getUnattachedPacklistTabNames');
    assertNotContains(result, 'CHAINCO 2026 SPRING EXPO', 'SPRING EXPO is attached and must not appear as unattached');
});

test('SCHEDULE INDEX', 'getOverrideTargets with packlist source returns schedule identifiers', async () => {
    const result = await Requests.getOverrideTargets('packlist');
    assertContains(result, 'CHAINCO 2026 SPRING EXPO', 'packlist override targets must include schedule identifiers');
});

test('SCHEDULE INDEX', 'getOverrideTargets with schedule source returns unattached packlists', async () => {
    const result = await Requests.getOverrideTargets('schedule');
    if (!Array.isArray(result)) throw new Error('expected array from getOverrideTargets(schedule)');
});

// ── Group 29: Locking Convenience Wrappers ────────────────────────────────────
// getPacklistLock and getInventoryLock are thin wrappers over getSheetLock with
// the spreadsheet name pre-filled. FakeGoogle has locks for both.

test('LOCK WRAPPERS', 'getPacklistLock returns lock for ATSC 2025 NAB', async () => {
    const result = await Requests.getPacklistLock('ATSC 2025 NAB');
    if (!result) throw new Error('expected lock object for ATSC 2025 NAB packlist');
    if (!result.user) throw new Error('expected lock to have user field');
});

test('LOCK WRAPPERS', 'getInventoryLock returns lock for CABINETS', async () => {
    const result = await Requests.getInventoryLock('CABINETS');
    if (!result) throw new Error('expected lock object for CABINETS inventory');
});

test('LOCK WRAPPERS', 'getInventoryLock returns null for unlocked category', async () => {
    const result = await Requests.getInventoryLock('FURNITURE');
    assertEqual(result, null, 'FURNITURE has no lock in FakeGoogle');
});

// ── Group 30: Hardware Extraction ─────────────────────────────────────────────
// extractHardwareFromText scans the HARDWARE tab for matching item numbers using
// pattern matching against non-standard item codes. FakeGoogle HARDWARE tab has
// '901 00 030 MKII' and 'HH BOLTHOG M8 LONG' as known fixtures.

test('HARDWARE EXTRACTION', '901 00 030 MKII extracted with correct quantity', async () => {
    const result = await Requests.extractHardwareFromText('(10) 901 00 030 MKII Mounting brackets');
    assertEqual(result.quantity, 10, 'extractHardwareFromText quantity');
    assertEqual(result.itemNumber, '901 00 030 MKII', 'extractHardwareFromText itemNumber');
});

test('HARDWARE EXTRACTION', 'HH BOLTHOG M8 LONG extracted with correct quantity', async () => {
    const result = await Requests.extractHardwareFromText('(3) HH BOLTHOG M8 LONG Long bolts');
    assertEqual(result.quantity, 3, 'HH BOLTHOG M8 LONG quantity');
    assertEqual(result.itemNumber, 'HH BOLTHOG M8 LONG', 'HH BOLTHOG M8 LONG itemNumber');
});

test('HARDWARE EXTRACTION', 'text with no hardware returns null itemNumber', async () => {
    const result = await Requests.extractHardwareFromText('plain text no hardware here');
    assertEqual(result.itemNumber, null, 'no hardware match returns null itemNumber');
});

// ── Group 31: Description Match ───────────────────────────────────────────────
// checkDescriptionMatch compares a packlist description against the inventory
// description for the same item and returns null on good match, alert on mismatch.

test('DESCRIPTION MATCH', 'exact inventory description returns null (no alert)', async () => {
    const result = await Requests.checkDescriptionMatch({
        'Extracted Item': 'TABLE-001',
        Description: 'Conference room table black 30 x 76 x 30'
    });
    assertEqual(result, null, 'exact description match should return null alert');
});

test('DESCRIPTION MATCH', 'unrelated description returns non-null alert', async () => {
    const result = await Requests.checkDescriptionMatch({
        'Extracted Item': 'TABLE-001',
        Description: 'rotating bar stool chrome legs adjustable height pneumatic'
    });
    if (!result) throw new Error('expected alert for mismatched description, got null');
    if (!result.type) throw new Error('alert must have a type field');
});

// ── Group 32: Inventory Level Check ──────────────────────────────────────────
// checkInventoryLevel returns null for suppressed items and an alert for shortages.
// FURNITURE is in InventorySuppressCategoryAnalysis preference; TABLE-001 maps to FURNITURE.
// CAB-004 during ATSC 2025 NAB window: 10 in stock, 22 needed (11 ATSC + 11 GEARFIRE same day).

test('INVENTORY LEVEL CHECK', 'suppressed item prefix returns null', async () => {
    // TABLE prefix has suppressAnalysis=true in FakeGoogle Inventory index
    const result = await Requests.checkInventoryLevel(
        { 'Extracted Item': 'TABLE-001' },
        'CHAINCO 2026 SPRING EXPO'
    );
    assertEqual(result, null, 'TABLE-001 (suppressAnalysis=true) must return null');
});

test('INVENTORY LEVEL CHECK', 'oversold CAB-004 during ATSC NAB returns shortage alert', async () => {
    // 10 CAB-004 in stock; ATSC NAB + GEARFIRE SHOT ship 22 on same date
    const result = await Requests.checkInventoryLevel(
        { 'Extracted Item': 'CAB-004' },
        'ATSC 2025 NAB'
    );
    if (!result) throw new Error('expected shortage alert for CAB-004 in ATSC 2025 NAB');
    assertEqual(result.type, 'item shortage', 'CAB-004 shortage alert type');
});

// ── Group 33: Page Notes ──────────────────────────────────────────────────────

test('PAGE NOTES', 'getPageNotes returns an array', async () => {
    // FakeGoogle Notes tab has only headers and no data rows
    const result = await Requests.getPageNotes();
    if (!Array.isArray(result)) throw new Error(`expected array, got ${typeof result}`);
});

// ── Group 34: Cache Invalidation ─────────────────────────────────────────────
// Each test warms an API cache entry, subscribes to CacheInvalidationBus,
// calls a mutation, then asserts that the correct api:* event fired.
// The bus fires synchronously inside invalidate(), so events are always
// captured before the mutation's await resolves — no timing gaps.
// Mutations use round-trip saves (read → write same data back) to stay
// idempotent: calculateRowDiff returns empty changes, so no edithistory
// is appended and FakeGoogle's mockData is effectively unchanged.

test('CACHE INVALIDATION', 'savePackList fires getPackList invalidation', async () => {
    await Requests.getPackList('CHAINCO 2026 SPRING EXPO'); // warm: registers dependency chain
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        const crates = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
        await Requests.savePackList(crates, 'CHAINCO 2026 SPRING EXPO');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getPackList'))
        throw new Error(`savePackList did not invalidate getPackList; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'storeUserData fires getUserData invalidation', async () => {
    await Requests.getUserData('test@example.com', 'dashboard_containers'); // warm
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // isolated throwaway key — no effect on other tests' user data
        await Requests.storeUserData([{ v: 'cache_test' }], 'test@example.com', 'cache_invalidation_test_key');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getUserData'))
        throw new Error(`storeUserData did not invalidate getUserData; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'saveInventoryTabData fires getInventoryInfo invalidation', async () => {
    await Requests.getInventoryInfo('TABLE-001', ['quantity']); // warm: registers full dependency chain
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        const rows = await Requests.getInventoryTabData('FURNITURE');
        await Requests.saveInventoryTabData(rows, 'FURNITURE'); // round-trip: empty diff → no edithistory change
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getInventoryInfo'))
        throw new Error(`saveInventoryTabData did not invalidate getInventoryInfo; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'createNewTab (tab mutation) fires getItemTimeline invalidation', async () => {
    // warm: Phase 4 of getItemTimeline calls extractChainItemsForIdentifier which calls
    // extractAllItemsForShow which calls deps.call(Database.getTabs, 'PACK_LISTS') —
    // this registers Database.getTabs as a transitive dependency of getItemTimeline.
    await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // hidden tab (starts with _) — excluded from getAvailableTabs(false) and getPacklists
        await Requests.createNewTab('PACK_LISTS', '_TEMPLATE', '_CACHE_INVALIDATION_TEST');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getItemTimeline'))
        throw new Error(`createNewTab did not invalidate getItemTimeline; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getAvailableTabs'))
        throw new Error(`createNewTab did not invalidate getAvailableTabs; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'setTransshipLink fires getTransshipSourceForShow and getItemTimeline invalidation', async () => {
    // warm: Phase 4 calls getTransshipSourceForShow via deps, registering ScheduleOverrides dependency
    await Requests.getTransshipSourceForShow('CHAINCO 2026 SUMMER SHOW');
    await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // fake identifiers — no real show rows, safe to create and remove
        await Requests.setTransshipLink('FAKE CACHE TEST DEST 9999', 'FAKE CACHE TEST SRC 9999');
    } finally {
        CacheInvalidationBus.off('api', handler);
        await Requests.removeTransshipLink('FAKE CACHE TEST DEST 9999').catch(() => {});
    }
    if (!fired.has('getTransshipSourceForShow'))
        throw new Error(`setTransshipLink did not invalidate getTransshipSourceForShow; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getItemTimeline'))
        throw new Error(`setTransshipLink did not invalidate getItemTimeline; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'addNameOverride fires getPacklistScheduleAttachment and getShowDetails invalidation', async () => {
    // warm: getNameOverrides must return non-empty so database:getData result gets cached
    // (CacheManager skips caching empty arrays, which breaks the invalidation cascade).
    // The sentinel row in FakeGoogle.NameOverrides ensures this.
    await Requests.getNameOverrides();
    await Requests.getPacklistScheduleAttachment('CHAINCO 2026 SPRING EXPO');
    await Requests.getShowDetails('CHAINCO 2026 SPRING EXPO');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // fake identifiers — no real schedule/packlist row to match, safe to add
        await Requests.addNameOverride('FAKE SCHED 9999', 'FAKE PACK 9999');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getPacklistScheduleAttachment'))
        throw new Error(`addNameOverride did not invalidate getPacklistScheduleAttachment; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getShowDetails'))
        throw new Error(`addNameOverride did not invalidate getShowDetails; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'appendScheduleReferenceAbbreviation fires computeIdentifier and getShowDetails invalidation', async () => {
    // warm: computeIdentifier calls computeIdentifierReferenceData which calls
    // deps.call(Database.getData, 'CACHE', 'Shows', ...) — registers Shows as dependency
    await Requests.computeIdentifier('Spring Expo', 'ChainCo', '2026');
    await Requests.getShowDetails('CHAINCO 2026 SPRING EXPO');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // isolated fake entry — distinct name/abbr ensures no collision with existing index entries
        await Requests.appendScheduleReferenceAbbreviation('show', 'FAKE SHOW FOR CACHE TEST 2099', 'FS2099');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('computeIdentifier'))
        throw new Error(`appendScheduleReferenceAbbreviation did not invalidate computeIdentifier; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getShowDetails'))
        throw new Error(`appendScheduleReferenceAbbreviation did not invalidate getShowDetails; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'remote Caching-tab timestamp for getTabs fires getPacklists via poller', async () => {
    // warm: PackListUtils.getPacklists calls deps.call(Database.getTabs, 'PACK_LISTS'),
    // registering database:getTabs:"PACK_LISTS" as a dependency of api:getPacklists.
    await Requests.getPacklists({ type: 'show-all' });

    // Simulate a remote write: writeCacheTimestamp adds +1s to Date.now() so the
    // poller's (remoteTs > entry.filled) comparison is always true.
    await ApplicationUtils.writeCacheTimestamp('database:getTabs:"PACK_LISTS"');

    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // triggerCachePoll() runs the interval logic immediately: reads CACHE/Caching,
        // finds the newer timestamp, and calls CacheManager.invalidateByPrefix which
        // cascades through the dependency chain to api:getPacklists.
        await triggerCachePoll();
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getPacklists'))
        throw new Error(`poller did not invalidate getPacklists; fired: ${[...fired].join(', ')}`);
});

// ── Group 35: Preferences ─────────────────────────────────────────────────────
// FakeGoogle CACHE/Preferences has 7 rows:
//   4 schedule* integer prefs (offsets 14, 14, 7, 7)
//   3 inventory* json prefs   (suppress, customItemNumbers, descriptionOnly)

test('PREFERENCES', 'getPreferences returns an array', async () => {
    const result = await Requests.getPreferences();
    if (!Array.isArray(result)) throw new Error(`expected array, got ${typeof result}`);
});

test('PREFERENCES', 'getPreferences returns 7 rows', async () => {
    const result = await Requests.getPreferences();
    assertEqual(result.length, 7, 'getPreferences row count');
});

test('PREFERENCES', 'all rows have required fields', async () => {
    const result = await Requests.getPreferences();
    for (const row of result) {
        if (!row.id) throw new Error(`row missing id: ${JSON.stringify(row)}`);
        if (!row.name) throw new Error(`row missing name: ${JSON.stringify(row)}`);
        if (!row.type) throw new Error(`row missing type: ${JSON.stringify(row)}`);
        if (!row.page) throw new Error(`row missing page: ${JSON.stringify(row)}`);
    }
});

test('PREFERENCES', 'ScheduleShipOffsetDaysFromShow has value "14" and type "integer"', async () => {
    const result = await Requests.getPreferences();
    const pref = result.find(r => r.id === 'ScheduleShipOffsetDaysFromShow');
    if (!pref) throw new Error('ScheduleShipOffsetDaysFromShow not found');
    assertEqual(pref.value, '14', 'ScheduleShipOffsetDaysFromShow value');
    assertEqual(pref.type, 'integer', 'ScheduleShipOffsetDaysFromShow type');
});

test('PREFERENCES', 'InventorySuppressCategoryAnalysis has type "json" and page "inventory*"', async () => {
    const result = await Requests.getPreferences();
    const pref = result.find(r => r.id === 'InventorySuppressCategoryAnalysis');
    if (!pref) throw new Error('InventorySuppressCategoryAnalysis not found');
    assertEqual(pref.type, 'json', 'InventorySuppressCategoryAnalysis type');
    assertEqual(pref.page, 'inventory*', 'InventorySuppressCategoryAnalysis page');
});

test('PREFERENCES', 'schedule prefs have page "schedule*"', async () => {
    const result = await Requests.getPreferences();
    const schedulePrefs = result.filter(r => r.id.startsWith('Schedule'));
    if (schedulePrefs.length === 0) throw new Error('no schedule preferences found');
    for (const p of schedulePrefs) {
        if (p.page !== 'schedule*') throw new Error(`expected page "schedule*" for ${p.id}, got "${p.page}"`);
    }
});

// ── App update: an out-of-date session refuses data writes ───────────────────
// A newer deploy is simulated by changing the version this session loaded (window.__deployedVersion),
// so version.json no longer matches it. Expected: isAppOutdated() is true and a write is refused with
// code APP_OUTDATED before it reaches the sheets; with the versions matching again, isAppOutdated()
// is false.

test('APP UPDATE', 'a data write is refused while a newer version is deployed', async () => {
    const loaded = window.__deployedVersion;
    window.__deployedVersion = 'test-older-version';
    let code = null;
    try {
        await checkAppVersion();
        assertEqual(isAppOutdated(), true, 'outdated');
        try {
            await Requests.saveData('CACHE', 'AppUpdateTest', [{ a: '1' }], { a: 'A' });
        } catch (error) {
            code = error.code;
        }
    } finally {
        window.__deployedVersion = loaded;
        await checkAppVersion();
    }
    assertEqual(code, 'APP_OUTDATED', 'refusal code');
    assertEqual(isAppOutdated(), false, 'current again');
});

// ── Runner export ─────────────────────────────────────────────────────────────

export async function runTests() {
    setFakeDelaysEnabled(false);
    try {
        // Ensure authenticated before any API-dependent tests run.
        // Auth tests below start with logout() so they still test from an unauthenticated state.
        await FakeGoogleSheetsAuth.authenticate();

        console.group('%c TopShelf Test Suite', 'font-weight:bold;color:#6366f1');

        let lastGroup = null;
        const failed = [];

        for (const { group, name, fn } of _tests) {
            if (group !== lastGroup) {
                if (lastGroup !== null) console.groupEnd();
                console.group(`[${group}]`);
                lastGroup = group;
            }
            try {
                await fn();
                console.log(`%c ✓ ${name}`, 'color:#22c55e');
            } catch (e) {
                console.error(`%c ✗ ${name}`, 'color:#ef4444', '\n  ', e.message);
                failed.push({ group, name, error: e.message });
            }
        }

        if (lastGroup !== null) console.groupEnd();

        const passed = _tests.length - failed.length;
        const style = failed.length ? 'color:#ef4444;font-weight:bold' : 'color:#22c55e;font-weight:bold';
        console.log(`%c ${passed} passed, ${failed.length} failed`, style);
        console.groupEnd();

        return { passed, failed };
    } finally {
        setFakeDelaysEnabled(true);
    }
}
