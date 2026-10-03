/*
 * Copyright (C) 2026  Yomitan Authors
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

import {initWasm, Resvg} from '../../lib/resvg-wasm.js';

/**
 * @typedef {object} SvgRender
 * @property {Uint8Array} pixels
 * @property {number} width
 * @property {number} height
 * @property {() => void} free
 */

/**
 * @typedef {object} SvgRenderer
 * @property {() => SvgRender} render
 * @property {() => void} free
 */

/**
 * @typedef {object} RendererDependencies
 * @property {typeof fetch} [fetch]
 * @property {typeof initWasm} [initWasm]
 * @property {new (content: Uint8Array|string, options: import('@resvg/resvg-wasm').ResvgRenderOptions) => SvgRenderer} [Resvg]
 */

export class DictionaryMediaRenderer {
    /** @param {RendererDependencies} [dependencies] */
    constructor({fetch: fetchResource = globalThis.fetch.bind(globalThis), initWasm: initializeWasm = initWasm, Resvg: ResvgConstructor = Resvg} = {}) {
        /** @type {typeof fetch} */
        this._fetch = fetchResource;
        /** @type {typeof initWasm} */
        this._initWasm = initializeWasm;
        /** @type {NonNullable<RendererDependencies['Resvg']>} */
        this._Resvg = ResvgConstructor;
        /** @type {boolean} */
        this._wasmInitialized = false;
        /** @type {Uint8Array|null} */
        this._fontBuffer = null;
        /** @type {Promise<void>|null} */
        this._preparePromise = null;
    }

    /** @returns {Promise<void>} */
    ensurePrepared() {
        if (this._preparePromise === null) {
            this._preparePromise = this._prepare().catch((error) => {
                this._preparePromise = null;
                throw error;
            });
        }
        return this._preparePromise;
    }

    /**
     * @param {ArrayBuffer|Uint8Array|string} content
     * @param {number} width
     * @returns {Promise<{pixels: Uint8Array, width: number, height: number}>}
     */
    async renderSvg(content, width) {
        await this.ensurePrepared();
        const renderer = new this._Resvg(typeof content === 'string' ? content : new Uint8Array(content), {
            fitTo: {mode: 'width', value: width},
            font: {fontBuffers: this._fontBuffer === null ? [] : [this._fontBuffer]},
        });
        try {
            const render = renderer.render();
            try {
                // Own the bytes before either native handle is released or the buffer is transferred.
                return {pixels: new Uint8Array(render.pixels), width: render.width, height: render.height};
            } finally {
                render.free();
            }
        } finally {
            renderer.free();
        }
    }

    /** @returns {Promise<void>} */
    async _prepare() {
        if (!this._wasmInitialized) {
            const response = await this._fetchResource(new URL('../../lib/resvg.wasm', import.meta.url));
            try {
                await this._initWasm(response);
            } catch (error) {
                // The shipped wrapper rejects repeat initialization after another owner prepared it.
                if (!(error instanceof Error) || error.message !== 'Already initialized. The `initWasm()` function can be used only once.') {
                    throw error;
                }
            }
            this._wasmInitialized = true;
        }
        const response = await this._fetchResource(new URL('../../fonts/NotoSansJP-Regular.ttf', import.meta.url));
        const buffer = await response.arrayBuffer();
        this._fontBuffer = new Uint8Array(buffer);
    }

    /**
     * @param {URL} url
     * @returns {Promise<Response>}
     */
    async _fetchResource(url) {
        const response = await this._fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch SVG rendering resource ${url}: HTTP ${response.status}`);
        }
        return response;
    }
}
