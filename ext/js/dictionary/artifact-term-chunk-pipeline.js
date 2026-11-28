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

/** @typedef {Parameters<import('./dictionary-database.js').DictionaryDatabase['_bulkAddArtifactTermsChunkWithContentDedup']>[0]} ArtifactTermChunk */
/** @typedef {{published: Promise<void>, completion: Promise<Record<string, number>>}} ArtifactTermChunkAppend */
/**
 * @typedef {object} ArtifactTermChunkAppendContext
 * @property {() => Promise<void>} beforePublication
 * @property {() => void} published
 * @property {(error: unknown) => void} failed
 * @property {(error: unknown) => Promise<void>} beforeRollback
 * @property {() => void} throwIfStopped
 */
/**
 * @typedef {object} AppendOwner
 * @property {ArtifactTermChunkAppend} operation
 * @property {ReturnType<typeof createBarrier>} publication
 * @property {ReturnType<typeof createBarrier>} settled
 * @property {AppendOwner|null} successor
 * @property {boolean} canOverlap
 */

/** @returns {{promise: Promise<void>, resolve: () => void, reject: (error: unknown) => void}} */
function createBarrier() {
    /** @type {() => void} */
    let resolve = () => {};
    /** @type {(error: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<void>} */
    const promise = new Promise((onResolve, onReject) => {
        resolve = () => { onResolve(); };
        reject = onReject;
    });
    void promise.catch(() => {});
    return {promise, resolve, reject};
}

/**
 * Owns at most one content preparation ahead of the completed ordered sink.
 * Storage operations settle before rollback can wait for a successor, so that
 * successor can observe failure and unwind without waiting for its predecessor.
 */
export class ArtifactTermChunkPipeline {
    /**
     * @param {{
     *   append: (chunk: ArtifactTermChunk, context: ArtifactTermChunkAppendContext) => Promise<Record<string, number>>,
     *   canOverlap: (chunk: ArtifactTermChunk) => boolean,
     *   validateOwner: () => void,
     * }} dependencies
     */
    constructor({append, canOverlap, validateOwner}) {
        /** @type {(chunk: ArtifactTermChunk, context: ArtifactTermChunkAppendContext) => Promise<Record<string, number>>} */
        this._append = append;
        /** @type {(chunk: ArtifactTermChunk) => boolean} */
        this._canOverlap = canOverlap;
        /** @type {() => void} */
        this._validateOwner = validateOwner;
        /** @type {AppendOwner|null} */
        this._tail = null;
        /** @type {Set<AppendOwner>} */
        this._pending = new Set();
        /** @type {unknown[]} */
        this._terminalFailures = [];
        /** @type {boolean} */
        this._closed = false;
        /** @type {boolean} */
        this._failed = false;
        /** @type {unknown} */
        this._failure = void 0;
    }

    /**
     * @param {ArtifactTermChunk} chunk
     * @returns {ArtifactTermChunkAppend}
     */
    begin(chunk) {
        return this._begin(chunk, false);
    }

    /**
     * Legacy completion-awaiting writes share the same admission queue, so a
     * concurrently admitted successor cannot bypass a snapshot-only drain.
     * @param {ArtifactTermChunk} chunk
     * @returns {Promise<Record<string, number>>}
     */
    async appendSerial(chunk) {
        return await this._begin(chunk, true).completion;
    }

    /**
     * @param {ArtifactTermChunk} chunk
     * @param {boolean} serial
     * @returns {ArtifactTermChunkAppend}
     * @throws {Error} If ownership changed or one successor is already pending.
     */
    _begin(chunk, serial) {
        this._validateOwner();
        this._throwIfStopped();
        if (this._closed) { throw new Error('Artifact term chunk pipeline is closed'); }
        if (this._pending.size >= 2) {
            throw new Error('Artifact term chunk pipeline already owns one successor');
        }
        const predecessor = this._tail;
        const publication = createBarrier();
        const settled = createBarrier();
        const canOverlap = !serial && this._canOverlap(chunk);
        /** @type {AppendOwner} */
        const owner = {
            operation: {published: publication.promise, completion: Promise.resolve({})},
            publication,
            settled,
            successor: null,
            canOverlap,
        };
        this._tail = owner;
        this._pending.add(owner);
        /** @type {ArtifactTermChunkAppendContext} */
        const context = {
            beforePublication: async () => {
                if (predecessor !== null) { await predecessor.settled.promise; }
                this._throwIfStopped();
                this._validateOwner();
            },
            published: () => {
                if (canOverlap) { publication.resolve(); }
            },
            failed: (error) => { this.cancel(error); },
            beforeRollback: async (error) => {
                // Reject the dependency before joining the successor: its
                // publication barrier must wake before our rollback can wait.
                this.cancel(error);
                settled.reject(error);
                publication.reject(error);
                if (owner.successor !== null) {
                    await owner.successor.operation.completion.catch(() => {});
                }
            },
            throwIfStopped: () => {
                this._throwIfStopped();
                this._validateOwner();
            },
        };
        owner.operation.completion = Promise.resolve().then(async () => {
            if (predecessor !== null) {
                if (canOverlap && predecessor.canOverlap) {
                    await predecessor.publication.promise;
                    this._throwIfStopped();
                    // Until this point the successor has touched no mutable
                    // database state and must not block predecessor rollback.
                    predecessor.successor = owner;
                } else {
                    await predecessor.operation.completion;
                }
            }
            context.throwIfStopped();
            const metrics = await this._append(chunk, context);
            context.throwIfStopped();
            return metrics;
        }).then((metrics) => {
            settled.resolve();
            publication.resolve();
            return metrics;
        }, async (error) => {
            // Retain terminal errors after owners leave the pending set, for
            // close/abort to report real failures while filtering cancellation.
            this._terminalFailures.push(error);
            await context.beforeRollback(error);
            throw error;
        })
            .finally(() => {
                this._pending.delete(owner);
                if (predecessor?.successor === owner) { predecessor.successor = null; }
                if (this._tail === owner) { this._tail = null; }
            });
        void owner.operation.completion.catch(() => {});
        return owner.operation;
    }

    /**
     * Latches the original stop reason, including undefined rejections.
     * Started compression and record writes stay owned until they settle.
     * @param {unknown} error
     */
    cancel(error) {
        if (this._failed) { return; }
        this._failed = true;
        this._failure = error;
    }

    /** @returns {unknown[]} Distinct terminal errors, including already retired owners. */
    getFailures() {
        return [...new Set(this._terminalFailures)];
    }

    /** @returns {Promise<void>} */
    async drain() {
        await Promise.allSettled([...this._pending].map(({operation}) => operation.completion));
        this._throwIfStopped();
    }

    /** @returns {Promise<void>} */
    async close() {
        this._closed = true;
        await this.drain();
    }

    /** @throws {unknown} The original stop reason, if any. */
    _throwIfStopped() {
        if (this._failed) { throw this._failure; }
    }
}

/**
 * Returns a completion owner once the consumer publishes its ordered metadata.
 * The consumer keeps metrics, progress and source clearing inside completion.
 * @param {(published: () => void) => Promise<void>} consume
 * @returns {Promise<{completion: Promise<void>}>}
 */
export async function beginArtifactTermChunkSink(consume) {
    const publication = createBarrier();
    const completion = Promise.resolve().then(async () => { await consume(publication.resolve); });
    void completion.catch(() => {});
    await Promise.race([publication.promise, completion]);
    return {completion};
}
