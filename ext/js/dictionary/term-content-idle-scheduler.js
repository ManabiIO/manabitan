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

/**
 * Idle admission for bounded optional maintenance steps. Durable job ownership,
 * file writes and short SQLite publication remain with the injected step.
 * Foreground admission never waits for optional I/O to finish. Its signal
 * MUST synchronously terminate any disposable CPU worker owned by that step.
 */
export class TermContentIdleScheduler {
    /**
     * @param {{runStep: (signal: AbortSignal) => Promise<{pending: boolean, retryAt?: number}>, onError?: (error: unknown) => void, idleMs?: number, continuationMs?: number, retryMs?: number, now?: () => number}} options
     */
    constructor({runStep, onError = () => {}, idleMs = 10000, continuationMs = 1, retryMs = 30000, now = Date.now}) {
        if (typeof runStep !== 'function' || typeof onError !== 'function' || typeof now !== 'function' ||
        !Number.isInteger(idleMs) || idleMs < 1 || idleMs > 60000 ||
        !Number.isInteger(continuationMs) || continuationMs < 1 || continuationMs > 1000 ||
        !Number.isInteger(retryMs) || retryMs < 1 || retryMs > 3600000) {
            throw new TypeError('Invalid content maintenance scheduler options');
        }
        /**
         *
         */
        this._runStep = runStep;
        /**
         *
         */
        this._onError = onError;
        /**
         *
         */
        this._idleMs = idleMs;
        /**
         *
         */
        this._continuationMs = continuationMs;
        /**
         *
         */
        this._idleDeadline = 0;
        /**
         *
         */
        this._retryMs = retryMs;
        /**
         *
         */
        this._now = now;
        /** @type {Set<string>} */
        this._holds = new Set();
        /**
         *
         */
        this._foreground = 0;
        /**
         *
         */
        this._pending = false;
        /**
         *
         */
        this._wakeGeneration = 0;
        /**
         *
         */
        this._notBefore = 0;
        /**
         *
         */
        this._closed = false;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._timer = null;
        /**
         *
         */
        this._timerGeneration = 0;
        /** @type {{controller: AbortController, promise: Promise<void>}|null} */
        this._active = null;
    }

    /** Called only after full import/backend ownership release or startup readiness. */
    wake() {
        if (this._closed) { return; }
        this._pending = true;
        ++this._wakeGeneration;
        if (this._active === null && this._foreground === 0 && this._holds.size === 0) {
            this._idleDeadline = this._now() + this._idleMs;
        }
        // Job cooldowns are durable in the step adapter. A new candidate may
        // have become eligible while this queue-level timer was deferred.
        this._notBefore = 0;
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
            ++this._timerGeneration;
        }
        this._schedule();
    }

    /**
     * Keep a durable import/download/session hold across many foreground RPCs.
     * Holds are unique owner IDs, so duplicate admission/release is idempotent.
     * @param {string} ownerId
     * @param {boolean} active
     * @throws {TypeError|RangeError} If owner metadata exceeds admission.
     */
    setHold(ownerId, active) {
        if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 128 || typeof active !== 'boolean') {
            throw new TypeError('Invalid content maintenance hold');
        }
        if (this._closed) { return; }
        if (active) {
            if (!this._holds.has(ownerId) && this._holds.size >= 256) { throw new RangeError('Too many content maintenance holds'); }
            this._holds.add(ownerId);
            this._preempt();
        } else if (this._holds.delete(ownerId)) {
            if (this._holds.size === 0) {
                // Startup and completed import ownership can reveal a new generation.
                this._pending = true;
                this._notBefore = 0;
                this._idleDeadline = this._now() + this._idleMs;
            }
            this._schedule();
        }
    }

    /**
     * Synchronously preempt before dispatching a visible read or mutation.
     * Call the idempotent release after all work owned by that request settles.
     * @returns {() => void}
     */
    foregroundStarted() {
        if (this._closed) { return () => {}; }
        ++this._foreground;
        this._preempt();
        let released = false;
        return () => {
            if (released) { return; }
            released = true;
            --this._foreground;
            if (this._foreground === 0) { this._idleDeadline = this._now() + this._idleMs; }
            this._schedule();
        };
    }

    /** Abort and join optional I/O while retaining holds and future scheduling. */
    async preemptAndJoin() {
        this._preempt();
        await this._active?.promise;
    }

    /**
     * Stop new work and join the active step before purge/connection teardown.
     * @returns {Promise<void>}
     */
    close() {
        this._closed = true;
        this._pending = false;
        this._preempt();
        return this._active?.promise ?? Promise.resolve();
    }

    /** */
    _preempt() {
        ++this._timerGeneration;
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._active?.controller.abort();
    }

    /** Continue bounded steps after a task yield; quiet time follows foreground activity. */
    _schedule() {
        if (this._closed || !this._pending || this._active !== null || this._holds.size > 0 || this._foreground > 0 || this._timer !== null) { return; }
        const generation = ++this._timerGeneration;
        const delay = Math.max(this._continuationMs, Math.min(3600000, Math.max(this._idleDeadline, this._notBefore) - this._now()));
        this._timer = setTimeout(() => {
            if (generation !== this._timerGeneration) { return; }
            this._timer = null;
            if (this._closed || this._active !== null || this._holds.size > 0 || this._foreground > 0 || !this._pending) { return; }
            if (Math.max(this._idleDeadline, this._notBefore) > this._now()) {
                this._schedule();
                return;
            }
            this._startStep();
        }, delay);
    }

    /** */
    _startStep() {
        const controller = new AbortController();
        const wakeGeneration = this._wakeGeneration;
        // Defer the injected callback so identity is established even if it
        // synchronously throws, wakes the scheduler or admits foreground work.
        const active = {controller, promise: Promise.resolve()};
        this._active = active;
        active.promise = Promise.resolve().then(async () => {
            if (controller.signal.aborted) { return; }
            const result = await this._runStep(controller.signal);
            if (controller.signal.aborted || this._closed) { return; }
            if (!result || typeof result.pending !== 'boolean' ||
            (typeof result.retryAt !== 'undefined' && (!Number.isSafeInteger(result.retryAt) || result.retryAt < 0))) {
                throw new TypeError('Invalid content maintenance step result');
            }
            const hasTrailingWake = this._wakeGeneration !== wakeGeneration;
            this._pending = result.pending || hasTrailingWake;
            this._notBefore = hasTrailingWake ? 0 : (result.retryAt ?? 0);
        }).catch((error) => {
            if (controller.signal.aborted || this._closed) { return; }
            this._pending = true;
            this._notBefore = this._wakeGeneration !== wakeGeneration ? 0 : this._now() + this._retryMs;
            try { this._onError(error); } catch (_) { /* Diagnostics cannot strand the optional queue. */ }
        })
            .finally(() => {
                if (this._active === active) { this._active = null; }
                this._schedule();
            });
        // The scheduler owns this promise, including its unexpected-error path.
        void active.promise.catch(() => {});
    }
}
