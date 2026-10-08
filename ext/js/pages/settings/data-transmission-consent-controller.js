/*
 * Copyright (C) 2025-2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {querySelectorNotNull} from '../../dom/query-selector.js';
import {log} from '../../core/log.js';
import {ExtensionError} from '../../core/extension-error.js';
import {getDataTransmissionConsentUpdateTargets} from '../../data/data-transmission-consent-util.js';
import {ModalController} from './modal-controller.js';

export class DataTransmissionConsentController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {ModalController} modalController
     */
    constructor(settingsController, modalController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {ModalController} */
        this._modalController = modalController;
        /** @type {?HTMLButtonElement} */
        this._acceptDataTransmissionButton = null;
        /** @type {?HTMLButtonElement} */
        this._declineDataTransmissionButton = null;
        /** @type {Modal|null} */
        this._consentModal = null;
        /** @type {boolean} */
        this._decisionPending = false;
    }

    /** */
    async prepare() {
        const firefoxDataTransmissionModal = this._modalController.getModal('firefox-data-transmission-consent');

        if (firefoxDataTransmissionModal) {
            this._consentModal = firefoxDataTransmissionModal;
            this._acceptDataTransmissionButton = /** @type {HTMLButtonElement} */ (querySelectorNotNull(document, '#accept-data-transmission'));
            this._declineDataTransmissionButton = /** @type {HTMLButtonElement} */ (querySelectorNotNull(document, '#decline-data-transmission'));

            this._acceptDataTransmissionButton.addEventListener('click', this._onAcceptEvent.bind(this));
            this._declineDataTransmissionButton.addEventListener('click', this._onDeclineEvent.bind(this));
        }
    }

    // Private

    /** */
    async _onAccept() {
        await this._saveConsentDecision('accepted', true);
    }

    /**
     * @param {MouseEvent} _e
     */
    _onAcceptEvent(_e) {
        void this._onAccept().catch((error) => {
            log.error(error);
        });
    }

    /** */
    async _onDecline() {
        await this._saveConsentDecision('declined', false);
    }

    /**
     * Do not dismiss the required consent modal until all settings writes have
     * completed successfully. Backend modification errors can be returned per
     * target rather than rejected by the outer promise.
     * @param {'accepted'|'declined'} state
     * @param {boolean} audioEnabled
     * @returns {Promise<void>}
     */
    async _saveConsentDecision(state, audioEnabled) {
        if (this._decisionPending) { return; }
        this._decisionPending = true;
        if (this._acceptDataTransmissionButton) { this._acceptDataTransmissionButton.disabled = true; }
        if (this._declineDataTransmissionButton) { this._declineDataTransmissionButton.disabled = true; }
        const errorNode = document.querySelector('#data-transmission-consent-save-error');
        if (errorNode instanceof HTMLElement) {
            errorNode.hidden = true;
            errorNode.textContent = '';
        }
        try {
            const targets = getDataTransmissionConsentUpdateTargets(state, audioEnabled, this._settingsController.getOptionsContext());
            const results = await this._settingsController.modifySettings(targets);
            if (!Array.isArray(results) || results.length !== targets.length) {
                throw new Error('Consent update returned an incomplete response');
            }
            for (const result of results) {
                if (typeof result !== 'object' || result === null) {
                    throw new Error('Consent update returned an invalid response');
                }
                if (result.error) { throw ExtensionError.deserialize(result.error); }
            }
            this._consentModal?.setVisible(false);
        } catch (error) {
            if (errorNode instanceof HTMLElement) {
                errorNode.textContent = 'Could not save your choice. Please try again.';
                errorNode.hidden = false;
            }
            throw error;
        } finally {
            this._decisionPending = false;
            if (this._acceptDataTransmissionButton) { this._acceptDataTransmissionButton.disabled = false; }
            if (this._declineDataTransmissionButton) { this._declineDataTransmissionButton.disabled = false; }
        }
    }

    /**
     * @param {MouseEvent} _e
     */
    _onDeclineEvent(_e) {
        void this._onDecline().catch((error) => {
            log.error(error);
        });
    }
}
