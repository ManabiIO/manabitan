/* SPDX-License-Identifier: GPL-3.0-or-later */
// Test boundary only: browser fetch(file assets) is mapped to the same local bytes.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export function installFileFetch() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith('file:')) { return await originalFetch(input, options); }
        try {
            const bytes = await readFile(fileURLToPath(url));
            return new Response(bytes, {status: 200, headers: {'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'}});
        } catch (error) {
            if (error.code === 'ENOENT') { return new Response('', {status: 404}); }
            throw error;
        }
    };
}
