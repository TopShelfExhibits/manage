# Item Row Grouping Implementation (as of 2026)

## Overview

Items in a packlist can be grouped so that a single "master" row controls the visibility and grouping of its "child" rows. Grouping is managed by storing metadata in each item's `metadata` field (sheet column `MetaData`; changes to it are recorded in `edithistory`). The UI and data logic both rely on this metadata to determine group membership, master/child roles, and group expansion/collapse.

## Grouping Data Structure

Each item row may have a `grouping` object in its metadata:

```json
{
  "grouping": {
    "groupId": "G1234567890", // Unique group identifier (string)
    "isGroupMaster": true // true for master row, false for child
  }
}
```

- **groupId**: Shared by all items in the group (master and children).
- **isGroupMaster**: true for the master row, false for children.

## Grouping Logic (UI & Data)

### Creating a Group

1. User selects multiple rows and chooses a master row (or drags onto a master row).
2. If the target is not already a group master, it is updated to have `isGroupMaster: true` and a new or existing `groupId`.
3. All selected rows (except the master) are removed from their original positions and inserted immediately after the master row.
4. Each child row gets `grouping` metadata with the same `groupId` and `isGroupMaster: false`.

### Visibility and Expansion

- Only the master row is always visible.
- Child rows are only visible if their group is expanded (tracked in UI state, not in metadata).
- If the group is collapsed, child rows are hidden.

### Selection Behavior

- Selecting a group master auto-selects all its children.
- Deselecting a master deselects all children.
- Children cannot be independently deselected if their master is selected.

### Ungrouping

- Dragging or moving a child row outside its group (without the master) removes its `grouping` metadata.
- If a group master has no children, its `grouping` metadata is removed.

### Data Persistence

- Grouping info is stored in the `metadata` JSON for each item (sheet column `MetaData`).
- When saving/exporting, ensure the grouping object is included for all grouped items.

## Implementation Notes for VB.NET

- When exporting, group rows by `groupId`.
- The master row is the one with `isGroupMaster: true`.
- All children should immediately follow their master in the exported data.
- To find the master, scan the list for the row with the same `groupId` and `isGroupMaster: true`.
- If a row has no `grouping` object, it is not grouped.

## Example

Suppose you have 5 items, and items 1, 3, and 4 are grouped under item 1:

| Index | Description | grouping.groupId | grouping.isGroupMaster |
| ----- | ----------- | ---------------- | ---------------------- |
| 0     | Master      | G123             | true                   |
| 1     | Child A     | G123             | false                  |
| 2     | Child B     | G123             | false                  |
| 3     | Ungrouped   |                  |                        |
| 4     | Ungrouped   |                  |                        |

## Summary

Grouping is managed by updating each item's metadata. The UI and data logic ensure that children follow their master, are hidden/shown based on expansion state, and that grouping is preserved when exporting. When implementing in VB.NET, replicate this structure and logic for consistent grouping behavior.

- Add expand/collapse button (▶/▼) in Description column for master items
- Indent grouped items visually when expanded
- Show unlink button (⛓) for grouped items in edit mode
- Display aggregated alerts in master's "Packing/shop notes" when collapsed

### 4. **CSS Styling**

- `.group-toggle-button` - expand/collapse styling
- `.indented` - visual hierarchy for grouped items
- `.card.aggregated` - differentiate aggregated alerts

## Testing

- Test with existing packlists (no MetaData) - should work unchanged
- Test creating/unlinking groups - verify persistence after save/reload
- Test alert aggregation - ensure child alerts appear in master when collapsed
