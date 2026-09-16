from pathlib import Path
p = Path('dev/lib/zstd-wasm.js')
s = p.read_text()
a = s.index('/**\n * @param {string} [path=')
b = s.index('/**\n * @returns {import(', a)
s = s[:a] + '''/** @type {WebAssembly.Module|null} */
let compiledZstdModule = null;

/**
 * @param {string} [path]
 * @param {WebAssembly.Module|null} [precompiled]
 * @returns {Promise<void>}
 */
export async function init(path = '/lib/zstd.wasm', precompiled = null) {
    if (moduleInstance !== null) { return; }
    if (initialization !== null) { return await initialization; }
    initialization = (async () => {
        let compiled = precompiled;
        if (compiled === null) {
            const response = await fetch(path, {credentials: 'same-origin'});
            if (!response.ok) { throw new Error(`Failed to fetch Zstd WASM: ${response.status}`); }
            try {
                compiled = await WebAssembly.compileStreaming(response.clone());
            } catch (_) {
                compiled = await WebAssembly.compile(await response.arrayBuffer());
            }
        }
        if (!(compiled instanceof WebAssembly.Module)) { throw new TypeError('Invalid compiled Zstd module'); }
        const wasm = compiled;
        moduleInstance = await createZstdModule({
            instantiateWasm(imports, ready) {
                const instance = new WebAssembly.Instance(wasm, imports);
                ready(instance, wasm);
                return instance.exports;
            },
        });
        compiledZstdModule = wasm;
    })();
    try {
        await initialization;
    } catch (error) {
        initialization = null;
        compiledZstdModule = null;
        throw error;
    }
}

/** @returns {WebAssembly.Module} */
export function getCompiledZstdModule() {
    if (compiledZstdModule === null) { throw new Error('Zstd WASM is not initialized'); }
    return compiledZstdModule;
}

''' + s[b:]
p.write_text(s)
p = Path('dev/lib/zstd-simd-module.d.ts')
s = p.read_text().replace('wasmBinary?: Uint8Array}', 'wasmBinary?: Uint8Array, instantiateWasm?(imports: WebAssembly.Imports, ready: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): WebAssembly.Exports}')
p.write_text(s)
p = Path('ext/js/dictionary/zstd-term-content.js')
s = p.read_text().replace('    freeDCtx,\n', '    freeDCtx,\n    getCompiledZstdModule,\n')
s = s.replace(' * @returns {Promise<void>}\n */\nexport async function initializeTermContentZstd() {', ' * @param {{module: WebAssembly.Module, dictionary: Uint8Array}} [assets]\n * @returns {Promise<void>}\n */\nexport async function initializeTermContentZstd(assets) {')
s = s.replace("        await init('/lib/zstd.wasm');\n        const response = await fetch('/lib/zstd-dicts/jmdict.zdict');\n        if (!response.ok) {\n            throw new Error(`Failed to load zstd dictionary: ${response.status}`);\n        }\n        const loadedJmdictDict = new Uint8Array(await response.arrayBuffer());", '''        await init('/lib/zstd.wasm', assets?.module ?? null);
        let loadedJmdictDict;
        if (assets) {
            if (!(assets.dictionary instanceof Uint8Array)) { throw new TypeError('Invalid Zstd dictionary bytes'); }
            loadedJmdictDict = Uint8Array.from(assets.dictionary);
        } else {
            const response = await fetch('/lib/zstd-dicts/jmdict.zdict');
            if (!response.ok) { throw new Error(`Failed to load zstd dictionary: ${response.status}`); }
            loadedJmdictDict = new Uint8Array(await response.arrayBuffer());
        }''')
s = s.replace('                readyPromises.push(waitForCompressionWorkerReady(worker));', '''                const ready = waitForCompressionWorkerReady(worker);
                void ready.catch(() => {});
                readyPromises.push(ready);
                worker.postMessage({type: 'initialize', module: getCompiledZstdModule(), dictionary: jmdictDict});''')
p.write_text(s)
p = Path('ext/js/dictionary/zstd-term-content-compression-worker.js')
s = p.read_text()
a = s.index('const initialization = ')
b = s.index('/** @param {MessageEvent}', a)
s = s[:a] + '''/** @type {Promise<void>|null} */
let initialization = null;
self.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.type === 'initialize') {
        if (initialization !== null) { return; }
        initialization = modulePromise.then(async ({initializeTermContentZstd}) => {
            if (!(data.module instanceof WebAssembly.Module) || !(data.dictionary instanceof Uint8Array)) {
                throw new TypeError('Invalid compression worker initialization');
            }
            await initializeTermContentZstd({module: data.module, dictionary: data.dictionary});
        });
        void initialization.then(
            () => { self.postMessage({type: 'ready'}); },
            (error) => { self.postMessage({type: 'initialization-error', error: `${error}`}); },
        );
        return;
    }
    void compressContent(event);
});

''' + s[b:]
s = s.replace('        await initialization;', "        if (initialization === null) { throw new Error('Compression worker not initialized'); }\n        await initialization;")
p.write_text(s)
