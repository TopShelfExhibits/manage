# Move Tracking Simplification Analysis

> **Superseded (2026-10-21):** the position-based `i` design below was not implemented. Row identity is now a stable `EditHistory.i` assigned on first touch — see `metadata-implementation.md` (EditHistory Contract) for the current contract.

**Date**: June 4, 2026  
**Original Complexity**: 6.5/10  
**Revised Complexity**: 4.5/10 ⬇️  
**Time Savings**: ~40% reduction (from 24-35 hours to 15-20 hours)

## Changes from Original Plan

### Change 1: Initialize on First Save (Not on Load)

**Original**: Add index and empty history entry when data is loaded  
**Revised**: Add index and empty history entry on first save operation

### Change 2: No Row Identifiers

**Original**: Use business keys (itemNumber, Show+Item, etc.) to track rows  
**Revised**: Use only the editHistory `"i"` field as unique row identity

## Simplifications Breakdown

### 🎯 MAJOR SIMPLIFICATIONS

#### 1. **No getData() Modifications Required**

**Original Plan:**

- Parse editHistory on every getData() call
- Initialize missing `"i"` fields during read
- Create timestamp entries for rows without history
- Performance overhead on all data reads
- Cache invalidation complexity

**Simplified:**

- getData() remains unchanged - just returns raw data
- Zero performance impact on reads
- No cache invalidation issues
- Rows without editHistory are simply "new rows" - no special handling

**Impact:**

- ✅ Removes HIGH RISK performance concern
- ✅ Eliminates cache invalidation complexity
- ✅ Cleaner separation: reads are pure, writes handle metadata
- ⏱️ Saves ~4-6 hours of implementation time

---

#### 2. **No Identifier Key Strategy Needed**

**Original Plan:**

- Define identifier key per table type (itemNumber, Piece #, etc.)
- Pass identifierKey through setData() options
- Handle composite keys (Show+Item+Crate)
- Build identifier→row lookup maps
- Match rows across save operations by business key

**Simplified:**

- editHistory `"i"` field IS the unique identifier
- No need to know what makes a row unique in business terms
- Universal approach works for all tables
- Simpler row matching: just compare editHistory.i values

**Impact:**

- ✅ Removes MODERATE RISK identifier ambiguity
- ✅ No per-table configuration needed
- ✅ Universal algorithm for all data types
- ⏱️ Saves ~3-4 hours of implementation time

---

#### 3. **Simpler Row Matching Logic**

**Original Plan:**

```javascript
// Complex: Build identifier maps
const originalByIdentifier = new Map();
originalRows.forEach((row, idx) => {
  const id = row[identifierKey]; // What if composite key?
  const eh = JSON.parse(row.edithistory || '{"h":[],"i":null}');
  originalByIdentifier.set(String(id), {
    row,
    actualIdx: idx,
    storedIdx: eh.i,
  });
});

// Match by business identifier
updatedRows.forEach((updatedRow, newIdx) => {
  const id = updatedRow[identifierKey];
  const original = originalByIdentifier.get(String(id));
  // ... complex matching logic
});
```

**Simplified:**

```javascript
// Simple: Build editHistory.i map
const originalByIndex = new Map();
originalRows.forEach((row, actualIdx) => {
  const eh = EditHistoryUtils.parseEditHistory(row.edithistory);
  if (eh?.i != null) {
    originalByIndex.set(eh.i, { row, actualIdx });
  }
});

// Match by editHistory.i
updatedRows.forEach((updatedRow, newIdx) => {
  const eh = EditHistoryUtils.parseEditHistory(updatedRow.edithistory);
  if (eh?.i != null) {
    const original = originalByIndex.get(eh.i);
    // Original row found, check if moved
  } else {
    // No editHistory.i = new row, initialize
  }
});
```

**Impact:**

- ✅ Removes logic for handling missing/null identifiers
- ✅ No special cases for different table types
- ✅ Clearer code intent
- ⏱️ Saves ~2-3 hours of implementation and testing

---

#### 4. **Automatic New Row Detection**

**Original Plan:**

- Check if row has any editHistory
- If missing, create timestamp-only entry during read
- Track which rows need initialization
- Handle race conditions during concurrent reads

**Simplified:**

- If row lacks editHistory entirely: it's new, initialize on save
- If row has editHistory but no `"i"` field: backwards compat, add `"i"` on save
- Single code path handles both cases

**Impact:**

- ✅ Simpler mental model
- ✅ No race conditions (happens during save, which is already serialized)
- ⏱️ Saves ~2 hours of edge case handling

---

### ⚡ MODERATE SIMPLIFICATIONS

#### 5. **Reduced Function Surface Area**

**Functions NO LONGER NEEDED:**

- ❌ `_ensureEditHistoryIndex()` (getData initialization)
- ❌ Identifier validation logic
- ❌ Composite key handling
- ❌ Per-table identifier configuration

**Functions SIMPLIFIED:**

- `EditHistoryUtils.detectRowMoves()` - simpler matching by `i` only
- `_addMetadataToRows()` - no identifier parameter needed
- `Database.setData()` - no identifierKey in options

**Impact:**

- ✅ Less code to write, test, and maintain
- ✅ Clearer API surface
- ⏱️ Saves ~3-4 hours total

---

#### 6. **No Username in getData()**

**Original Plan:**

- Pass username through getData() for initialization
- Handle cases where username not available
- Track initialization user separately from change user

**Simplified:**

- Username only needed in setData() (already available)
- Initialization happens during save, user is known
- No API changes needed

**Impact:**

- ✅ No getData() signature change
- ✅ Simpler threading of context
- ⏱️ Saves ~1-2 hours

---

### 🔧 TECHNICAL DETAILS

#### New Row Initialization Flow

**Simplified Algorithm:**

```javascript
async function _addMetadataToRows(
  originalRows,
  updatedRows,
  username,
  mapping,
  source = "web",
) {
  return updatedRows.map((updatedRow, currentIndex) => {
    const ehKey = mapping.edithistory || "edithistory";
    const existingEH = updatedRow[ehKey];

    // NEW ROW: No editHistory at all
    if (!existingEH || existingEH === "") {
      const newEH = EditHistoryUtils.createInitialEditHistory(
        username,
        currentIndex,
        source,
      );
      return { ...updatedRow, [ehKey]: newEH };
    }

    // EXISTING ROW: Has editHistory, check for changes/moves
    const parsed = EditHistoryUtils.parseEditHistory(existingEH);

    // Handle backwards compat: old rows without "i" field
    const storedIndex = parsed?.i ?? currentIndex; // Use current if missing

    // Find original by editHistory.i
    const originalRow = originalRows.find((r) => {
      const origEH = EditHistoryUtils.parseEditHistory(r[ehKey]);
      return origEH?.i === storedIndex;
    });

    // If "i" was missing, add it now
    if (parsed && parsed.i == null) {
      parsed.i = currentIndex;
      return { ...updatedRow, [ehKey]: JSON.stringify(parsed) };
    }

    // Calculate changes and moves
    const changes = EditHistoryUtils.calculateRowDiff(originalRow, updatedRow);
    const movedFrom = storedIndex !== currentIndex ? storedIndex : null;

    if (changes.length > 0 || movedFrom !== null) {
      const metaEntry = EditHistoryUtils.createEditHistoryEntry(
        username,
        changes,
        source,
        movedFrom,
      );
      const newMetadata = EditHistoryUtils.appendToEditHistory(
        existingEH,
        metaEntry,
      );
      parsed.i = currentIndex; // Update index

      return {
        ...updatedRow,
        [ehKey]: JSON.stringify({ ...parsed, h: JSON.parse(newMetadata).h }),
      };
    }

    // No changes, just update index if moved
    if (storedIndex !== currentIndex) {
      parsed.i = currentIndex;
      return { ...updatedRow, [ehKey]: JSON.stringify(parsed) };
    }

    return updatedRow;
  });
}
```

#### Move Detection Simplified

**Original (with identifiers):**

```javascript
static detectRowMoves(originalRows, updatedRows, identifierKey) {
  // Build identifier→position map
  // Handle missing identifiers
  // Handle composite keys
  // Match by business logic
  // 40-50 lines of code
}
```

**Simplified (editHistory.i only):**

```javascript
static detectRowMoves(originalRows, updatedRows) {
  const moves = new Map();

  // Build editHistory.i → original position map
  const indexMap = new Map();
  originalRows.forEach((row, actualIdx) => {
    const eh = this.parseEditHistory(row.edithistory || row.EditHistory);
    if (eh?.i != null) {
      indexMap.set(eh.i, actualIdx);
    }
  });

  // Check each updated row
  updatedRows.forEach((row, newIdx) => {
    const eh = this.parseEditHistory(row.edithistory || row.EditHistory);
    if (eh?.i != null && eh.i !== newIdx) {
      moves.set(row, {movedFrom: eh.i, movedTo: newIdx});
    }
  });

  return moves;
}
// 15-20 lines of code
```

**Impact**: 60% code reduction, 100% clarity improvement

---

## Revised Risk Assessment

### HIGH RISK → LOW RISK ✅

1. **~~Performance Impact on Data Reads~~** → ELIMINATED
   - No getData() modifications = zero read overhead

2. **~~Identifier Key Ambiguity~~** → ELIMINATED
   - editHistory.i is universal identifier

### MODERATE RISK → LOW RISK ✅

3. **~~Race Conditions During Index Assignment~~** → ELIMINATED
   - Initialization happens during save (serialized operation)

4. **~~Backwards Compatibility~~** → SIMPLIFIED
   - Old rows without `"i"` get it added on first save
   - Graceful, automatic migration

### REMAINING LOW RISKS

5. **Mass Operations Performance** (unchanged)
   - Still need threshold-based bulk detection
   - But simpler to implement now

6. **JSON Size Growth** (unchanged)
   - Minimal impact from adding `"i"` field

---

## Revised Implementation Phases

### Phase 1: Core Infrastructure (1-2 days) ⬇️ from 2-3 days

**Only need to modify:**

1. `EditHistoryUtils` in metadata-utils.js
   - `createInitialEditHistory()`
   - `detectRowMoves()` (simplified)
   - `createEditHistoryEntry()` (add movedFrom param)
   - `updateEditHistoryIndex()`

2. `_addMetadataToRows()` in database.js
   - Add new row detection (no editHistory)
   - Add backwards compat (editHistory without `"i"`)
   - Add move detection (editHistory.i ≠ currentIndex)
   - Update `"i"` after recording changes

**Do NOT need to modify:**

- ❌ `Database.getData()` - leave untouched
- ❌ `Database.setData()` signature - already has username
- ❌ API layer - no new parameters needed
- ❌ Cache strategy - unaffected

### Phase 2: Optimization (1 day) ⬇️ from 1-2 days

Same as before but simpler to implement:

- Bulk move detection threshold
- Combined operations testing

### Phase 3: Documentation (1 day) ⬇️ unchanged

- Update metadata-implementation.md
- Add examples
- Document migration path

---

## Complexity Comparison

| Aspect                             | Original           | Simplified         | Improvement |
| ---------------------------------- | ------------------ | ------------------ | ----------- |
| **Functions to write**             | 8 new + 4 modified | 4 new + 2 modified | 50% less    |
| **Functions to modify in getData** | 2                  | 0                  | 100% less   |
| **Risk level**                     | HIGH               | LOW-MODERATE       | ⬇️⬇️        |
| **Code lines estimate**            | 300-400            | 150-200            | 50% less    |
| **Test scenarios**                 | 15-20              | 8-10               | 50% less    |
| **Files to change**                | 3-4                | 2                  | 50% less    |
| **Performance impact**             | READ+WRITE         | WRITE only         | ⬇️⬇️        |
| **Implementation time**            | 24-35 hours        | 15-20 hours        | 40% faster  |

---

## New Complexity Rating

### Overall: 4.5/10 ⬇️ from 6.5/10

**Breakdown:**

- Data initialization: ~~4/10~~ → **2/10** (only on save)
- Move detection: ~~6/10~~ → **4/10** (no identifiers)
- Minimal moves: ~~9/10~~ → **7/10** (still complex, but easier to implement)
- Combined ops: ~~6/10~~ → **5/10** (slightly simpler)
- Documentation: 3/10 (unchanged)

---

## Recommendation: PROCEED WITH SIMPLIFIED APPROACH ✅

**Why this is better:**

1. **Cleaner architecture**: Reads stay pure, writes handle metadata
2. **Lower risk**: No performance concerns on hot path (getData)
3. **Universal solution**: Works for ALL tables without configuration
4. **Simpler code**: 50% less code = 50% fewer bugs
5. **Faster implementation**: 15-20 hours vs 24-35 hours
6. **Easier maintenance**: Fewer functions, clearer intent
7. **Natural migration**: Old data gets upgraded on first edit

**Key insight:** editHistory.i becomes the "source of truth" for row identity, completely decoupling from business logic. This is elegant and correct - the history system tracks its own concept of row identity, independent of what the row contains.

**Next step:** Begin Phase 1 implementation with simplified algorithm.
