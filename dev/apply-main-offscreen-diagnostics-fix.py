from pathlib import Path

path = Path('ext/js/background/offscreen-proxy.js')
text = path.read_text()

old = "import {ExtensionError} from '../core/extension-error.js';\nimport {log} from '../core/log.js';\n"
new = "import {ExtensionError} from '../core/extension-error.js';\nimport {reportDiagnostics} from '../core/diagnostics-reporter.js';\nimport {log} from '../core/log.js';\n"
if text.count(old) != 1:
    raise SystemExit('expected one offscreen-proxy import insertion point')
text = text.replace(old, new, 1)

old = """        const id = typeof event.data?.id === 'number' ? event.data.id : null;
        if (id === null) { return; }
        const handler = this._responseHandlers.get(id);
        if (typeof handler === 'undefined') { return; }
"""
new = """        const id = typeof event.data?.id === 'number' ? event.data.id : null;
        if (id === null) {
            reportDiagnostics('offscreen-proxy-unmatched-response', {
                reason: 'missing-id',
                id: null,
                hasError: typeof event.data?.error !== 'undefined',
            });
            return;
        }
        const handler = this._responseHandlers.get(id);
        if (typeof handler === 'undefined') {
            reportDiagnostics('offscreen-proxy-unmatched-response', {
                reason: 'unknown-id',
                id,
                hasError: typeof event.data?.error !== 'undefined',
            });
            return;
        }
"""
if text.count(old) != 1:
    raise SystemExit('expected one DictionaryRuntimeWorkerProxy response-handler insertion point')
text = text.replace(old, new, 1)
path.write_text(text)
