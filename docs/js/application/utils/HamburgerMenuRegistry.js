import { html, DashboardToggleComponent, NavigationRegistry, Requests } from '../index.js';
import { PageNoteMenuComponent } from '../components/interface/pageNoteComponent.js';
import { PreferencesMenuComponent } from '../components/interface/preferencesComponent.js';

const { reactive } = Vue;

// Lock Removal Menu Component (reusable across all domains)
const LockRemovalMenuComponent = {
    name: 'LockRemovalMenuComponent',
    props: {
        getLockInfo: { type: Function, required: true },
        refreshCallback: { type: Function, required: false },
        sheetName: { type: String, required: true }
    },
    inject: ['$modal'],
    emits: ['close-modal'],
    data() {
        return {
            lockInfo: null,
            isLoadingLockInfo: true,
            isRemovingLock: false
        };
    },
    async mounted() {
        await this.fetchLockInfo();
    },
    computed: {
        lockOwnerUsername() {
            if (!this.lockInfo || !this.lockInfo.user) return null;
            const email = this.lockInfo.user;
            return email.includes('@') ? email.split('@')[0] : email;
        },
        menuItem() {
            if (this.isLoadingLockInfo || !this.lockInfo) {
                return null;
            }
            return {
                label: this.isRemovingLock ? 'Removing lock...' : `Remove lock: ${this.lockOwnerUsername}`,
                action: 'removeLock',
                class: this.isRemovingLock ? 'analyzing' : 'white',
                disabled: this.isRemovingLock
            };
        }
    },
    methods: {
        async fetchLockInfo() {
            this.isLoadingLockInfo = true;
            try {
                if (this.getLockInfo) {
                    this.lockInfo = await this.getLockInfo();
                }
            } catch (error) {
                console.error('[LockRemovalMenu] Error fetching lock info:', error);
            } finally {
                this.isLoadingLockInfo = false;
            }
        },
        async handleRemoveLock() {
            if (!this.lockInfo) {
                this.$modal.alert('No lock to remove.', 'Info');
                return;
            }

            const username = this.lockOwnerUsername;
            const tabName = this.lockInfo.tab;

            this.$modal.confirm(
                `Are you sure you want to force unlock ${tabName}?\n${username} may have unsaved changes.`,
                async () => {
                    this.isRemovingLock = true;
                    try {
                        const result = await Requests.forceUnlockSheet(this.sheetName, tabName, 'User requested via hamburger menu');

                        if (result.success) {
                            this.$modal.alert(
                                `Lock removed successfully.\n\nPreviously locked by: ${username}\nAutosave entries backed up: ${result.backupCount}\nAutosave entries deleted: ${result.deletedCount}`,
                                'Success'
                            );

                            // Refresh lock info in the menu
                            await this.fetchLockInfo();

                            // Refresh page data and lock state via callback
                            if (this.refreshCallback) {
                                await this.refreshCallback();
                            }
                        } else {
                            this.$modal.error(`Failed to remove lock: ${result.message}`, 'Error');
                        }
                    } catch (error) {
                        console.error('[LockRemovalMenu] Error removing lock:', error);
                        this.$modal.error(`Error removing lock: ${error.message}`, 'Error');
                    } finally {
                        this.isRemovingLock = false;
                    }
                },
                () => {},
                'Confirm Force Unlock',
                'Force Unlock'
            );
        }
    },
    template: html`
        <div v-if="menuItem">
            <ul>
                <li>
                    <button
                        @click="handleRemoveLock"
                        :disabled="menuItem.disabled"
                        :class="menuItem.class">
                        {{ menuItem.label }}
                    </button>
                </li>
            </ul>
        </div>
    `
};

// Hamburger Menu Registry
export class HamburgerMenuRegistry {
    constructor() {
        this.menus = reactive(new Map());
        this.setupDefaultMenus();
    }

    setupDefaultMenus() {
        // Default fallback for containers
        this.defaultMenu = {
            components: [DashboardToggleComponent],
            props: {}
        };
    }

    registerMenu(containerType, menuConfig) {
        // Validate that DashboardToggleComponent is included
        if (!menuConfig.components.includes(DashboardToggleComponent)) {
            console.warn(`Menu for ${containerType} should include DashboardToggleComponent`);
        }
        this.menus.set(containerType, menuConfig);
    }

    getMenuComponent(containerType, containerPath = '') {
        const menu = this.getMenuConfig(containerType, containerPath);
        
        // Always provide standardized props
        const standardProps = {
            containerPath,
            containerType,
            currentSegment: this.getCurrentSegment(containerPath),
            title: NavigationRegistry.getDisplayName(containerPath, true), // Use centralized display logic
            modalClass: 'hamburger-menu',
            // Merge with menu-specific props
            ...menu.props
        };
        
        // Automatically inject PageNoteMenuComponent into all menus as the top item
        let components = [...menu.components];
        if (!components.includes(PageNoteMenuComponent)) {
            components.unshift(PageNoteMenuComponent);
        }

        // Automatically inject PreferencesMenuComponent after PageNoteMenuComponent
        if (!components.includes(PreferencesMenuComponent)) {
            const noteIdx = components.indexOf(PageNoteMenuComponent);
            components.splice(noteIdx + 1, 0, PreferencesMenuComponent);
        }
        
        // Automatically inject LockRemovalMenuComponent if getLockInfo is provided
        if (standardProps.getLockInfo && !components.includes(LockRemovalMenuComponent)) {
            const sheetName = this.getSheetName(containerType);
            components.splice(1, 0, LockRemovalMenuComponent); // Insert after PageNoteMenuComponent
            
            // Add lock-specific props
            standardProps.sheetName = sheetName;
        }
        
        // For packlist menus, conditionally exclude table options if not viewing a table
        if (containerType === 'packlist' || containerPath.startsWith('packlist/')) {
            components = this.filterPacklistMenuComponents(components, containerPath);
        }
        
        return {
            components,
            props: standardProps
        };
    }
    
    getSheetName(containerType) {
        switch (containerType) {
            case 'packlist':
                return 'PACK_LISTS';
            case 'inventory':
                return 'INVENTORY';
            default:
                return '';
        }
    }
    
    filterPacklistMenuComponents(components, containerPath) {
        // Reserved packlist routes that are NOT table views
        const reservedRoutes = new Set(['active', 'archived', 'templates', 'pins', 'details']);
        
        // Strip query parameters and split path
        const cleanPath = containerPath.split('?')[0];
        const segments = cleanPath.split('/').filter(s => s.length > 0);
        
        // Determine if this is a table view
        // Table view: packlist/{name} where {name} is not a reserved route and no additional segments
        let isTableView = false;
        if (segments.length === 2 && segments[0] === 'packlist') {
            // Check if the second segment is a reserved route or if there's a /details suffix
            isTableView = !reservedRoutes.has(segments[1]);
        }
        
        // If not a table view, filter out PacklistTableMenuComponent
        if (!isTableView) {
            components = components.filter(comp => {
                // Check if component name is PacklistTableMenuComponent
                return comp.name !== 'PacklistTableMenuComponent' && comp !== 'PacklistTableMenuComponent';
            });
        }
        
        return components;
    }

    getMenuConfig(containerType, containerPath = '') {
        // Check for exact container type match first
        if (this.menus.has(containerType)) {
            return this.menus.get(containerType);
        }

        // Check for path-based matches
        if (containerPath) {
            // Strip query parameters before splitting
            const cleanPath = containerPath.split('?')[0];
            const segments = cleanPath.split('/').filter(s => s.length > 0);
            const basePath = segments[0];
            
            if (this.menus.has(basePath)) {
                return this.menus.get(basePath);
            }
        }

        // Return default menu for all containers
        return this.defaultMenu;
    }

    getCurrentSegment(containerPath) {
        if (!containerPath) return '';
        // Strip query parameters before splitting
        const cleanPath = containerPath.split('?')[0];
        const segments = cleanPath.split('/').filter(s => s.length > 0);
        return segments.length > 0 ? segments[segments.length - 1] : '';
    }
}

// Create global instance
export const hamburgerMenuRegistry = new HamburgerMenuRegistry();
