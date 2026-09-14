from pathlib import Path

path = Path('ext/js/background/offscreen.js')
text = path.read_text()
old = '''    /** @type {import('offscreen').McApiHandler<'importDictionaryOffscreen'>} */
    async _importDictionaryOffscreenHandler({archiveContent, details}, ports) {
        if (ports.length === 0) {
            throw new Error('Offscreen import response port missing');
        }
        try {
            await this._invokeDictionaryWorker('importDictionaryOffscreen', {archiveContent, details}, [ports[0]]);
        } catch (error) {
            ports[0].postMessage({type: 'error', error: ExtensionError.serialize(error)});
            ports[0].close();
        }
    }
'''
new = '''    /** @type {import('offscreen').McApiHandler<'importDictionaryOffscreen'>} */
    async _importDictionaryOffscreenHandler({archiveContent, details}, ports) {
        if (ports.length === 0) {
            throw new Error('Offscreen import response port missing');
        }
        const responsePort = ports[0];
        const workerChannel = new MessageChannel();
        let settled = false;
        const closePorts = () => {
            try { workerChannel.port1.close(); } catch (_) { /* NOP */ }
            try { workerChannel.port2.close(); } catch (_) { /* NOP */ }
            try { responsePort.close(); } catch (_) { /* NOP */ }
        };
        /**
         * @param {unknown} message
         * @param {boolean} terminal
         */
        const postResponse = (message, terminal) => {
            if (settled) { return; }
            try {
                responsePort.postMessage(message);
            } catch (_) {
                settled = true;
                closePorts();
                return;
            }
            if (terminal) {
                settled = true;
                closePorts();
            }
        };
        workerChannel.port1.onmessage = (event) => {
            /** @type {unknown} */
            const message = event.data;
            /** @type {unknown} */
            let type = null;
            if (
                typeof message === 'object' &&
                message !== null &&
                !Array.isArray(message)
            ) {
                type = Reflect.get(message, 'type');
            }
            postResponse(message, type === 'complete' || type === 'error');
        };
        workerChannel.port1.onmessageerror = () => {
            postResponse({
                type: 'error',
                error: ExtensionError.serialize(new Error('Dictionary worker import response channel failed')),
            }, true);
        };
        try {
            await this._invokeDictionaryWorker(
                'importDictionaryOffscreen',
                {archiveContent, details},
                [workerChannel.port2],
            );
        } catch (error) {
            postResponse({type: 'error', error: ExtensionError.serialize(error)}, true);
        }
    }
'''
if text.count(old) != 1:
    raise SystemExit(f'expected one import handler body, got {text.count(old)}')
text = text.replace(old, new, 1)

old_debug = '''    async _debugDictionaryStorageStateHandler() {
        return await this._invokeDictionaryWorker('debugDictionaryStorageStateOffscreen', {});
    }
'''
new_debug = '''    /**
     * @returns {Promise<unknown>}
     */
    async _debugDictionaryStorageStateHandler() {
        return await this._invokeDictionaryWorker('debugDictionaryStorageStateOffscreen', {});
    }
'''
if text.count(old_debug) != 1:
    raise SystemExit(f'expected one debug storage handler body, got {text.count(old_debug)}')
path.write_text(text.replace(old_debug, new_debug, 1))
