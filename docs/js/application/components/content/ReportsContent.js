import { html, hamburgerMenuRegistry, NavigationRegistry, DashboardToggleComponent, ProposalUtils } from '../../index.js';
import { ShowInventoryReport } from './ShowInventoryReport.js';
import { InventoryItemReport } from './InventoryItemReport.js';
import { IndexMismatchReport } from './IndexMismatchReport.js';
import { InventoryProposalsGrid, InventoryProposalTable } from './InventoryProposals.js';
import { PROPOSALS_PATH, PROPOSALS_ROUTE, getProposalsStore, registerProposalRoutes } from '../../utils/inventoryProposals.js';

export const ReportsContent = {
    components: {
        'show-inventory-report': ShowInventoryReport,
        'inventory-item-report': InventoryItemReport,
        'index-mismatch-report': IndexMismatchReport,
        'inventory-proposals-grid': InventoryProposalsGrid,
        'inventory-proposal-table': InventoryProposalTable
    },
    props: {
        containerPath: {
            type: String,
            default: 'reports'
        },
        navigateToPath: Function,
    },
    data() {
        return {
            proposalsStore: getProposalsStore(),
            items: [
                { id: 'show-usage', title: 'Show Usage', content: 'View inventory quantities across shows in a matrix.', cardClass: 'blue' },
                { id: 'item-shortages', title: 'Item Shortages', content: 'View items with quantities that drop below a set threshold.', cardClass: 'blue' },
                { id: 'index-mismatches', title: 'Index Mismatches', content: 'View and resolve all unmatched client and show names from the production schedule and pack lists.', cardClass: 'blue' },
                { id: PROPOSALS_ROUTE, title: 'Inventory Proposals', content: 'Review, edit and commit proposed inventory changes.', cardClass: 'blue' }
            ]
        };
    },
    computed: {
        // Every proposal (reads each entry, so in-place store updates re-register routes)
        proposals() {
            return ProposalUtils.groupProposals(this.proposalsStore.data || []);
        },
        cleanContainerPath() {
            return this.containerPath.split('?')[0];
        },
        isProposalsGrid() {
            return this.cleanContainerPath === PROPOSALS_PATH;
        },
        // reports/inventory-proposals/<slug>
        proposalSlug() {
            const prefix = `${PROPOSALS_PATH}/`;
            return this.cleanContainerPath.startsWith(prefix)
                ? this.cleanContainerPath.slice(prefix.length).split('/')[0]
                : null;
        }
    },
    watch: {
        proposals(proposals) {
            registerProposalRoutes(proposals);
        }
    },
    methods: {
        handleReportSelect(report) {
            this.navigateToPath(`reports/${report.id}`);
        },
        handleReportKey(event, report) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.handleReportSelect(report);
            }
        }
    },
    mounted() {
        // Register reports navigation route with child routes
        NavigationRegistry.registerNavigation('reports', {
            routes: {
                'show-usage': {
                    displayName: 'Show Usage',
                    dashboardTitle: 'Show Usage Report'
                },
                'item-shortages': {
                    displayName: 'Item Shortages',
                    dashboardTitle: 'Item Shortages Report'
                },
                'index-mismatches': {
                    displayName: 'Index Mismatches',
                    dashboardTitle: 'Index Mismatches Report'
                },
                [PROPOSALS_ROUTE]: {
                    displayName: 'Inventory Proposals',
                    dashboardTitle: 'Inventory Proposals'
                }
            }
        });

        // One child route per proposal (breadcrumb names, deep links); kept current by the watcher
        registerProposalRoutes(this.proposals);

        // Register hamburger menu for reports
        hamburgerMenuRegistry.registerMenu('reports', {
            components: [DashboardToggleComponent],
            props: {
                navigateToPath: this.navigateToPath
            }
        });
    },
    template: html`
        
        <slot>
            <!-- Reports Landing: a static menu built with the shared card CSS (R3.7) -->
            <div v-if="cleanContainerPath === 'reports'" style="width: 100%;">
                <div class="cards-grid">
                    <div
                        v-for="item in items"
                        :key="item.id"
                        :class="['card', 'clickable', item.cardClass]"
                        tabindex="0"
                        :title="item.title"
                        :aria-label="item.title + ': ' + item.content"
                        @click="handleReportSelect(item)"
                        @keydown="handleReportKey($event, item)"
                    >
                        <div class="content-header">
                            <h3>{{ item.title }}</h3>
                        </div>
                        <div class="content">
                            <div>{{ item.content }}</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Show Inventory Report View -->
            <show-inventory-report
                v-else-if="cleanContainerPath === 'reports/show-usage'"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />

            <!-- Item-centric Inventory Report View -->
            <inventory-item-report
                v-else-if="cleanContainerPath === 'reports/item-shortages'"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />

            <!-- Index Mismatch Report View -->
            <index-mismatch-report
                v-else-if="cleanContainerPath === 'reports/index-mismatches'"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />

            <!-- Inventory Proposals: cards, then one proposal -->
            <inventory-proposals-grid
                v-else-if="isProposalsGrid"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />
            <inventory-proposal-table
                v-else-if="proposalSlug"
                :key="proposalSlug"
                :proposal-slug="proposalSlug"
                :container-path="containerPath"
                :navigate-to-path="navigateToPath"
            />

            <!-- 404 state when item not found (aka when the store returns null) -->
            <div v-else>
                <div class="card red">
                    <h3>Report Not Found</h3>
                    <p>The report you are looking for could not be found.</p>
                </div>
            </div>
        </slot>
    `
};
