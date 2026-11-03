import { html } from '../../index.js';

// Auto-close handler component (no template, just behavior)
const AutoCloseComponent = {
    props: {
        autoClose: { type: Boolean, default: true }
    },
    mounted() {
        if (this.autoClose) {
            setTimeout(() => this.$emit('close-modal'), 3000);
        }
    },
    template: html``
};

// Confirm buttons component (just buttons, no message)
const ConfirmButtonsComponent = {
    props: ['onConfirm', 'onCancel', 'confirmText', 'cancelText'],
    methods: {
        confirm() { this.onConfirm?.(); this.$emit('close-modal'); },
        cancel() { this.onCancel?.(); this.$emit('close-modal'); }
    },
    template: html`
        <div class="button-bar">
            <button v-if="onConfirm" @click="confirm">{{ confirmText || 'Ok' }}</button>
            <button v-if="onCancel || cancelText" @click="cancel" class="gray">{{ cancelText || 'Cancel' }}</button>
        </div>
    `
};

// Image content component
const ImageContentComponent = {
    props: ['imageUrl'],
    template: html`
        <img :src="imageUrl" alt="Image" style="max-width: 90vw; max-height: 80vh; object-fit: contain;" />
    `
};

// Error icon component
const ErrorIconComponent = {
    template: html`
        <img src="assets/error.png" alt="Error" style="width: 64px; height: 64px; margin-bottom: 1rem;" />
    `
};

/**
 * Modal size tiers (views-and-renderers-plan §4.17). Every modal has exactly one size; layout and
 * colour classes (reading-menu, hamburger-menu, red) stay separate in modalClass.
 *   card (default)  360px content   → narrow container tier
 *   wide            750px content   → medium tier (two dashboard cards plus gap)
 *   page            min(viewport, 1000px) → wide tier on desktop (DataView, RowDetailsModal, pickers)
 *   auto            content-sized   → images only
 * `tall` keeps a fixed viewport height (like the dashboard .tall). All sizes cap at the viewport.
 */
export const MODAL_SIZES = Object.freeze(['card', 'wide', 'page', 'auto']);

export const ModalComponent = {
    props: {
        modalId: { type: String, required: true },
        title: { type: String, default: '' },
        isVisible: { type: Boolean, default: false },
        components: { type: Array, default: () => [] },
        modalClass: { type: String, default: '' },
        size: { type: String, default: 'card' },
        tall: { type: Boolean, default: false },
        message: { type: String, default: '' },
        contentClass: { type: String, default: '' },
        componentProps: { type: Object, default: () => ({}) },
        submitAction: { type: Function, default: null }
    },
    computed: {
        formattedMessage() {
            return this.message ? this.message.replace(/\n/g, '<br>') : '';
        }
    },
    mounted() {
        // Add keyboard event listener when modal is visible
        if (this.isVisible) {
            window.addEventListener('keydown', this.handleKeyDown);
        }
    },
    beforeUnmount() {
        // Clean up keyboard event listener
        window.removeEventListener('keydown', this.handleKeyDown);
    },
    watch: {
        isVisible(newVal, oldVal) {
            // Add/remove keyboard listener when visibility changes
            if (newVal && !oldVal) {
                window.addEventListener('keydown', this.handleKeyDown);
            } else if (!newVal && oldVal) {
                window.removeEventListener('keydown', this.handleKeyDown);
            }
        }
    },
    methods: {
        closeModal() { this.$emit('close-modal', this.modalId); },
        handleKeyDown(event) {
            // Only handle if this modal is visible
            if (!this.isVisible) return;

            // Escape key - always consume and close modal (cancel action)
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.closeModal();
            }

            // Enter key - always consume to prevent triggering buttons that opened the modal
            if (event.key === 'Enter') {
                // Don't consume if user is typing in a textarea or input field
                const tagName = event.target.tagName;
                if (tagName === 'TEXTAREA' || (tagName === 'INPUT' && event.target.type !== 'button' && event.target.type !== 'submit')) {
                    return;
                }
                
                // Always prevent default and stop propagation to consume the event
                event.preventDefault();
                event.stopPropagation();
                
                // Trigger submit action if one is registered
                if (this.submitAction) {
                    this.submitAction();
                }
            }
        }
    },
    template: html`
        <div v-if="isVisible" class="modal-overlay" @click.self="closeModal">
            <div :class="['modal', 'size-' + size, { tall }, modalClass]">
                <div class="modal-header">
                    <h3>{{ title }}</h3>
                    <button class="column-button" @click="closeModal"><span class="material-symbols-outlined">close</span></button>
                </div>
                <div :class="['content', contentClass]">
                    <div v-if="formattedMessage" v-html="formattedMessage"></div>
                    <component v-for="(comp, idx) in components" :is="comp" :key="idx" 
                               v-bind="componentProps" @close-modal="closeModal" :submit-action="submitAction"></component>
                </div>
            </div>
        </div>
    `
};

// Simplified Modal Manager - single class, essential methods only
export class ModalManager {
    constructor() {
        this.nextId = 1;
        this.modals = [];
    }

    setReactiveModals(reactiveArray) {
        this.modals = reactiveArray;
    }

    _create(title, components, props) {
        // Extract modal-level props from component props
        const { modalClass, size, tall, message, contentClass, submitAction, ...componentProps } = props || {};

        const modal = {
            id: `modal-${this.nextId++}`,
            title,
            isVisible: true,
            components: Array.isArray(components) ? components : (components ? [components] : []),
            modalClass: modalClass || '',
            size: MODAL_SIZES.includes(size) ? size : 'card',
            tall: !!tall,
            message: message || '',
            contentClass: contentClass || '',
            submitAction: submitAction || null,
            componentProps
        };
        this.modals.push(modal);
        return modal;
    }

    removeModal(modalId) {
        const index = this.modals.findIndex(m => m.id === modalId);
        if (index !== -1) this.modals.splice(index, 1);
    }

    // Core methods that are actually used
    alert(message, title = 'Alert', autoClose = true) {
        return this._create(title, autoClose ? AutoCloseComponent : null, {
            message,
            autoClose,
            modalClass: 'reading-menu',
            size: 'card'
        });
    }

    confirm(message, onConfirm, onCancel = null, title = 'Confirm', confirmText = null, cancelText = null, modalClass = 'reading-menu') {
        return this._create(title, ConfirmButtonsComponent, {
            message,
            onConfirm,
            onCancel,
            confirmText,
            cancelText,
            modalClass,
            size: 'card'
        });
    }

    image(imageUrl, title = 'Image') {
        return this._create(title, ImageContentComponent, { imageUrl, modalClass: 'reading-menu', size: 'auto' });
    }

    error(message, title = 'Error') {
        return this._create(title, ErrorIconComponent, {
            message,
            modalClass: 'reading-menu red',
            size: 'card'
        });
    }

    custom(components, props = {}, title = '') {
        return this._create(title, components, props);
    }

    // Legacy compatibility (remove these after testing)
    showAlert(message, title) { return this.alert(message, title); }
    showConfirm(message, onConfirm, onCancel, title) { return this.confirm(message, onConfirm, onCancel, title); }
    createModal(title, components, options) { return this._create(title, components, options.componentProps); }
    showModal() { /* No-op - modals show immediately now */ }
}

// Create a global instance
export const modalManager = new ModalManager();