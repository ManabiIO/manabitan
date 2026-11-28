/*
 * Copyright (C) 2026 Manabitan authors
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

// Ordinary worker RPC IDs start at 1. The notification has no reply.
export const termContentOptimizationNotificationId = 0;

/**
 * Reconciled desired state travels with ordinary runtime requests so a lost ACK
 * or a recreated offscreen/worker cannot forget an import hold. Older snapshots
 * never undo a newer release; retired backend sessions cannot revive old holds.
 */
export class TermContentOptimizationControl {
    constructor() {
        /** @type {import('offscreen').TermContentOptimizationState|null} */
        this.state = null;
        /** @type {Set<string>} */
        this._retiredSessions = new Set();
    }

    /**
     * @param {import('offscreen').TermContentOptimizationState|undefined} state
     * @returns {boolean}
     * @throws {TypeError} If the state does not match the bounded runtime control schema.
     */
    accept(state) {
        if (typeof state === 'undefined') { return false; }
        if (!state || typeof state.sessionId !== 'string' || state.sessionId.length === 0 || state.sessionId.length > 128 ||
        !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.ready !== 'boolean' ||
        !Array.isArray(state.ownerIds) || state.ownerIds.length > 128 ||
        state.ownerIds.some((ownerId) => typeof ownerId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(ownerId))) {
            throw new TypeError('Invalid content optimization control state');
        }
        if (this._retiredSessions.has(state.sessionId)) { return false; }
        const current = this.state;
        if (current?.sessionId === state.sessionId && current.revision >= state.revision) { return false; }
        if (current && current.sessionId !== state.sessionId) {
            this._retiredSessions.add(current.sessionId);
            // Runtime RPC deadlines bound delayed delivery; retain many more
            // retired backend sessions than can coexist in that window.
            if (this._retiredSessions.size > 256) {
                const first = this._retiredSessions.values().next().value;
                if (typeof first === 'string') { this._retiredSessions.delete(first); }
            }
        }
        this.state = {...state, ownerIds: [...new Set(state.ownerIds)]};
        return true;
    }
}
