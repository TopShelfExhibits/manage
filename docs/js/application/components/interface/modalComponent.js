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
        <img src="images/error.png" alt="Error" style="width: 64px; height: 64px; margin-bottom: 1rem;" />
    `
};

export const ModalComponent = {
    props: {
        modalId: { type: String, required: true },
        title: { type: String, default: '' },
        isVisible: { type: Boolean, default: false },
        components: { type: Array, default: () => [] },
        modalClass: { type: String, default: '' },
        message: { type: String, default: '' },
        contentClass: { type: String, default: '' },
        componentProps: { type: Object, default: () => ({}) }
    },
    computed: {
        formattedMessage() {
            return this.message ? this.message.replace(/\n/g, '<br>') : '';
        }
    },
    methods: {
        closeModal() { this.$emit('close-modal', this.modalId); }
    },
    template: html`
        <div v-if="isVisible" class="modal-overlay" @click.self="closeModal">
            <div :class="['modal', modalClass]">
                <div class="modal-header">
                    <h3>{{ title }}</h3>
                    <button class="close-button" @click="closeModal">🗙</button>
                </div>
                <div :class="['content', contentClass]">
                    <div v-if="formattedMessage" v-html="formattedMessage"></div>
                    <component v-for="(comp, idx) in components" :is="comp" :key="idx" 
                               v-bind="componentProps" @close-modal="closeModal"></component>
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
        const { modalClass, message, contentClass, ...componentProps } = props || {};
        
        const modal = {
            id: `modal-${this.nextId++}`,
            title,
            isVisible: true,
            components: Array.isArray(components) ? components : (components ? [components] : []),
            modalClass: modalClass || '',
            message: message || '',
            contentClass: contentClass || '',
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
            modalClass: 'reading-menu' 
        });
    }

    confirm(message, onConfirm, onCancel = null, title = 'Confirm', confirmText = null, cancelText = null) {
        return this._create(title, ConfirmButtonsComponent, { 
            message, 
            onConfirm, 
            onCancel, 
            confirmText, 
            cancelText, 
            modalClass: 'reading-menu' 
        });
    }

    image(imageUrl, title = 'Image') {
        return this._create(title, ImageContentComponent, { imageUrl, modalClass: 'reading-menu' });
    }

    error(message, title = 'Error') {
        return this._create(title, ErrorIconComponent, { 
            message, 
            modalClass: 'reading-menu red' 
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