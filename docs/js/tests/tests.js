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
import { FakeGoogleSheetsAuth, FakeGoogleSheetsService, setFakeDelaysEnabled } from '../google_sheets_services/FakeGoogle.js';
import { isCheckedValue } from '../data_management/utils/checkbox-values.js';
import { useBatchEdits, useInstantEdits } from '../application/utils/cellEdits.js';
import { CacheInvalidationBus, ApplicationUtils, ProductionUtils, triggerCachePoll } from '../data_management/index.js';
import { resolveView, resolveAction, pickView, mergeView, matchesKeyPattern, setViewWarningHandler } from '../application/utils/views/resolveView.js';
import { SEARCH_LIMITS, searchWords, matchRow, matchRows, makeHighlighter } from '../application/utils/views/searchMatch.js';
import { formatValue, formatText } from '../application/utils/views/fieldFormat.js';
import { rowsToCards, bucketRowsToCards } from '../application/utils/views/cardsAdapter.js';
import { applyColorRule, colorFor, rowColorFor } from '../application/utils/views/viewColor.js';
import { containerTier, viewportTier, BREAKPOINTS } from '../application/utils/useContainerSize.js';
import { todayISOString, searchFilter, textFiltersToSearchParams, parseSearchParameters } from '../data_management/utils/helpers.js';
import { columnKind, columnKindsOfRows } from '../data_management/utils/checkbox-values.js';
import { instantWriteEntry, identityKey, cellKey, joinKey } from '../data_management/utils/instant-write-config.js';
import { estimateShipDate } from '../data_management/utils/ship-date.js';
import { getReactiveStore } from '../application/index.js';
import { withShipDate } from '../application/utils/scheduleShipping.js';

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
    assertEqual(result, '2026-06-18', 'getProjectReturnDate(SPRING EXPO) should resolve to SUMMER SHOW return date');
});

test('CHAIN DATES', 'destination show returns own return date', async () => {
    const result = await Requests.getProjectReturnDate('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, '2026-06-18', 'getProjectReturnDate(SUMMER SHOW)');
});

test('CHAIN DATES', 'three-show chain: end show ship date resolves to Stage A', async () => {
    const result = await Requests.getProjectShipDate('TRICHAIN 2026 STAGE C');
    assertEqual(result, '2026-04-01', 'getProjectShipDate(STAGE C) should resolve to STAGE A ship date');
});

test('CHAIN DATES', 'three-show chain: root show return extends to Stage C', async () => {
    const result = await Requests.getProjectReturnDate('TRICHAIN 2026 STAGE A');
    assertEqual(result, '2026-06-26', 'getProjectReturnDate(STAGE A) should resolve to STAGE C return date');
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
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2026-03-01', '2026-06-18');
    assertFiniteNumber(result, 'getItemMinQuantityInRange(TABLE-001, chain window)');
});

test('ITEM MIN QUANTITY', 'TABLE-001 min during chain window drops below inventory quantity', async () => {
    // Chain needs 3 TABLE-001, inventory has 2 — min must be < 2
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2026-03-01', '2026-06-18');
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

test('INVENTORY TAB AND INDEX', 'category cards search item rows: getAllInventoryData has TABLE-001 in FURNITURE', async () => {
    // Category cards bucket the overview rows by tab and search them directly (views plan R2.12, D7)
    const rows = await Requests.getAllInventoryData(todayISOString());
    if (!Array.isArray(rows)) throw new Error('expected array from getAllInventoryData');
    const entry = rows.find(r => r.itemNumber === 'TABLE-001');
    if (!entry || String(entry.tab).toUpperCase() !== 'FURNITURE') throw new Error('TABLE-001 not found in FURNITURE rows');
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
    assertEqual(result.length, 10, 'getPreferences row count');
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

// ── Views system: pure functions (views-and-renderers-plan §4) ───────────────
// resolveView / resolveAction, the shared search matcher, value formatting,
// colour rules and size tiers. These are pure and run without the DOM; they lock in the
// contracts every renderer relies on.

const V_FIELDS = ['Show', 'Client', 'Ship', 'Recieved', 'S. Start', 'S. End', 'City', 'Size', 'Year', 'Booth#', 'AppData', 'packlist']
    .map(key => ({ key, label: key }));
const V_TABLE = {
    id: 'table', layout: 'table',
    columns: ['Show', 'Client', ['Ship', 'Recieved'], ['S. Start', 'S. End'], 'City', 'Size', 'packlist'],
    style: { Ship: { color: 'auto', width: 120 }, 'S*': { font: 'narrow' } },
    variants: { narrow: { columns: [['Show', 'Client'], ['Ship', 'Recieved'], ['S. Start', 'S. End'], 'packlist'] } }
};
const V_CAL = { id: 'calendar', layout: 'calendar', calendar: { start: 'S. Start', end: 'S. End', chip: [['Show', 'Client'], ['City', 'Size']] } };

function withViewWarnings(fn) {
    const warnings = [];
    setViewWarningHandler(m => warnings.push(m));
    try { return { result: fn(), warnings }; } finally { setViewWarningHandler(null); }
}

test('VIEWS ENGINE', 'tiers: columns shown, unlisted to details (rest), AppData always hidden', async () => {
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE));
    assertEqual(r.slots.map(s => s.lines), [[['Show']], [['Client']], [['Ship'], ['Recieved']], [['S. Start'], ['S. End']], [['City']], [['Size']], [['packlist']]], 'slots');
    assertEqual(r.details.map(f => f.key), ['Year', 'Booth#'], 'details rest');
    assertEqual(r.hidden.has('AppData'), true, 'AppData hidden');
    assertEqual(r.hasDetails, true, 'hasDetails');
});

test('VIEWS ENGINE', 'hidden list removes fields from every tier; hidden rest hides unlisted', async () => {
    const { result: r1 } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, hidden: ['Year'] }));
    assertEqual(r1.details.map(f => f.key), ['Booth#'], 'Year hidden');
    const { result: r2 } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, details: ['Year'], hidden: 'rest' }));
    assertEqual(r2.details.map(f => f.key), ['Year'], 'explicit details');
    assertEqual(r2.hidden.has('Booth#'), true, 'Booth# hidden by rest');
});

test('VIEWS ENGINE', 'first tier wins on duplicates and unknown keys are ignored with a warning', async () => {
    const { result: r, warnings } = withViewWarnings(() => resolveView(V_FIELDS, { id: 'x', layout: 'table', columns: ['Show', 'Nope', 'Show'], details: ['Show', 'Year'] }));
    assertEqual(r.slots.map(s => s.key), ['Show'], 'Show once');
    assertEqual(r.details.map(f => f.key).includes('Show'), false, 'Show not in details');
    if (!warnings.some(w => w.includes('"Nope"'))) throw new Error('expected unknown-key warning');
    if (!warnings.some(w => w.includes('duplicate key "Show"'))) throw new Error('expected duplicate warning');
});

test('VIEWS ENGINE', 'narrow variant replaces columns; medium/wide keep them', async () => {
    const { result: wide } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'wide' }));
    const { result: medium } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'medium' }));
    const { result: narrow } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'narrow' }));
    assertEqual(wide.slots.length, 7, 'wide');
    assertEqual(medium.slots.length, 7, 'medium');
    assertEqual(narrow.slots[0].lines, [['Show'], ['Client']], 'narrow stacks Client under Show');
    assertEqual(narrow.details.map(f => f.key).includes('City'), true, 'City moves to details when narrow');
});

test('VIEWS ENGINE', 'patches apply after variants and respect sizes', async () => {
    const patches = [{ patch: { columns: ['Client', 'Show'] }, sizes: ['narrow'] }, { patch: { hidden: ['Booth#'] } }];
    const { result: wide } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'wide', patches }));
    const { result: narrow } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'narrow', patches }));
    assertEqual(wide.slots.length, 7, 'narrow-only patch ignored when wide');
    assertEqual(wide.hidden.has('Booth#'), true, 'all-size patch applied');
    assertEqual(narrow.slots.map(s => s.key), ['Client', 'Show'], 'narrow patch applied');
});

test('VIEWS ENGINE', 'print variant applies last (PacklistTable items: Pack/Check shown when printing)', async () => {
    const fields = ['Pack', 'Check', 'Description', 'Packing/shop notes'].map(key => ({ key }));
    const view = { id: 'items', layout: 'table', hidden: ['Pack', 'Check'], variants: { narrow: { hidden: ['Pack', 'Check', 'Packing/shop notes'] }, print: { hidden: [] } } };
    const screen = withViewWarnings(() => resolveView(fields, view)).result;
    const printed = withViewWarnings(() => resolveView(fields, view, { print: true, size: 'narrow' })).result;
    assertEqual(screen.slots.map(s => s.key), ['Description', 'Packing/shop notes'], 'screen');
    assertEqual(printed.slots.map(s => s.key), ['Pack', 'Check', 'Description', 'Packing/shop notes'], 'print wins over narrow');
});

test('VIEWS ENGINE', 'mergeView merges objects deeply and replaces arrays', async () => {
    const merged = mergeView({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 });
    assertEqual(merged, { a: { b: 1, c: [3] }, d: 1, e: 2 }, 'merge');
});

test('VIEWS ENGINE', 'key patterns expand in lists and style', async () => {
    const fields = ['itemId', 'show_A', 'show_B', 'qty'].map(key => ({ key }));
    const { result: r } = withViewWarnings(() => resolveView(fields, { id: 'p', layout: 'table', columns: ['itemId', 'show_*'], style: { 'show_*': { columnColor: 'striped gray' }, show_B: { width: 50 } } }));
    assertEqual(r.slots.map(s => s.key), ['itemId', 'show_A', 'show_B'], 'pattern columns');
    assertEqual(r.style.show_B, { columnColor: 'striped gray', width: 50 }, 'pattern + exact style');
    assertEqual(matchesKeyPattern('show_*', 'show_X'), true, 'pattern match');
    assertEqual(matchesKeyPattern('show', 'show_X'), false, 'exact');
});

test('VIEWS ENGINE', 'table without columns shows every non-placed field', async () => {
    const { result: r } = withViewWarnings(() => resolveView([{ key: 'a' }, { key: 'b' }, { key: 'c' }], { id: 'all', layout: 'table', hidden: ['c'] }));
    assertEqual(r.slots.map(s => s.key), ['a', 'b'], 'all shown');
    assertEqual(r.hasDetails, false, 'no details');
});

test('VIEWS ENGINE', "action 'row' falls back to 'button' when editMode is not none", async () => {
    const { result: r, warnings } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, action: 'row' }, { editMode: 'batch' }));
    assertEqual(r.trigger, 'button', 'trigger');
    if (!warnings.some(w => w.includes("action 'row'"))) throw new Error('expected warning');
    const { result: r2 } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, action: 'row' }));
    assertEqual(r2.trigger, 'row', 'row allowed read-only');
});

test('VIEWS ENGINE', 'calendar view: chip lines shown, missing start/end flagged invalid', async () => {
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, V_CAL));
    assertEqual(r.shown, ['Show', 'Client', 'City', 'Size'], 'chip keys shown');
    assertEqual(r.invalid, null, 'valid');
    const { result: bad } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_CAL, calendar: { ...V_CAL.calendar, start: 'Nope' } }));
    assertEqual(bad.invalid, 'calendar-fields', 'invalid');
});

test('VIEWS ENGINE', 'pickView: view param, legacy layout fallback, unknown id → default', async () => {
    const reg = { id: 'schedule', default: 'table', views: [V_TABLE, V_CAL] };
    withViewWarnings(() => {
        assertEqual(pickView(reg, {}).id, 'table', 'default');
        assertEqual(pickView(reg, { view: 'calendar' }).id, 'calendar', 'view param');
        assertEqual(pickView(reg, { layout: 'calendar' }).id, 'calendar', 'layout fallback');
        assertEqual(pickView(reg, { view: 'bogus' }).id, 'table', 'unknown → default');
    });
});

test('VIEWS ENGINE', 'resolved output: stacked lines, style, sticky, colour rules, hidden omitted', async () => {
    const view = { ...V_TABLE, table: { sticky: { start: ['Show'] } } };
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, view));
    const ship = r.slots.find(s => s.key === 'Ship');
    assertEqual(ship.lines, [['Ship'], ['Recieved']], 'stack lines');
    assertEqual([ship.width, ship.color], [120, 'auto'], 'slot style');
    assertEqual(r.slots.find(s => s.key === 'Show').sticky, 'start', 'sticky');
    assertEqual(r.slots.some(s => s.key === 'AppData'), false, 'hidden omitted');
    assertEqual(r.shown.includes('Recieved'), true, 'stacked keys are shown');
    const { result: cal } = withViewWarnings(() => resolveView(V_FIELDS, V_CAL));
    assertEqual(cal.calendar.chip, [['Show', 'Client'], ['City', 'Size']], 'chip lines');
    const legacy = withViewWarnings(() => resolveView([{ key: 'a', width: 50 }], { id: 'l', layout: 'table' }));
    assertEqual([legacy.result.style.a, legacy.warnings.length > 0], [undefined, true], 'legacy field props ignored with a warning');
});

test('VIEWS ACTION', 'page action wins, then details, then none', async () => {
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE));
    assertEqual(resolveAction({ to: () => 'x' }, r).kind, 'navigate', 'to');
    assertEqual(withViewWarnings(() => resolveAction({ run: () => {}, label: 'Select' }, r)).result.label, 'Select', 'run label');
    assertEqual(resolveAction(null, r).kind, 'details', 'details');
    const { result: noDetails } = withViewWarnings(() => resolveView([{ key: 'a' }], { id: 'n', layout: 'table', columns: ['a'] }));
    assertEqual(resolveAction(null, noDetails).kind, 'none', 'none');
    assertEqual(resolveAction(null, noDetails, { hasRowDetails: true }).kind, 'details', 'row-details slot');
});

test('VIEWS ACTION', 'both to and run → to, with a warning', async () => {
    const { result: r } = withViewWarnings(() => resolveView([{ key: 'a' }], { id: 'n', layout: 'table', columns: ['a'] }));
    const { result: a, warnings } = withViewWarnings(() => resolveAction({ to: () => 'x', run: () => {} }, r));
    assertEqual(a.kind, 'navigate', 'to wins');
    if (!warnings.length) throw new Error('expected warning');
});

test('VIEWS SEARCH', 'makeHighlighter escapes, wraps matches and merges overlaps', async () => {
    const h = makeHighlighter(['ab', 'bc']);
    assertEqual(h('xABCx <b>'), 'x<span class="search-match">ABC</span>x &lt;b&gt;', 'merged, case-insensitive, escaped');
    assertEqual([makeHighlighter([])('<i>'), h(null), h(0)], ['&lt;i&gt;', '', '0'], 'no words only escapes');
    assertEqual(makeHighlighter(['a.b'])('a.b axb'), '<span class="search-match">a.b</span> axb', 'regex characters are literal');
});

test('VIEWS SEARCH', 'searchWords drops words shorter than 2 characters', async () => {
    assertEqual(searchWords('a TV  15 x'), ['tv', '15'], 'words');
    assertEqual(searchWords('a b'), [], 'inactive');
    assertEqual(SEARCH_LIMITS.minTermLength, 2, 'limit');
});

test('VIEWS SEARCH', 'matchRow: AND across words, shown vs details, arrays matched', async () => {
    const tiers = { shown: ['Show', 'Client'], details: ['Notes', 'Shows'] };
    const row = { Show: 'Expo', Client: 'ACME', Notes: 'blue booth', Shows: ['NAB 2025', 'CES'] };
    assertEqual(matchRow(row, tiers, ['acme', 'expo']).shownMatch, true, 'shown match');
    const d = matchRow(row, tiers, ['acme', 'booth']);
    assertEqual([d.matched, d.shownMatch, d.detailMatches], [true, false, ['Notes']], 'details-only');
    assertEqual(matchRow(row, tiers, ['nab']).matched, true, 'array element');
    assertEqual(matchRow(row, tiers, ['acme', 'zzz']).matched, false, 'AND');
});

test('VIEWS SEARCH', 'matchRows aborts a broad search over 100 rows', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ Show: 'S' + i, Client: i < 10 ? 'ACME' : 'other' }));
    const tiers = { shown: ['Show', 'Client'], details: [] };
    const precise = matchRows(rows, tiers, searchWords('acme'));
    assertEqual([precise.aborted, precise.matchCount], [false, 10], 'precise');
    const broad = matchRows(rows, tiers, searchWords('other'));
    assertEqual([broad.aborted, broad.matchCount, broad.results.length], [true, Infinity, 0], 'aborted');
    const small = matchRows(rows.slice(0, 50), tiers, searchWords('s'));
    assertEqual(small.active, false, 'single char inactive');
    const smallBroad = matchRows(rows.slice(10, 60), tiers, searchWords('other'));
    assertEqual(smallBroad.aborted, false, 'no abort at or under 100 rows');
});

test('VIEWS FORMAT', 'formatValue matches the table formatter', async () => {
    assertEqual(formatValue(null, { format: 'date' }), '', 'null');
    assertEqual(formatValue('2026-03-05', { format: 'date' }), '03/05/2026', 'date');
    assertEqual(formatValue('12.5', { format: 'currency' }), '$12.50', 'currency');
    assertEqual(formatValue('abc', {}), 'abc', 'passthrough');
    assertEqual(formatText(['a', 'b'], {}), 'a, b', 'array text');
});

test('VIEWS COLOR', 'colour rules: auto numbers/dates, value, literal; rowColor fallback', async () => {
    assertEqual(applyColorRule('auto', -1, { format: 'number' }), 'red', 'negative');
    assertEqual(applyColorRule('auto', 0, { format: 'number' }), 'orange', 'zero');
    assertEqual(applyColorRule('auto', 5, { format: 'number' }), '', 'positive');
    assertEqual(applyColorRule('auto', '', { format: 'number' }), '', 'blank');
    assertEqual(applyColorRule('value', 'gray', {}), 'gray', 'value');
    assertEqual(applyColorRule('purple', 'x', {}), 'purple', 'literal');
    const today = todayISOString();
    assertEqual(applyColorRule('auto', today, { format: 'date' }), 'red', 'date today');
    const resolved = { rowColor: { field: 'quantity', rule: 'auto', fallback: 'green' }, fieldMap: new Map([['quantity', { key: 'quantity', format: 'number' }]]), style: { quantity: { color: 'auto' } } };
    assertEqual(rowColorFor({ quantity: 3 }, resolved), 'green', 'fallback');
    assertEqual(rowColorFor({ quantity: -2 }, resolved), 'red', 'auto row');
    assertEqual(colorFor({ quantity: 0 }, { key: 'quantity', format: 'number' }, resolved), 'orange', 'cell colour');
});

test('VIEWS SIZE', 'container and viewport tiers use the shared breakpoints', async () => {
    assertEqual([containerTier(360), containerTier(599), containerTier(600), containerTier(999), containerTier(1000)], ['narrow', 'narrow', 'medium', 'medium', 'wide'], 'container');
    assertEqual([viewportTier(615), viewportTier(616), viewportTier(1023), viewportTier(1024)], ['narrow', 'medium', 'medium', 'wide'], 'viewport');
    assertEqual(BREAKPOINTS, { narrow: 600, wide: 1000, gutterCompact: 8, gutterFull: 12 }, 'constants');
});

test('VIEWS CARDS', 'rowsToCards: title, escaped content lines, footer, rowColor, decorations', async () => {
    const fields = [{ key: 'title' }, { key: 'ship' }, { key: 'desc', format: 'multiline' }, { key: '_status' }, { key: '_color' }];
    const view = { id: 'cards', layout: 'cards', cards: { card: [['title'], ['ship'], ['desc']], footer: [['_status']] }, hidden: ['_color'], rowColor: { field: '_color', rule: 'value' } };
    const r = withViewWarnings(() => resolveView(fields, view)).result;
    const rows = [{ title: 'ACME 2026 <EXPO>', ship: 'Ship: 1/2', desc: '2 crates<br>5 items', _status: 'Unsaved changes', _color: 'red', sheetId: 7 }];
    const decorations = (row, key) => key === null ? [{ message: 'Save', class: 'green', action: () => {} }, { status: true, message: 'Locked' }] : [];
    const [card] = rowsToCards(rows, r, { decorations, idKey: 'sheetId' });
    assertEqual(card.title, 'ACME 2026 <EXPO>', 'title is plain text');
    assertEqual(card.content, 'Ship: 1/2<br>2 crates<br>5 items', 'content lines, multiline breaks');
    assertEqual(card.contentFooter, 'Unsaved changes<br>Locked', 'footer line + status decoration');
    assertEqual(card.footerActions.map(a => a.label), ['Save'], 'footer actions');
    assertEqual([card.cardClass, card.id], ['red', 7], 'rowColor and id');
    const [escaped] = rowsToCards([{ title: 'x', ship: '<b>bold</b>', desc: '' }], r);
    assertEqual(escaped.content, '&lt;b&gt;bold&lt;/b&gt;', 'values escaped');
});

test('VIEWS CARDS', 'bucketRowsToCards: buckets by key, empty buckets seeded, no details', async () => {
    const fields = [{ key: 'tab' }, { key: 'itemNumber' }, { key: 'description' }];
    const r = withViewWarnings(() => resolveView(fields, { id: 'categories', layout: 'cards', cards: { bucketBy: 'tab' }, theme: 'purple' }, { theme: 'purple' })).result;
    const rows = [{ tab: 'FURNITURE', itemNumber: 'T-1' }, { tab: 'FURNITURE', itemNumber: 'C-1' }, { tab: 'SIGNS', itemNumber: 'S-1' }];
    const cards = bucketRowsToCards(rows, r, {
        bucketKeys: ['ADDITIONS', 'FURNITURE'],
        bucketLabel: k => k.charAt(0) + k.slice(1).toLowerCase(),
        bucketDecorations: (k, members) => members.length > 1 ? [{ status: true, message: members.length + ' items' }] : []
    });
    assertEqual(cards.map(c => c.title), ['Additions', 'Furniture', 'Signs'], 'titles in seed order then data order');
    assertEqual(cards.map(c => c.rows.length), [0, 2, 1], 'members');
    assertEqual(cards[1].contentFooter, '2 items', 'bucket decorations');
    assertEqual([cards[1].row.tab, cards[1].hasDetails, cards[1].cardClass], ['FURNITURE', false, 'purple'], 'synthetic row, no details');
});

// ── Instant write (views-and-renderers-plan §4.16) ───────────────────────────
// writeCellsVerified locates rows by identity (Client + Year + Show) and columns by header name,
// reads, writes, re-reads, and retries once if rows moved. These tests run against FakeGoogle's
// Production Schedule and restore every cell they touch.

const IW_DB = 'PROD_SCHED';
const IW_TAB = 'Production Schedule';
const IW_ROW = { Client: 'Gearfire', Year: '2025', Show: 'SHOT Show' };

// One verified cell write (a batch of one); resolves to its result
async function writeOneVerified(database, tab, row, column, value) {
    const [result] = await Requests.writeCellsVerified(database, tab, [{ row, column, value }]);
    return result;
}

function iwSheet() {
    return FakeGoogleSheetsService.mockData[IW_DB][IW_TAB];
}
function iwCell(row, header) {
    const sheet = iwSheet();
    const c = sheet[0].findIndex(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase() === header.toLowerCase());
    const r = sheet.findIndex((line, i) => i > 0 && line[0] === row.Show && line[1] === row.Client && String(line[2]) === row.Year);
    return { r, c, value: sheet[r]?.[c] };
}

test('INSTANT WRITE', 'checkbox reading: X/TRUE checked, any other value unchecked', async () => {
    assertEqual(['X', 'x', ' TRUE ', '-', 'N/a', '1/10', '', null].map(isCheckedValue), [true, true, true, false, false, false, false, false], 'isChecked');
});

test('INSTANT WRITE', 'a verified write changes one cell by identity and verifies it', async () => {
    const before = iwCell(IW_ROW, 'Elev');
    try {
        const res = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Elev', 'X');
        assertEqual(res.ok, true, 'ok');
        assertEqual(iwCell(IW_ROW, 'Elev').value, 'X', 'cell written');
        const res2 = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Elev', '');
        assertEqual([res2.ok, iwCell(IW_ROW, 'Elev').value], [true, ''], 'uncheck writes blank');
    } finally {
        iwSheet()[before.r][before.c] = before.value;
    }
});

test('INSTANT WRITE', 'refuses columns not listed in InstantWriteTables and tables without an entry', async () => {
    const r1 = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'City', 'X');
    assertEqual(r1, { ok: false, reason: 'column-not-writable' }, 'column refused');
    const r2 = await writeOneVerified(IW_DB, 'Some Other Tab', IW_ROW, 'Elev', 'X');
    assertEqual(r2, { ok: false, reason: 'no-config' }, 'no config');
});

test('INSTANT WRITE', 'duplicate identity is never guessed', async () => {
    const sheet = iwSheet();
    const src = iwCell(IW_ROW, 'Elev');
    const copy = [...sheet[src.r]];
    sheet.push(copy);
    try {
        const res = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Elev', 'X');
        assertEqual(res, { ok: false, reason: 'duplicate' }, 'duplicate');
        assertEqual(sheet[src.r][src.c], src.value, 'original untouched');
    } finally {
        sheet.splice(sheet.indexOf(copy), 1);
    }
});

test('INSTANT WRITE', 'row moved mid-write: re-located by identity and written correctly', async () => {
    const sheet = iwSheet();
    const before = iwCell(IW_ROW, 'Panels');
    const original = FakeGoogleSheetsService.getSheetData;
    let inserted = null;
    // The first single-row range read happens after the row was located: insert a row above it then.
    FakeGoogleSheetsService.getSheetData = async function (tableId, range) {
        if (!inserted && tableId === IW_DB && /!A\d+:/.test(range)) {
            inserted = new Array(sheet[0].length).fill('');
            inserted[0] = 'Inserted Show'; inserted[1] = 'Inserted Client'; inserted[2] = '2025';
            sheet.splice(1, 0, inserted);
        }
        return original.call(this, tableId, range);
    };
    try {
        const res = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Panels', 'X');
        assertEqual(res.ok, true, 'ok after retry');
        const after = iwCell(IW_ROW, 'Panels');
        assertEqual([after.r, after.value], [before.r + 1, 'X'], 'written at the moved row');
        assertEqual(inserted[after.c], '', 'inserted row untouched');
    } finally {
        FakeGoogleSheetsService.getSheetData = original;
        if (inserted) sheet.splice(sheet.indexOf(inserted), 1);
        const cur = iwCell(IW_ROW, 'Panels');
        sheet[cur.r][cur.c] = before.value;
    }
});

test('INSTANT WRITE', 'saveShowNote creates the row the first time, then updates it', async () => {
    const sheet = FakeGoogleSheetsService.mockData.CACHE.ShowNotes;
    const startLen = sheet.length;
    const id = 'TESTCO 2099 NOTE TEST';
    try {
        const r1 = await Requests.saveShowNote(id, 'first note');
        assertEqual(r1.ok, true, 'create ok');
        assertEqual(sheet.length, startLen + 1, 'row appended');
        const r2 = await Requests.saveShowNote(id, 'second note');
        assertEqual(r2.ok, true, 'update ok');
        assertEqual(sheet.length, startLen + 1, 'no second row');
        const notes = await Requests.getShowNotes();
        assertEqual(notes.find(n => n.Identifier === id)?.Note, 'second note', 'read back');
    } finally {
        const i = sheet.findIndex(r => r[0] === id);
        if (i > 0) sheet.splice(i, 1);
    }
});

test('INSTANT WRITE', 'design queue preferences are readable as json', async () => {
    const fields = await Requests.getJsonPreference('DesignQueueFields', []);
    assertContains(fields, 'Assignee', 'DesignQueueFields');
    const cfg = await Requests.getInstantWriteConfig('PROD_SCHED', 'Production Schedule');
    assertEqual(cfg.identity, ['Client', 'Year', 'Show'], 'identity');
    assertEqual(cfg.columns, ['Elev', 'Panels', 'Setups', 'Assignee'], 'columns');
});

// ── Instant-write preference, column kinds, ship estimate ────────────────────

test('INSTANT WRITE', 'InstantWriteTables: columns as a list, the older typed object still read', async () => {
    const key = 'PROD_SCHED/Production Schedule';
    assertEqual(instantWriteEntry({ [key]: { identity: ['Client', 'Year', 'Show', 'Size'], columns: ['Elev', 'Assignee'] } }, 'PROD_SCHED', 'Production Schedule'),
        { identity: ['Client', 'Year', 'Show', 'Size'], columns: ['Elev', 'Assignee'] }, 'list form');
    assertEqual(instantWriteEntry({ [key]: { identity: ['Client'], columns: { Elev: 'checkbox', Assignee: 'select' } } }, 'PROD_SCHED', 'Production Schedule'),
        { identity: ['Client'], columns: ['Elev', 'Assignee'] }, 'object form');
    assertEqual([instantWriteEntry({ [key]: { identity: [], columns: ['Elev'] } }, 'PROD_SCHED', 'Production Schedule'), instantWriteEntry({}, 'PROD_SCHED', 'Production Schedule')], [null, null], 'incomplete');
});

test('INSTANT WRITE', 'keys: identities match trimmed and case-insensitively; cells by normalized column', async () => {
    const id = ['Client', 'Year', 'Show'];
    const key = (row) => identityKey(id, k => row[k]);
    assertEqual(key({ Client: ' QGenda ', Year: 2025, Show: 'HIMSS' }), key({ Client: 'qgenda', Year: '2025', Show: 'himss ' }), 'same identity');
    assertEqual(key({ Client: 'A|B', Year: '', Show: 'C' }) === key({ Client: 'A', Year: 'B', Show: 'C' }), false, 'a value with | is not split');
    assertEqual(cellKey('r', 'Account  Manager'), cellKey('r', 'account manager'), 'column names normalized');
    assertEqual(joinKey('a', null, 1).split(''), ['a', '', '1'], 'parts');
});

test('INSTANT WRITE', 'column kinds come from the data', async () => {
    assertEqual(['X', '', '-', 'N/a'].map(v => columnKind([v, 'X'])), ['checkbox', 'checkbox', 'checkbox', 'checkbox'], 'checkbox values');
    assertEqual([columnKind(['', ' ']), columnKind(['-', 'N/A']), columnKind(['X', 'Alex'])], ['empty', 'text', 'text'], 'empty, never checked, mixed');
    assertEqual([columnKind(['X', 'X', '-', '8/1']), columnKind(['X', '1/10', '3/1', 'Done'])], ['checkbox', 'text'], 'a stray date, mostly dates');
    assertEqual(columnKindsOfRows([{ A: 'X', B: 'Bo', AppData: {} }, { A: '', B: '' }]), { A: 'checkbox', B: 'text' }, 'rows');
    const kinds = Object.fromEntries((await Requests.getColumnKinds('PROD_SCHED', 'Production Schedule')).map(k => [k.column, k.kind]));
    assertEqual([kinds.Elev, kinds.Panels, kinds.Setups, kinds.Client, kinds.Assignee], ['checkbox', 'checkbox', 'checkbox', 'text', 'text'], 'schedule kinds');
});

test('INSTANT WRITE', 'Ship shows the estimate (with year, from show dates when missing); transship uses the source end', async () => {
    const row = { Ship: '', 'S. Start': '3/20', 'S. End': '3/23', Year: '2026' };
    assertEqual(withShipDate(row).Ship, '03/06/2026', 'S. Start minus 14 days');
    assertEqual(withShipDate({ ...row, Ship: '3/1' }).Ship, '03/01/2026', 'sheet value gains its year');
    assertEqual(withShipDate({ ...row, AppData: { transshipSource: 'X', transshipSourceEndDate: '03/02/2026' } }).Ship, '03/02/2026', 'transship');
    assertEqual(estimateShipDate({ Year: '2026' }), null, 'no dates');
});

// ── Filters: same-column OR, is empty, checked / unchecked ───────────────────

test('FILTERS', 'filters on one column match rows meeting either; excludes still apply', async () => {
    const rows = [{ N: 'Bob' }, { N: '' }, { N: 'Ann' }, { N: 'Bobby' }];
    const sp = textFiltersToSearchParams([
        { column: 'N', values: ['bob'], type: 'contains' },
        { column: 'N', values: [], type: 'empty' },
        { column: 'N', values: ['bobby'], type: 'excludes' }
    ]);
    assertEqual(searchFilter(rows, sp).map(r => r.N), ['Bob', ''], 'Bob or empty, not Bobby');
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'N', values: [], type: 'empty' }])).map(r => r.N), [''], 'is empty alone');
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'N', values: [''], type: 'contains' }])).length, 4, 'a contains filter without a value is ignored');
});

test('FILTERS', 'checkbox filters: checked is X or TRUE, unchecked is anything else', async () => {
    const rows = [{ E: 'X' }, { E: '' }, { E: '-' }, { E: 'TRUE' }, { E: 'N/a' }];
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'E', type: 'checked' }])).map(r => r.E), ['X', 'TRUE'], 'checked');
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'E', type: 'unchecked' }])).map(r => r.E), ['', '-', 'N/a'], 'unchecked');
});

test('FILTERS', 'URL filter parameters keep same-column filters and value-less types', async () => {
    const sp = parseSearchParameters({ Col1: 'Client', Val1: 'a|b', Type1: 'contains', Col2: 'Client', Val2: '', Type2: 'empty' }).searchParams;
    assertEqual(sp, { Client: [{ values: ['a', 'b'], type: 'contains' }, { values: [], type: 'empty' }] }, 'grouped');
    const all = await Requests.getProductionScheduleData(null, null);
    const want = all.filter(r => isCheckedValue(r.Setups) && (/o/i.test(r.Client) || !String(r.Client).trim()));
    const data = await Requests.getProductionScheduleData(null, textFiltersToSearchParams([
        { column: 'Setups', type: 'checked' },
        { column: 'Client', values: ['o'], type: 'contains' },
        { column: 'Client', values: [], type: 'empty' }
    ]));
    assertEqual([data.length > 0, data.length], [true, want.length], 'schedule data filtered');
});

// ── Show notes: empty notes are removed, never appended ──────────────────────

function notesSheet() {
    return FakeGoogleSheetsService.mockData.CACHE.ShowNotes;
}
function notesSnapshot() {
    return notesSheet().map(r => r.slice());
}
function notesRestore(snap) {
    const s = notesSheet();
    s.length = 0;
    snap.forEach(r => s.push(r.slice()));
}

test('SHOW NOTES', 'clearing a note removes its row; an empty note is never appended', async () => {
    const snap = notesSnapshot();
    try {
        const id = 'TESTCO 2099 CLEAR TEST';
        await Requests.saveShowNote(id, 'to be cleared');
        assertEqual(notesSheet().some(r => r[0] === id), true, 'created');
        const res = await Requests.saveShowNote(id, '   ');
        assertEqual([res.ok, notesSheet().some(r => r[0] === id)], [true, false], 'row removed');
        const len = notesSheet().length;
        const res2 = await Requests.saveShowNote('TESTCO 2099 NEVER', '');
        assertEqual([res2.ok, notesSheet().length], [true, len], 'nothing appended');
        assertEqual(notesSheet()[0], ['Identifier', 'Note', 'EditHistory'], 'header kept');
    } finally {
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'any save removes rows with empty notes and keeps every other note', async () => {
    const snap = notesSnapshot();
    const s = notesSheet();
    try {
        s.push(['TESTCO 2099 EMPTY A', '', 'old history'], ['', '', ''], ['TESTCO 2099 KEEP', 'keep me', ''], ['TESTCO 2099 EMPTY B', ' ', '']);
        const res = await Requests.saveShowNote('TESTCO 2099 NEW', 'a new note');
        assertEqual(res.ok, true, 'ok');
        const ids = s.slice(1).map(r => r[0]);
        assertEqual(ids.filter(id => /EMPTY/.test(id)).length + ids.filter(id => !id).length, 0, 'empty rows removed');
        assertContains(ids, 'TESTCO 2099 KEEP', 'other note kept');
        assertEqual(s.find(r => r[0] === 'TESTCO 2099 NEW')?.[1], 'a new note', 'new note written');
        snap.slice(1).forEach(r => assertContains(ids, r[0], 'fixture note kept'));
    } finally {
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'rows moving before a removal never lose a note', async () => {
    const snap = notesSnapshot();
    const s = notesSheet();
    try {
        s.push(['TESTCO 2099 EMPTY', '', ''], ['TESTCO 2099 A', 'note a', ''], ['TESTCO 2099 B', 'note b', '']);
        let fired = false;
        const res = await withFaults({
            // Another save inserts a note at the top just before the removal: positions shift by one
            beforeDelete: () => { if (!fired) { fired = true; s.splice(1, 0, ['TESTCO 2099 OTHER', 'other note', '']); } }
        }, () => Requests.saveShowNote('TESTCO 2099 A', 'note a, edited'));
        assertEqual(res.ok, true, 'ok');
        const notes = Object.fromEntries(s.slice(1).map(r => [r[0], r[1]]));
        assertEqual([notes['TESTCO 2099 A'], notes['TESTCO 2099 B'], notes['TESTCO 2099 OTHER']], ['note a, edited', 'note b', 'other note'], 'every note present');
        snap.slice(1).forEach(r => assertEqual(notes[r[0]], r[1], 'fixture note ' + r[0]));
    } finally {
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'a note write that lands on a moved row is undone and retried', async () => {
    const snap = notesSnapshot();
    const s = notesSheet();
    try {
        s.push(['TESTCO 2099 FIRST', 'first note', ''], ['TESTCO 2099 TARGET', 'target note', '']);
        let fired = false;
        const res = await withFaults({
            beforeBatchWrite: (t) => { if (t === 'CACHE' && !fired) { fired = true; s.splice(1, 0, ['TESTCO 2099 INSERTED', 'inserted note', '']); } }
        }, () => Requests.saveShowNote('TESTCO 2099 TARGET', 'target, edited'));
        assertEqual(res.ok, true, 'ok');
        const notes = Object.fromEntries(s.slice(1).map(r => [r[0], r[1]]));
        assertEqual([notes['TESTCO 2099 TARGET'], notes['TESTCO 2099 FIRST'], notes['TESTCO 2099 INSERTED']], ['target, edited', 'first note', 'inserted note'], 'only the target changed');
    } finally {
        notesRestore(snap);
    }
});

// ── Cell edits (utils/cellEdits.js): batch and instant edits ─────────────────

const editWait = (ms) => new Promise(r => setTimeout(r, ms));

function batchHarness(rowKey = null) {
    const rows = [{ k: '1', A: 'x', MetaData: 'm' }, { k: '2', A: 'y' }];
    const originals = rows.map(r => ({ ...r }));
    const emitted = [];
    const edits = useBatchEdits({
        rows: () => rows,
        originalRows: () => originals,
        rowKey: () => rowKey,
        undoRoute: () => null,
        // The page writes its rows on cell-edit
        emitEdit: (i, key, value) => { emitted.push([i, key, value]); rows[i][key] = value; }
    });
    return { rows, emitted, edits };
}

test('CELL EDITS', 'batch: an edit marks the cell unsaved until it is back to the loaded value', async () => {
    const { edits, emitted } = batchHarness();
    edits.edit(0, 'A', 'z');
    assertEqual([edits.cellState(0, 'A'), edits.hasUnsaved.value, emitted.length], ['unsaved', true, 1], 'changed');
    edits.edit(0, 'A', 'x');
    assertEqual([edits.cellState(0, 'A'), edits.hasUnsaved.value], ['', false], 'back to loaded');
});

test('CELL EDITS', 'batch: revert, nested tables, and recompare (with MetaData)', async () => {
    const { rows, edits, emitted } = batchHarness();
    edits.edit(1, 'A', 'q');
    edits.revert(1, 'A');
    assertEqual([rows[1].A, edits.cellState(1, 'A'), emitted[emitted.length - 1]], ['y', '', [1, 'A', 'y']], 'reverted');
    edits.setNested(0, 'Items', true);
    assertEqual([edits.cellState(0, 'Items'), edits.hasUnsaved.value], ['unsaved', true], 'nested changed');
    edits.setNested(0, 'Items', false);
    assertEqual(edits.hasUnsaved.value, false, 'nested back');
    rows[0].MetaData = 'changed';
    edits.compareAll(['A']);
    assertEqual([edits.cellState(0, 'A'), edits.hasUnsaved.value], ['', true], 'MetaData counts as a change');
});

test('CELL EDITS', 'batch: loaded values follow the row key when rows move', async () => {
    const { rows, edits } = batchHarness('k');
    rows.reverse();
    assertEqual([edits.originalValue(rows[0], 0, 'A'), edits.originalValue(rows[1], 1, 'A')], ['y', 'x'], 'by key');
});

test('CELL EDITS', 'batch with a row key: moved rows mark the table, not cells; edits compare by key', async () => {
    const { rows, edits } = batchHarness('k');
    rows.reverse();
    edits.compareAll(['A']);
    assertEqual([edits.cellState(0, 'A'), edits.cellState(1, 'A'), edits.hasUnsaved.value], ['', '', true], 'moved: unsaved, no cells');
    edits.edit(0, 'A', 'q');
    assertEqual(edits.cellState(0, 'A'), 'unsaved', 'edit after a move');
    edits.edit(0, 'A', 'y');
    assertEqual(edits.cellState(0, 'A'), '', 'back to its own loaded value');
    rows.reverse();
    edits.compareAll(['A']);
    assertEqual(edits.hasUnsaved.value, false, 'order restored');
    rows.pop();
    edits.compareAll(['A']);
    assertEqual(edits.hasUnsaved.value, true, 'a removed row counts as a change');
});

function instantHarness(commit) {
    const rows = [{ id: 'a', Elev: '', Note: '' }, { id: 'b', Elev: 'X', Note: 'n' }];
    const calls = { commits: [], errors: [], refreshes: 0 };
    const edits = useInstantEdits({
        enabled: () => true,
        rows: () => rows,
        rowId: (r) => r.id,
        commitCells: async (entries) => {
            calls.commits.push(entries.map(e => `${e.row.id}.${e.key}=${e.value}`));
            return commit(entries);
        },
        derive: (r) => ({ ...r, done: r.Elev === 'X' }),
        field: (key) => (key === 'Elev' ? { key, label: 'Elev', cell: 'checkbox' } : { key, label: key }),
        delay: () => 20,
        modal: () => ({ error: (m) => calls.errors.push(m), alert: () => {} }),
        refresh: () => { calls.refreshes++; }
    });
    return { rows, calls, edits };
}
const allOk = async (entries) => entries.map(() => ({ ok: true }));

test('CELL EDITS', 'instant: edits show at once and nearby edits are written as one batch', async () => {
    const { rows, calls, edits } = instantHarness(allOk);
    edits.edit(rows[0], 'Elev', 'X');
    edits.edit(rows[1], 'Note', 'new');
    assertEqual([edits.cellState(rows[0], 'Elev'), edits.overlay(rows)[0]], ['unsaved', { id: 'a', Elev: 'X', Note: '', done: true }], 'shown and derived');
    await editWait(80);
    assertEqual(calls.commits, [['a.Elev=X', 'b.Note=new']], 'one batch');
    assertEqual(edits.cellState(rows[0], 'Elev'), '', 'saved');
    rows[0].Elev = 'X';
    rows[1].Note = 'new';
    edits.reconcile();
    assertEqual(Object.keys(edits.pending).length, 0, 'overlay dropped once the rows carry the values');
});

test('CELL EDITS', 'instant: a cell back to its loaded value within the delay is not written', async () => {
    const { rows, calls, edits } = instantHarness(allOk);
    edits.edit(rows[0], 'Elev', 'X');
    edits.edit(rows[0], 'Elev', '');
    edits.edit(rows[1], 'Elev', 'TRUE'); // checked, like the loaded X
    await editWait(80);
    assertEqual([calls.commits, Object.keys(edits.pending).length], [[], 0], 'nothing written');
});

test('CELL EDITS', 'instant: a failed write reverts, reports once and asks for a refresh', async () => {
    const { rows, calls, edits } = instantHarness(async (entries) => entries.map(() => ({ ok: false, reason: 'not-found' })));
    edits.edit(rows[0], 'Elev', 'X');
    await editWait(80);
    assertEqual([edits.cellState(rows[0], 'Elev'), edits.overlay(rows), calls.refreshes], ['failed', rows, 1], 'reverted');
    assertEqual(calls.errors.length === 1 && calls.errors[0].includes('Elev: the row was not found in the sheet'), true, 'message');
});

test('CELL EDITS', 'instant: an edit made while its cell is being written is written next', async () => {
    const { rows, calls, edits } = instantHarness(async (entries) => { await editWait(60); return entries.map(() => ({ ok: true })); });
    edits.edit(rows[0], 'Note', 'one');
    await editWait(40); // the write is in flight
    edits.edit(rows[0], 'Note', 'two');
    await editWait(250);
    assertEqual(calls.commits, [['a.Note=one'], ['a.Note=two']], 'two writes in order');
});

// ── Reactive stores: eviction ────────────────────────────────────────────────

test('REACTIVE STORES', 'an evicted store that is read loads again; an unread one stays evicted', async () => {
    const calls = { shown: 0, unread: 0 };
    const tag = Date.now();
    const shown = getReactiveStore(async () => { calls.shown++; return [{ a: 1 }]; }, null, [`evict-shown-${tag}`], null, false);
    const unread = getReactiveStore(async () => { calls.unread++; return [{ a: 1 }]; }, null, [`evict-unread-${tag}`], null, false);
    await shown.load();
    await unread.load();
    const el = document.createElement('div');
    const app = Vue.createApp({ render: () => Vue.h('span', String(shown.data.length)) });
    app.mount(el);
    try {
        shown.evict();
        unread.evict();
        await editWait(300);
        assertEqual([calls.shown, shown.data.length, el.textContent], [2, 1, '1'], 'rendered store reloaded');
        assertEqual([calls.unread, unread.needsReload], [1, true], 'unread store stays evicted');
    } finally {
        app.unmount();
    }
});

// ── Batched verified writes, fault injection, sheet health ───────────────────
// writeCellsVerified writes any cells of one tab as one batch with the same safety steps as a
// single cell. FakeGoogleSheetsService.faults injects what a concurrent editor could do to the
// live sheet mid-save (insert, sort, drop, duplicate, rename); the randomized test checks that no
// cell outside the batch ever changes in rows the save could know about, and that a change it
// can't undo (a row or column added mid-save) is always reported.

const IW_WRITABLE = ['Elev', 'Panels', 'Setups', 'Assignee'];

function iwHeaderIndex(name, header = iwSheet()[0]) {
    return header.findIndex(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase() === name.toLowerCase());
}
function iwIdentityKey(line) {
    return [line[0], line[1], line[2]].map(v => String(v ?? '').trim().toLowerCase()).join('|');
}
// Data rows (array references) whose Show + Client + Year is complete and unique
function iwUniqueRows() {
    const s = iwSheet();
    const counts = new Map();
    const complete = s.slice(1).filter(l => l && l[0] && l[1] && l[2]);
    complete.forEach(l => counts.set(iwIdentityKey(l), (counts.get(iwIdentityKey(l)) || 0) + 1));
    return complete.filter(l => counts.get(iwIdentityKey(l)) === 1);
}
function iwRowObj(line) {
    return { Show: line[0], Client: line[1], Year: String(line[2]) };
}
// Snapshot by row reference (faults move rows; writes change them in place) and restore in place
function iwSnapshot() {
    const s = iwSheet();
    return { rows: s.slice(), copies: s.map(r => r.slice()) };
}
function iwRestore(snap) {
    const s = iwSheet();
    s.length = 0;
    snap.rows.forEach((r, i) => { r.length = 0; r.push(...snap.copies[i]); s.push(r); });
}
async function withFaults(faults, fn) {
    FakeGoogleSheetsService.faults = faults;
    try { return await fn(); } finally { FakeGoogleSheetsService.faults = null; }
}
function iwNewRow(label) {
    const row = new Array(iwSheet()[0].length).fill('');
    row[0] = `${label} Show`; row[1] = `${label} Client`; row[2] = '2025';
    return row;
}
// Deterministic RNG (mulberry32) so a failing run can be replayed from its seed
function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('INSTANT WRITE', 'writeCellsVerified writes cells on several rows with one write request', async () => {
    const snap = iwSnapshot();
    const [a, b] = iwUniqueRows();
    let batches = 0, fullReads = 0;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => { batches++; },
            beforeRead: (t, range) => { if (t === IW_DB && !range.includes('!')) fullReads++; }
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [
            { row: iwRowObj(a), column: 'Elev', value: 'X' },
            { row: iwRowObj(a), column: 'Panels', value: '-' },
            { row: iwRowObj(b), column: 'Setups', value: 'X' }
        ]));
        assertEqual(res.map(r => r.ok), [true, true, true], 'all ok');
        assertEqual([a[iwHeaderIndex('Elev')], a[iwHeaderIndex('Panels')], b[iwHeaderIndex('Setups')]], ['X', '-', 'X'], 'written');
        assertEqual([batches, fullReads], [1, 1], 'one write request, one full read');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'batch results are per cell: refused and unmatched cells do not stop the others', async () => {
    const snap = iwSnapshot();
    const [a, b] = iwUniqueRows();
    try {
        const res = await Requests.writeCellsVerified(IW_DB, IW_TAB, [
            { row: iwRowObj(a), column: 'Elev', value: 'X' },
            { row: iwRowObj(a), column: 'City', value: 'X' },
            { row: { Show: 'Nope', Client: 'Nobody', Year: '2099' }, column: 'Elev', value: 'X' },
            { row: iwRowObj(b), column: 'Elev', value: 'X' }
        ]);
        assertEqual(res.map(r => r.ok ? 'ok' : r.reason), ['ok', 'column-not-writable', 'not-found', 'ok'], 'results');
        assertEqual([a[iwHeaderIndex('Elev')], b[iwHeaderIndex('Elev')]], ['X', 'X'], 'written');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'rows shifted just before the write: the displaced value is restored and the target retried', async () => {
    const snap = iwSnapshot();
    const s = iwSheet();
    const target = iwUniqueRows()[2];
    const col = iwHeaderIndex('Panels');
    const neighbour = s[s.indexOf(target) - 1];
    const neighbourValue = neighbour[col];
    const inserted = iwNewRow('Inserted');
    let fired = false;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => { if (!fired) { fired = true; s.splice(1, 0, inserted); } }
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [{ row: iwRowObj(target), column: 'Panels', value: neighbourValue === 'X' ? '-' : 'X' }]));
        const want = neighbourValue === 'X' ? '-' : 'X';
        assertEqual([res[0].ok, res[0].warning], [true, undefined], 'ok without warning');
        assertEqual(target[col], want, 'target written');
        assertEqual(neighbour[col], neighbourValue, 'neighbour restored');
        assertEqual(inserted[col], '', 'inserted row untouched');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'a row added at the target mid-write is reported, and the target still written', async () => {
    const snap = iwSnapshot();
    const s = iwSheet();
    const target = iwUniqueRows()[2];
    const col = iwHeaderIndex('Elev');
    const inserted = iwNewRow('Added');
    let fired = false;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => { if (!fired) { fired = true; s.splice(s.indexOf(target), 0, inserted); } }
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [{ row: iwRowObj(target), column: 'Elev', value: 'X' }]));
        assertEqual(res[0].ok, true, 'ok');
        assertEqual(target[col], 'X', 'target written');
        assertEqual(/Added Show/.test(res[0].warning || '') && /added while saving/.test(res[0].warning), true, 'warning names the added row');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'a dropped write fails verification and is retried', async () => {
    const snap = iwSnapshot();
    const target = iwUniqueRows()[1];
    const want = target[iwHeaderIndex('Setups')] === 'X' ? '-' : 'X';
    let drops = 0;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => (drops++ === 0 ? 'drop' : undefined)
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [{ row: iwRowObj(target), column: 'Setups', value: want }]));
        assertEqual([res[0].ok, drops, target[iwHeaderIndex('Setups')]], [true, 2, want], 'retried and written');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'randomized faults never change cells outside the batch (seeded)', async () => {
    const SEED = 20261031;
    const RUNS = 60;
    const rng = seededRandom(SEED);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const once = (fn) => { let done = false; return (...args) => { if (done) return undefined; const r = fn(...args); if (r !== false) done = true; return r === false ? undefined : r; }; };

    // Each fault plays one concurrent editor action at a moment the save can't control
    const FAULTS = {
        none: () => ({}),
        insertAbove: (ctx) => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const row = iwNewRow('Rand'); ctx.added.push([row, row.slice()]); s.splice(1 + Math.floor(rng() * (s.length - 1)), 0, row); }) }),
        insertAtTarget: (ctx) => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const row = iwNewRow('Rand'); ctx.added.push([row, row.slice()]); s.splice(s.indexOf(pick(ctx.targets)), 0, row); }) }),
        shuffle: () => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const body = s.slice(1); for (let i = body.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [body[i], body[j]] = [body[j], body[i]]; } s.splice(1, body.length, ...body); }) }),
        dropAll: () => ({ beforeBatchWrite: once(() => 'drop') }),
        dropSome: () => ({ beforeBatchWrite: once(() => new Set([0])) }),
        moveAfterWrite: (ctx) => { let written = false; return { beforeBatchWrite: () => { written = true; }, beforeRead: once((t, range) => { if (!written || !range.includes('!')) return false; const row = iwNewRow('Late'); ctx.added.push([row, row.slice()]); iwSheet().splice(1, 0, row); }) }; },
        duplicate: (ctx) => ({ beforeRead: once((t, range) => { if (range.includes('!')) return false; const copy = pick(ctx.targets).slice(); ctx.added.push([copy, copy.slice()]); iwSheet().push(copy); }) }),
        renameHeader: () => ({ beforeRead: once((t, range) => { if (range.includes('!')) return false; iwSheet()[0][1] = 'Customer'; }) }),
        insertColumn: (ctx) => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const c = iwHeaderIndex(pick(ctx.columns)); ctx.insertedCol = c; s.forEach((r, i) => r.splice(c, 0, i === 0 ? 'Inserted' : '')); }) })
    };
    const faultNames = Object.keys(FAULTS);
    const failures = [];

    for (let run = 0; run < RUNS; run++) {
        const snap = iwSnapshot();
        const header = snap.copies[0];
        const faultName = faultNames[run % faultNames.length];
        const unique = iwUniqueRows();
        // 1–4 distinct cells
        const cells = new Map();
        const n = 1 + Math.floor(rng() * 4);
        while (cells.size < n) {
            const ref = pick(unique);
            const column = pick(IW_WRITABLE);
            const value = column === 'Assignee' ? pick(['Ann', 'Bo', '']) : pick(['X', '', '-']);
            cells.set(snap.rows.indexOf(ref) + ':' + column, { ref, column, value });
        }
        const items = [...cells.values()];
        const ctx = { targets: items.map(i => i.ref), columns: items.map(i => i.column), added: [], insertedCol: -1 };
        let results;
        try {
            results = await withFaults(FAULTS[faultName](ctx), () =>
                Requests.writeCellsVerified(IW_DB, IW_TAB, items.map(i => ({ row: iwRowObj(i.ref), column: i.column, value: i.value }))));
        } catch (e) {
            failures.push(`run ${run} (${faultName}): threw ${e?.message || e}`);
            iwRestore(snap);
            continue;
        }

        const warned = results.some(r => r.warning);
        const mapCol = (c) => (ctx.insertedCol >= 0 && c >= ctx.insertedCol ? c + 1 : c);
        const problems = [];
        // Rows known before the save: only cells of successful items may change, to their value
        for (let i = 1; i < snap.rows.length; i++) {
            const ref = snap.rows[i];
            const copy = snap.copies[i];
            for (let c = 0; c < copy.length; c++) {
                let expected = copy[c] ?? '';
                items.forEach((it, k) => { if (it.ref === ref && results[k].ok && iwHeaderIndex(it.column, header) === c) expected = it.value; });
                const actual = ref[mapCol(c)] ?? '';
                if (String(actual) !== String(expected)) problems.push(`${copy[1]} / ${copy[0]} ${normalize(header[c])}: "${copy[c] ?? ''}" became "${actual}" (expected "${expected}")`);
            }
        }
        // Rows and columns added mid-save may change only when the save reported it
        if (!warned) {
            ctx.added.forEach(([row, original]) => {
                const now = ctx.insertedCol >= 0 ? row.filter((_, c) => c !== ctx.insertedCol) : row;
                if (JSON.stringify(now.map(v => v ?? '')) !== JSON.stringify(original.map(v => v ?? ''))) problems.push(`added row ${original[0]} changed without a warning`);
            });
            if (ctx.insertedCol >= 0 && iwSheet().slice(1).some(r => String(r[ctx.insertedCol] ?? '') !== '')) problems.push('inserted column changed without a warning');
        }
        if (faultName === 'none' && results.some(r => !r.ok)) problems.push('a clean save failed: ' + results.map(r => r.reason).join(','));
        if (problems.length) failures.push(`run ${run} (${faultName}, seed ${SEED}): ${problems.join('; ')}`);
        iwRestore(snap);
    }
    assertEqual(failures, [], `${RUNS} randomized saves`);

    function normalize(h) { return String(h ?? '').replace(/\s+/g, ' ').trim(); }
});

// The fake schedule deliberately holds multi-booth shows (two rows, one Client + Year + Show);
// writes to those rows are refused. Any other issue means the fixture data is in a bad state.
const IW_KNOWN_DUPLICATES = ['multiboothco / 2026 / multi booth', 'qgenda / 2024 / himss', 'qgenda / 2025 / himss'];

test('INSTANT WRITE', 'sheet health: the fake Production Schedule has only its known multi-booth duplicates', async () => {
    const health = await Requests.checkSheetHealth(IW_DB, IW_TAB);
    const other = health.issues.filter(i => i.kind !== 'duplicate-identity').map(i => i.message);
    assertEqual(other, [], 'no other issues');
    const dups = health.issues.filter(i => i.kind === 'duplicate-identity').map(i => i.message.replace(/^Rows [\d, ]+ share the identity /, '')).sort();
    assertEqual(dups, IW_KNOWN_DUPLICATES, 'known duplicates only');
});

test('INSTANT WRITE', 'sheet health reports duplicate identities, duplicate headers and missing columns', async () => {
    const snap = iwSnapshot();
    const s = iwSheet();
    try {
        s.push(iwUniqueRows()[0].slice());
        s[0][iwHeaderIndex('Setups')] = 'Elev';
        const health = await Requests.checkSheetHealth(IW_DB, IW_TAB);
        const kinds = health.issues.map(i => i.kind);
        assertEqual(health.ok, false, 'not ok');
        ['duplicate-identity', 'duplicate-header', 'missing-writable-column'].forEach(k => assertContains(kinds, k, k));
        const dup = health.issues.find(i => i.kind === 'duplicate-identity');
        assertEqual(dup.rows.length, 2, 'both rows listed');
        const noConfig = await Requests.checkSheetHealth(IW_DB, 'Some Other Tab');
        assertEqual(noConfig.issues.map(i => i.kind), ['no-config'], 'no config');
    } finally {
        iwRestore(snap);
    }
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
