/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {safePerformance} from '../core/safe-performance.js';

const suppressedClickDurationMs = 400;

/**
 * @param {import('event-listener-collection').EventTarget} target
 * @param {string} eventName
 * @param {EventListener|EventListenerObject|import('event-listener-collection').EventListenerFunction} listener
 * @param {AddEventListenerOptions|boolean|undefined} options
 * @param {import('../core/event-listener-collection.js').EventListenerCollection|null} eventListeners
 * @returns {void}
 */
function addDomEventListener(target, eventName, listener, options, eventListeners) {
    if (eventListeners !== null) {
        eventListeners.addEventListener(target, eventName, listener, options);
    } else {
        target.addEventListener(eventName, listener, options);
    }
}

/**
 * Adds `pointerup` and `click` listeners which invoke the callback at most once for a primary touch/pen activation.
 * This preserves desktop click/keyboard behavior while allowing Android browsers that drop `click` events to still
 * trigger the action from `pointerup`.
 * @param {import('event-listener-collection').EventTarget} target
 * @param {(event: MouseEvent|PointerEvent) => void} onActivate
 * @param {import('../core/event-listener-collection.js').EventListenerCollection|null} [eventListeners]
 * @returns {{onPointerUp: (event: PointerEvent) => void, onClick: (event: MouseEvent) => void}}
 */
export function addPrimaryActivationEventListeners(target, onActivate, eventListeners = null) {
    /** @type {EventTarget|null} */
    let suppressedClickTarget = null;
    let suppressedClickUntil = 0;

    /**
     * @param {PointerEvent} event
     * @returns {void}
     */
    const onPointerUp = (event) => {
        if (!event.isPrimary || event.button !== 0 || event.pointerType === 'mouse') { return; }
        suppressedClickTarget = event.currentTarget;
        suppressedClickUntil = safePerformance.now() + suppressedClickDurationMs;
        onActivate(event);
    };

    /**
     * @param {MouseEvent} event
     * @returns {void}
     */
    const onClick = (event) => {
        if (event.button !== 0) { return; }
        if (
            event.detail !== 0 &&
            suppressedClickTarget !== null &&
            suppressedClickTarget === event.currentTarget &&
            safePerformance.now() < suppressedClickUntil
        ) {
            suppressedClickTarget = null;
            suppressedClickUntil = 0;
            return;
        }
        onActivate(event);
    };

    addDomEventListener(target, 'pointerup', onPointerUp, false, eventListeners);
    addDomEventListener(target, 'click', onClick, false, eventListeners);

    return {onPointerUp, onClick};
}
