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


/** @typedef {{fileId: string, ownerJobId: string, state: 'intent'|'staged'|'active', byteLength: number, sha256: string|null}} ArtifactObservation */
/** @typedef {import('./term-content-optimization-controller.js').OptimizationJob} Job */

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/**
 * Recovery for small immutable sample/dictionary artifacts. The synchronous
 * lookup proves the durable intent owner before any file is created or reset.
 * A closed file with a lost acknowledgement is verified and reused; a partial
 * unpublished intent is discarded before replay. Staged bytes never change.
 */
export class TermContentOptimizationArtifacts {
    /**
     * @param {{store: import('./term-content-immutable-file-store.js').TermContentImmutableFileStore, lookup: (job: Job, fileId: string) => ArtifactObservation, assertOwned: (job: Job) => void}} options
     */
    constructor({store, lookup, assertOwned}) {
        /**
         *
         */
        this._store = store;
        /**
         *
         */
        this._lookup = lookup;
        /**
         *
         */
        this._assertOwned = assertOwned;
    }

    /**
     * @param {Job} job
     * @param {string} fileId
     * @param {Uint8Array} bytes
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     */
    async write(job, fileId, bytes, signal) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
            throw new RangeError('Optimization artifact exceeds its byte bound');
        }
        const owned = new Uint8Array(bytes);
        const expected = this._check(job, fileId, signal);
        const observation = await this._store.observe(fileId);
        this._check(job, fileId, signal);
        if (expected.state === 'active') { throw new Error('Published optimization artifacts are read-only'); }
        if (expected.state === 'staged' && (observation === null || observation !== expected.byteLength || observation !== owned.byteLength)) {
            throw new Error('Sealed optimization artifact observation changed');
        }
        if (observation !== null && observation > 0) {
            let same = false;
            if (observation === owned.byteLength) {
                const stored = await this._store.readSlice(fileId, observation, 0, observation);
                this._check(job, fileId, signal);
                same = stored.every((value, index) => value === owned[index]);
            }
            if (same) { return; }
            if (expected.state !== 'intent') { throw new Error('Sealed optimization artifact bytes conflict'); }
            // This path can only name a durable unpublished intent. The single
            // controller step joins its writer before another attempt starts.
            await this._store.remove(fileId);
            this._check(job, fileId, signal);
        }
        if (expected.state !== 'intent') { throw new Error('Optimization artifact is not an unpublished intent'); }
        await this._store.write(fileId, [owned], {expectedByteLength: owned.byteLength, signal});
        this._check(job, fileId, signal);
    }

    /**
     * @param {Job} job
     * @param {string} fileId
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    async read(job, fileId, signal) {
        const expected = this._check(job, fileId, signal);
        const observed = await this._store.observe(fileId);
        this._check(job, fileId, signal);
        if (observed === null || observed <= 0 || observed > MAX_ARTIFACT_BYTES ||
        (expected.state !== 'intent' && observed !== expected.byteLength)) {
            throw new Error('Optimization artifact is missing or exceeds its observation');
        }
        const bytes = await this._store.readSlice(fileId, observed, 0, observed);
        this._check(job, fileId, signal);
        return bytes;
    }

    /**
     * @param {Job} job
     * @param {string} fileId
     * @param {AbortSignal} signal
     * @returns {ArtifactObservation}
     * @throws {Error} If admission or durable ownership changed.
     */
    _check(job, fileId, signal) {
        if (signal.aborted) { throw new DOMException('Optimization artifact I/O preempted', 'AbortError'); }
        this._assertOwned(job);
        const file = this._lookup(job, fileId);
        if (!file || file.fileId !== fileId || file.ownerJobId !== job.jobId ||
        (file.state !== 'intent' && file.state !== 'staged' && file.state !== 'active') || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 ||
        file.byteLength > MAX_ARTIFACT_BYTES || (file.state === 'intent' && (file.byteLength !== 0 || file.sha256 !== null)) ||
        (file.state !== 'intent' && (file.byteLength === 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)))) {
            throw new Error('Optimization artifact durable ownership is missing or inconsistent');
        }
        return file;
    }
}
