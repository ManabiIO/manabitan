from pathlib import Path

path = Path('ext/js/background/offscreen.js')
text = path.read_text()
old = '''    /** @type {import('offscreen').McApiHandler<'importDictionaryOffscreen'>} */
    _importDictionaryOffscreenHandler({archiveContent, details}, ports) {
        if (ports.length === 0) {
            throw new Error('Offscreen import response port missing');
        }
        void this._invokeDictionaryWorker('importDictionaryOffscreen', {archiveContent, details}, [ports[0]])
            .catch((error) => {
                try {
                    ports[0].postMessage({type: 'error', error: ExtensionError.serialize(error)});
                } catch (_) {
                    // Best effort error delivery to the import caller.
                } finally {
                    try {
                        ports[0].close();
                    } catch (_) {
                        // Ignore close failures for dead import response ports.
                    }
                }
            });
    }
'''
new = '''    /** @type {import('offscreen').McApiHandler<'importDictionaryOffscreen'>} */
    _importDictionaryOffscreenHandler({archiveContent, details}, ports) {
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
        void this._invokeDictionaryWorker(
            'importDictionaryOffscreen',
            {archiveContent, details},
            [workerChannel.port2],
        ).catch((error) => {
            postResponse({type: 'error', error: ExtensionError.serialize(error)}, true);
        });
    }
'''
if text.count(old) != 1:
    raise SystemExit(f'expected one develop import handler body, got {text.count(old)}')
path.write_text(text.replace(old, new, 1))
