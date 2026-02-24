# Navigation System Documentation

## Overview

The TopShelfLiveInventory application uses a hash-based URL routing system with JSON parameters, built on Vue 3 reactivity. The navigation system maintains application state in URLs and supports both regular page navigation and dashboard containers with independent parameter persistence.

## Core Principles

1. **Single Source of Truth**: `appContext.currentPath` contains the full path with JSON parameters
2. **URL = State**: Navigation state is encoded in URLs, with dashboard containers storing their own paths
3. **JSON Parameters**: Uses readable JSON format: `#route?{"param":"value"}` instead of query strings
4. **Context-Aware Parameters**: Components retrieve parameters differently based on dashboard vs regular navigation
5. **Parameter Merging**: New parameters merge with existing ones via `buildPath()`
6. **Dashboard Persistence**: Dashboard containers maintain their own parameter state in DashboardRegistry

## Architecture

### Three-Layer Structure

```
┌─────────────────────────────────────────────────────┐
│  UI Layer (Vue Components)                          │
│  - ScheduleFilterSelect, ScheduleContent, etc.         │
│  - Use getParametersForContainer() for params       │
│  - Emit events, call navigateToPath()               │
│  - Update dashboard via updatePath() when on dash   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Navigation Registry                                 │
│  - Route definitions and metadata                    │
│  - handleNavigateToPath() - main entry point        │
│  - parsePath() / buildPath() - JSON parameters      │
│  - getParametersForContainer() - context-aware      │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  URL Router + Dashboard Registry                     │
│  - Browser history sync (pushState/popState)        │
│  - Hash-based URL: #path?{json}                     │
│  - Dashboard: stores container paths with params    │
└─────────────────────────────────────────────────────┘
```

## URL Format

### JSON Path Segments

**Format**: `#route?{"param":"value","another":"data"}`

**Example**: `#schedule?{"dateFilter":"0,30","searchMode":"upcoming"}`

**Key Features**:

- Unencoded JSON in hash fragment (human-readable)
- Browser may encode on paste: automatically decoded via `decodeURIComponent()`
- `?` delimiter separates route from parameters
- Parameters are parsed/built via `parseJsonPathSegment()` / `buildJsonPathSegment()`

## Key Components

### NavigationRegistry

**Purpose**: Central registry for routes and navigation logic

**Key Methods**:

- `parseJsonPathSegment(jsonString)` - Parses JSON parameter string into object

  ```javascript
  parseJsonPathSegment('{"dateFilter":"0,30","mode":"upcoming"}');
  // Returns: { dateFilter: '0,30', mode: 'upcoming' }
  ```

- `buildJsonPathSegment(parameters)` - Converts object to JSON string

  ```javascript
  buildJsonPathSegment({ dateFilter: "0,30", mode: "upcoming" });
  // Returns: '{"dateFilter":"0,30","mode":"upcoming"}'
  ```

- `parsePath(path)` - Splits path and JSON parameters, decodes URL encoding

  ```javascript
  parsePath('schedule?{"dateFilter":"0,30"}')
  // Returns:
  {
    path: 'schedule',
    fullPath: 'schedule?{"dateFilter":"0,30"}',
    parameters: { dateFilter: '0,30' },
    route: {...},
    hasParameters: true
  }
  ```

- `buildPath(path, parameters)` - Merges parameters into path, replacing duplicates

  ```javascript
  buildPath('schedule?{"dateFilter":"0,30"}', {
    mode: "upcoming",
    dateFilter: "0,60",
  });
  // Returns: 'schedule?{"dateFilter":"0,60","mode":"upcoming"}'
  ```

- `getNavigationParameters(path)` - Extracts parameters from a path

  ```javascript
  getNavigationParameters('schedule?{"dateFilter":"0,30"}');
  // Returns: { dateFilter: '0,30' }
  ```

- `getParametersForContainer(containerPath, currentPath)` - **Context-aware parameter retrieval**

  **This is the preferred method for components to get their parameters**

  - On dashboard: Retrieves parameters from DashboardRegistry
  - Not on dashboard: Retrieves parameters from currentPath if paths match
  - Handles the complexity of different contexts automatically

  ```javascript
  // On dashboard page (currentPath = 'dashboard')
  getParametersForContainer("schedule", "dashboard");
  // Returns parameters stored in dashboard registry for schedule container

  // On regular page (currentPath = 'schedule?{"dateFilter":"0,30"}')
  getParametersForContainer("schedule", 'schedule?{"dateFilter":"0,30"}');
  // Returns: { dateFilter: '0,30' }

  // Wrong page (currentPath = 'inventory')
  getParametersForContainer("schedule", "inventory");
  // Returns: {}
  ```

- `handleNavigateToPath(navigationData, appContext)` - Main navigation handler
  - Checks authentication
  - Parses target path
  - Detects same-base-path vs new-location navigation
  - Updates `appContext.currentPath`
  - Only closes menu on new-location navigation
  - Updates URL via URLRouter

**Route Registry Structure**:

```javascript
routes: {
  dashboard: {
    isMainSection: true,
    displayName: 'Dashboard',
    children: {}
  },
  schedule: {
    isMainSection: true,
    displayName: 'Schedule',
    icon: 'event',
    children: {
      'advanced-search': { displayName: 'Advanced Search' }
    }
  }
}
```

### DashboardRegistry

**Purpose**: Manages dashboard container persistence with parameter state

**Key Features**:

- Stores full container paths including parameters
- Compares clean paths (without params) for matching
- Auto-saves changes with 5-second debounce
- Integrated with NavigationRegistry

**Key Methods**:

- `has(containerPathWithParams)` - Check if container is on dashboard (compares clean paths)
- `getContainer(containerPathWithParams)` - Get container with its stored path (compares clean paths)
- `add(containerPathWithParams)` - Add container to dashboard with parameters
- `updatePath(cleanPath, newPathWithParams)` - Update container's path with new parameters
- `remove(containerPathWithParams)` - Remove container from dashboard
- `toggleClass(containerPathWithParams, className)` - Toggle CSS class (wide/tall)

**Data Structure**:

```javascript
containers: [
  { path: 'schedule?{"dateFilter":"0,30"}', classes: "wide" },
  { path: "inventory", classes: "" },
];
```

### URLRouter

**Purpose**: Synchronize application navigation with browser URL

**Key Features**:

- Hash-based routing (`#path?{json}`)
- Space encoding (replaces spaces with `+` in URL)
- Browser back/forward support via `popstate` event
- Distinguishes browser navigation from app navigation

**Key Methods**:

- `updateURL(path)` - Updates browser URL without reloading page
- `handlePopState()` - Responds to browser back/forward buttons
- `getCurrentURLPath()` - Reads current path from `window.location.hash`

### Component Integration Pattern

**Purpose**: Components retrieve parameters directly from NavigationRegistry for both regular and dashboard navigation

**Reactive Flow**:

```javascript
watch: {
  'appContext.currentPath': {
    handler(newPath, oldPath) {
      if (!oldPath) return; // Skip initial load

      // Get params for both paths to compare
      const newParams = NavigationRegistry.getParametersForContainer(
        this.containerPath,
        newPath
      );
      const oldParams = NavigationRegistry.getParametersForContainer(
        this.containerPath,
        oldPath
      );

      // Only sync if parameters actually changed
      if (JSON.stringify(newParams) !== JSON.stringify(oldParams)) {
        this.syncWithURL();
      }
    }
  }
},
methods: {
  syncWithURL() {
    // Call getParametersForContainer directly when needed
    const params = NavigationRegistry.getParametersForContainer(
      this.containerPath,
      this.appContext?.currentPath
    );

    // Apply parameters to component state
    this.applyFilters(params);
  }
}
```

**Update Flow (with dashboard support)**:

```javascript
methods: {
  updateFilters(newParams) {
    const isOnDashboard = this.appContext.currentPath.split('/')[0] === 'dashboard';

    if (isOnDashboard) {
      // On dashboard: update dashboard registry
      const newPath = NavigationRegistry.buildPath(this.containerPath, newParams);
      dashboardRegistry.updatePath(this.containerPath.split('?')[0], newPath);
    } else {
      // Regular navigation: update URL
      const newPath = NavigationRegistry.buildPath(this.containerPath, newParams);
      this.navigateToPath(newPath);
    }
  }
}
```

**Navigation Guard Pattern** (prevents stale navigation):

```javascript
methods: {
  /**
   * Check if this component is still active (user hasn't navigated away)
   * Prevents stale navigation from async operations
   */
  isComponentActive() {
    if (!this.appContext?.currentPath) return false;

    const currentCleanPath = this.appContext.currentPath.split('?')[0];
    const containerCleanPath = this.containerPath.split('?')[0];

    // On dashboard, we're always active if on dashboard page
    if (this.isOnDashboard) {
      return currentCleanPath.startsWith('dashboard');
    }

    // Not on dashboard, check if current path matches our container
    return currentCleanPath === containerCleanPath;
  },

  updateURL(params) {
    // Guard: Don't navigate if component is no longer active
    if (!this.isComponentActive()) {
      console.log('[Component] Skipping navigation - component no longer active');
      return;
    }

    // Proceed with navigation...
    const newPath = NavigationRegistry.buildPath(this.containerPath, params);
    this.navigateToPath(newPath);
  }
}
```

## Navigation Flow

### Regular Navigation Flow

```
User action → Component updates parameters
  ↓
navigateToPath(buildPath(containerPath, newParams))
  ↓
handleNavigateToPath({ targetPath, isBrowserNavigation: false })
  ↓
appContext.currentPath = newPath
  ↓
URLRouter.updateURL() - updates browser address bar
  ↓
appContext.currentPath watcher fires
  ↓
Components call getParametersForContainer() to read new params
  ↓
Components sync with new parameters
```

### Dashboard Navigation Flow

```
User action on dashboard container → Component updates parameters
  ↓
dashboardRegistry.updatePath(containerPath, buildPath(containerPath, newParams))
  ↓
Dashboard registry stores new path with parameters
  ↓
appContext.currentPath watcher may fire (but path stays 'dashboard')
  ↓
Components call getParametersForContainer()
  ↓
getParametersForContainer() reads from dashboard registry
  ↓
Components sync with new parameters
  ↓
(Browser URL stays as #dashboard - container params stored in registry)
```

### Browser Back/Forward

```
User clicks back/forward
  ↓
popstate event fires
  ↓
URLRouter.handlePopState()
  ↓
handleNavigateToPath({ targetPath, isBrowserNavigation: true })
  ↓
appContext.currentPath = pathFromURL
  ↓
(No updateURL call - prevents loop)
  ↓
Components react to currentPath change
```

## Parameter Handling

### JSON Parameter Format

All parameters use JSON format in URLs for readability and type preservation:

```javascript
// Build parameters
const params = { dateFilter: "0,30", mode: "upcoming", isActive: true };
const path = NavigationRegistry.buildPath("schedule", params);
// Result: 'schedule?{"dateFilter":"0,30","mode":"upcoming","isActive":true}'

// Parse parameters
const pathInfo = NavigationRegistry.parsePath('schedule?{"dateFilter":"0,30"}');
// pathInfo.parameters = { dateFilter: '0,30' }
```

### Parameter Merging

`buildPath()` automatically merges new parameters with existing ones:

```javascript
const currentPath = 'schedule?{"dateFilter":"0,30","mode":"upcoming"}';
const newPath = NavigationRegistry.buildPath(currentPath, {
  mode: "past", // Replaces existing
  filter: "active", // Adds new
});
// Result: 'schedule?{"dateFilter":"0,30","mode":"past","filter":"active"}'
```

### Direct Parameter Retrieval

Components should call `getParametersForContainer()` directly when they need parameters, rather than caching in a computed property:

```javascript
// ✓ CORRECT: Direct call when parameters are needed
methods: {
  syncWithURL() {
    const params = NavigationRegistry.getParametersForContainer(
      this.containerPath,
      this.appContext?.currentPath
    );

    // Use params directly
    this.mode = params.mode || 'default';
    this.filter = params.filter || '';
  },

  applyFilters() {
    const params = NavigationRegistry.getParametersForContainer(
      this.containerPath,
      this.appContext?.currentPath
    );

    this.filters = params.textFilters || [];
  }
}

// ✓ ACCEPTABLE: Cached computed if used multiple times in template
computed: {
  urlParameters() {
    return NavigationRegistry.getParametersForContainer(
      this.containerPath,
      this.appContext?.currentPath
    );
  }
}
// Template: {{ urlParameters.searchTerm }}, {{ urlParameters.mode }}

// ✗ INCORRECT: Direct parsing doesn't handle dashboard
methods: {
  getParams() {
    return NavigationRegistry.getNavigationParameters(this.appContext.currentPath);
    // Fails on dashboard - returns {} because currentPath is 'dashboard'
  }
}
```

## Component Examples

### ScheduleFilterSelect Component

**Purpose**: Dropdown for year/saved search selection with URL sync and dashboard support

**Key Implementation**:

```javascript
computed: {
  isOnDashboard() {
    return this.appContext.currentPath.split('/')[0] === 'dashboard';
  }
},

watch: {
  'appContext.currentPath': {
    handler(newPath, oldPath) {
      if (!oldPath) return; // Skip initial load

      // Get params for both paths
      const newParams = NavigationRegistry.getParametersForContainer(
        this.containerPath,
        newPath
      );
      const oldParams = NavigationRegistry.getParametersForContainer(
        this.containerPath,
        oldPath
      );

      // Skip if params haven't actually changed
      if (JSON.stringify(newParams) === JSON.stringify(oldParams)) return;

      this.syncWithURL();
    }
  }
},

methods: {
  syncWithURL() {
    const params = NavigationRegistry.getParametersForContainer(
      this.containerPath,
      this.appContext?.currentPath
    );

    if (Object.keys(params).length === 0) {
      this.applyDefaultSearch();
      return;
    }

    // Apply parameters to dropdown selection
    this.matchUrlToSelection(params);
  },

  /**
   * Navigation guard - prevents stale navigation after user has navigated away
   */
  isComponentActive() {
    if (!this.appContext?.currentPath) return false;

    const currentCleanPath = this.appContext.currentPath.split('?')[0];
    const containerCleanPath = this.containerPath.split('?')[0];

    if (this.isOnDashboard) {
      return currentCleanPath.startsWith('dashboard');
    }

    return currentCleanPath === containerCleanPath;
  },

  updateURL(params) {
    // Guard against stale navigation
    if (!this.isComponentActive()) {
      console.log('[ScheduleFilterSelect] Skipping navigation - component no longer active');
      return;
    }
    if (this.isOnDashboard) {
      // Update dashboard registry
      const newPath = NavigationRegistry.buildPath(this.containerPath, params);
      dashboardRegistry.updatePath(
        this.containerPath.split('?')[0],
        newPath
      );
    } else {
      // Regular navigation
      const newPath = NavigationRegistry.buildPath(this.containerPath, params);
      this.navigateToPath(newPath);
    }
  }
}
```

### ScheduleContent Component

**Purpose**: Main schedule view coordinating search and table display

**Key Features**:

- Receives `containerPath` prop (e.g., `'schedule'`)
- Passes `navigateToPath` to child components
- Handles `search-selected` event from ScheduleFilterSelect
- Transforms search data into filter format for ScheduleTable

## Best Practices

### For Component Developers

1. **Call getParametersForContainer() directly when needed**

   ```javascript
   // ✓ CORRECT: Direct call when parameters are needed
   methods: {
     syncWithURL() {
       const params = NavigationRegistry.getParametersForContainer(
         this.containerPath,
         this.appContext?.currentPath
       );

       this.mode = params.mode || 'default';
     }
   }

   // ✓ ACCEPTABLE: Cached computed if used multiple times in template
   computed: {
     urlParameters() {
       return NavigationRegistry.getParametersForContainer(
         this.containerPath,
         this.appContext?.currentPath
       );
     }
   }

   // ✗ INCORRECT: Path comparison fails on dashboard
   computed: {
     currentUrlParameters() {
       const currentCleanPath = this.appContext.currentPath.split('?')[0];
       if (currentCleanPath === this.containerPath) {
         return NavigationRegistry.getNavigationParameters(this.appContext.currentPath);
       }
       return {};
     }
   }
   ```

2. **Use buildPath() for parameter updates**

   ```javascript
   // ✓ CORRECT: Merges parameters
   const newPath = NavigationRegistry.buildPath(currentPath, {
     mode: "upcoming",
   });

   // ✗ INCORRECT: Manual JSON loses existing params
   const newPath = currentPath + '?{"mode":"upcoming"}';
   ```

3. **Check dashboard context when updating parameters**

   ```javascript
   // ✓ CORRECT: Updates dashboard registry or navigates appropriately
   updateFilters(newParams) {
     const isOnDashboard = this.appContext.currentPath.split('/')[0] === 'dashboard';
     const newPath = NavigationRegistry.buildPath(this.containerPath, newParams);

     if (isOnDashboard) {
       dashboardRegistry.updatePath(this.containerPath.split('?')[0], newPath);
     } else {
       this.navigateToPath(newPath);
     }
   }

   // ✗ INCORRECT: Always navigates, doesn't persist dashboard state
   updateFilters(newParams) {
     const newPath = NavigationRegistry.buildPath(this.containerPath, newParams);
     this.navigateToPath(newPath);
   }
   ```

4. **Use navigation guards to prevent stale navigation**

   ```javascript
   // ✓ CORRECT: Guard against navigation after user has moved away
   methods: {
     isComponentActive() {
       if (!this.appContext?.currentPath) return false;

       const currentCleanPath = this.appContext.currentPath.split('?')[0];
       const containerCleanPath = this.containerPath.split('?')[0];

       if (this.isOnDashboard) {
         return currentCleanPath.startsWith('dashboard');
       }

       return currentCleanPath === containerCleanPath;
     },

     updateURL(params) {
       // Guard against stale navigation
       if (!this.isComponentActive()) {
         console.log('Skipping navigation - component no longer active');
         return;
       }

       // Proceed with navigation...
       const newPath = NavigationRegistry.buildPath(this.containerPath, params);
       this.navigateToPath(newPath);
     }
   }

   // ✗ INCORRECT: No guard - async operations can redirect user back
   methods: {
     async mounted() {
       await this.loadData();
       // User may have navigated away during loadData()
       this.navigateToPath(defaultPath); // Bad! Redirects user back
     }
   }
   ```

5. **Watch appContext.currentPath for parameter changes**

   ```javascript
   // ✓ CORRECT: Watch the source path and compare parameters
   watch: {
     'appContext.currentPath': {
       handler(newPath, oldPath) {
         if (!oldPath) return;

         const newParams = NavigationRegistry.getParametersForContainer(
           this.containerPath,
           newPath
         );
         const oldParams = NavigationRegistry.getParametersForContainer(
           this.containerPath,
           oldPath
         );

         if (JSON.stringify(newParams) !== JSON.stringify(oldParams)) {
           this.syncWithURL();
         }
       }
     }
   }

   // ✗ AVOID: Wrapper computed property adds unnecessary layer
   computed: {
     currentUrlParameters() {
       return NavigationRegistry.getParametersForContainer(...);
     }
   },
   watch: {
     currentUrlParameters() {
       this.syncWithURL();
     }
   }
   ```

### For Navigation Logic

1. **Check authentication before navigation** - Done automatically in `handleNavigateToPath()`

2. **Distinguish parameter changes from page changes** - Used to decide whether to close menu

3. **Never duplicate parameter storage**

   - Regular navigation: URL is the source of truth
   - Dashboard: DashboardRegistry stores container paths
   - Components read via `getParametersForContainer()`

4. **Always use navigation guards for async operations** - Prevents redirecting users who have navigated away

## Common Patterns

### Pattern: Component with URL Sync and Dashboard Support

```javascript
export const MyComponent = {
  inject: ['appContext'],
  props: {
    containerPath: String,
    navigateToPath: Function
  },

  computed: {
    isOnDashboard() {
      return this.appContext.currentPath.split('/')[0] === 'dashboard';
    }
  },

  watch: {
    'appContext.currentPath': {
      handler(newPath, oldPath) {
        if (!oldPath) return; // Skip initial load

        // Get params for both paths
        const newParams = NavigationRegistry.getParametersForContainer(
          this.containerPath,
          newPath
        );
        const oldParams = NavigationRegistry.getParametersForContainer(
          this.containerPath,
          oldPath
        );

        // Only sync if params changed
        if (JSON.stringify(newParams) !== JSON.stringify(oldParams)) {
          this.syncWithURL();
        }
      }
    }
  },

  methods: {
    syncWithURL() {
      // Get current parameters
      const params = NavigationRegistry.getParametersForContainer(
        this.containerPath,
        this.appContext?.currentPath
      );

      // Update component state from parameters
      this.mode = params.mode || 'default';
      this.filter = params.filter || '';
    },

    /**
     * Navigation guard - check if component is still active
     */
    isComponentActive() {
      if (!this.appContext?.currentPath) return false;

      const currentCleanPath = this.appContext.currentPath.split('?')[0];
      const containerCleanPath = this.containerPath.split('?')[0];

      if (this.isOnDashboard) {
        return currentCleanPath.startsWith('dashboard');
      }

      return currentCleanPath === containerCleanPath;
    },

    updateParameters(newParams) {
      // Guard against stale navigation
      if (!this.isComponentActive()) {
        console.log('[MyComponent] Skipping navigation - component no longer active');
        return;
      }

      const newPath = NavigationRegistry.buildPath(this.containerPath, newParams);

      if (this.isOnDashboard) {
        // On dashboard: update registry
        dashboardRegistry.updatePath(
          this.containerPath.split('?')[0],
          newPath
        );
      } else {
        // Regular navigation: update URL
        this.navigateToPath(newPath);
      }
    }
  }
};

  methods: {
    syncWithURL(params) {
      // Update component state from parameters
      this.mode = params.mode || "default";
      this.filter = params.filter || "";
    },

    updateParameters(newParams) {
      const newPath = NavigationRegistry.buildPath(
        this.containerPath,
        newParams
      );

      if (this.isOnDashboard) {
        // On dashboard: update registry
        dashboardRegistry.updatePath(this.containerPath.split("?")[0], newPath);
      } else {
        // Regular navigation: update URL
        this.navigateToPath(newPath);
      }
    },
  },
};
```

### Pattern: Default Selection on Empty URL

```javascript
async mounted() {
  await this.loadData();

  const params = this.currentUrlParameters;
  if (Object.keys(params).length === 0) {
    // No URL parameters - apply default
    this.applyDefault();
  } else {
    // URL has parameters - sync with them
    this.syncWithURL(params);
  }
}
```

### Pattern: Multi-Component Coordination

When multiple components need to react to the same URL parameters:

**Regular Navigation:**

```
User changes filter in ComponentA
  ↓
ComponentA.updateParameters({ filter: 'new' })
  ↓
navigateToPath('schedule?{"filter":"new"}')
  ↓
appContext.currentPath updates
  ↓
┌────────────────────┬────────────────────┐
│ ComponentA         │ ComponentB         │
│ watcher fires      │ watcher fires      │
│ syncWithURL()      │ syncWithURL()      │
└────────────────────┴────────────────────┘
```

**Dashboard Navigation:**

```
User changes filter in ComponentA on dashboard
  ↓
ComponentA.updateParameters({ filter: 'new' })
  ↓
dashboardRegistry.updatePath('schedule', 'schedule?{"filter":"new"}')
  ↓
getParametersForContainer() returns new params
  ↓
┌────────────────────┬────────────────────┐
│ ComponentA         │ ComponentB         │
│ watcher fires      │ watcher fires      │
│ syncWithURL()      │ syncWithURL()      │
└────────────────────┴────────────────────┘
```

## Troubleshooting

### Issue: Component not reacting to URL changes

**Cause**: Not watching `currentUrlParameters` or not using `getParametersForContainer()`

**Solution**: Use the standard pattern:

```javascript
computed: {
  currentUrlParameters() {
    return NavigationRegistry.getParametersForContainer(
      this.containerPath,
      this.appContext.currentPath
    );
  }
},
watch: {
  currentUrlParameters: {
    handler() { this.syncWithURL(); },
    deep: true
  }
}
```

### Issue: Parameters empty on dashboard

**Cause**: Using direct path comparison instead of `getParametersForContainer()`

**Solution**: Always use context-aware retrieval:

```javascript
// ✓ CORRECT
NavigationRegistry.getParametersForContainer(
  containerPath,
  appContext.currentPath
);

// ✗ INCORRECT - fails on dashboard
if (appContext.currentPath.includes("schedule")) {
  return NavigationRegistry.getNavigationParameters(appContext.currentPath);
}
```

### Issue: Dashboard parameters not persisting

**Cause**: Using `navigateToPath()` instead of `dashboardRegistry.updatePath()`

**Solution**: Check context before updating:

```javascript
updateParameters(newParams) {
  const newPath = NavigationRegistry.buildPath(this.containerPath, newParams);
  const isOnDashboard = this.appContext.currentPath.split('/')[0] === 'dashboard';

  if (isOnDashboard) {
    dashboardRegistry.updatePath(this.containerPath.split('?')[0], newPath);
  } else {
    this.navigateToPath(newPath);
  }
}
```

### Issue: Parameters being overwritten instead of merged

**Cause**: Not using `buildPath()` or building JSON manually

**Solution**: Always use `buildPath()`:

```javascript
// ✓ CORRECT
const newPath = NavigationRegistry.buildPath(currentPath, newParams);

// ✗ INCORRECT
const newPath = currentPath.split("?")[0] + "?" + JSON.stringify(newParams);
```

### Issue: JSON parsing error on URL load

**Cause**: Browser URL-encodes the JSON when user pastes or bookmarks

**Solution**: Already handled - `parsePath()` uses `decodeURIComponent()` before parsing

### Issue: Default always being applied even with URL params

**Cause**: Not checking for existing parameters before applying default

**Solution**: Check parameters first:

```javascript
if (Object.keys(this.currentUrlParameters).length === 0) {
  this.applyDefault();
} else {
  this.syncWithURL(this.currentUrlParameters);
}
```

### Issue: Infinite loop when navigating

**Cause**: Watcher calling navigation which triggers watcher again

**Solution**: Only navigate on user actions, sync on URL changes:

```javascript
// ✓ CORRECT
watch: {
  currentUrlParameters() {
    this.syncStateWithoutNavigating();
  }
}

// ✗ INCORRECT
watch: {
  currentUrlParameters() {
    this.navigateToPath(somePath); // Creates loop!
  }
}
```

## Summary

The navigation system provides a clean, reactive way to manage application state through URLs and dashboard persistence:

- **Regular Navigation**: State encoded in URL using JSON format (`#route?{"param":"value"}`)
- **Dashboard Navigation**: Container paths with parameters stored in DashboardRegistry
- **Context-Aware**: Components use `getParametersForContainer()` to retrieve parameters correctly in both contexts
- **Single Source of Truth**: Regular pages use URL, dashboard containers use registry
- **Reactive Updates**: Components watch parameters and sync automatically
- **Best Practice**: Navigate on user actions, sync on parameter changes

The key is to **always use `getParametersForContainer()`** for reading parameters, **check dashboard context** when updating, and **never mix the read/write flows**.
