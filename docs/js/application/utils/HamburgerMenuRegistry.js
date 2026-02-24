import { html, DashboardToggleComponent, NavigationRegistry } from '../index.js';

const { reactive } = Vue;

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
            currentView: this.getCurrentView(containerPath),
            title: NavigationRegistry.getDisplayName(containerPath, true), // Use centralized display logic
            modalClass: 'hamburger-menu',
            // Merge with menu-specific props
            ...menu.props
        };
        
        return {
            components: menu.components,
            props: standardProps
        };
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

    getCurrentView(containerPath) {
        if (!containerPath) return '';
        // Strip query parameters before splitting
        const cleanPath = containerPath.split('?')[0];
        const segments = cleanPath.split('/').filter(s => s.length > 0);
        return segments.length > 0 ? segments[segments.length - 1] : '';
    }
}

// Create global instance
export const hamburgerMenuRegistry = new HamburgerMenuRegistry();
