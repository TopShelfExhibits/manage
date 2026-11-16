import { html, BannerNotifications } from '../../index.js';

/**
 * Notices page (route 'notices', not in the primary navigation): the app banners (connection,
 * sign-in, updates, shortages, bookmarks) drawn as a page, so the dashboard can hold them as a
 * card the user places. While this card is on the dashboard, app.js stops drawing the banners at
 * the top of the dashboard; without it they go to the corner tray (BannerNotifications collapsed).
 * Banners scrolled out of this card's view go to the corner tray as on any page.
 */
export const NoticesContent = {
    components: { BannerNotifications },
    inject: ['appContext'],
    template: html`
        <BannerNotifications :banners="appContext.appBanners" scope="app">
            <template #empty><p class="empty-message">No notices</p></template>
        </BannerNotifications>
    `
};
