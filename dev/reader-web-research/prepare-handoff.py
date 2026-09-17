from pathlib import Path
import sys
p = Path(sys.argv[1])
header = (p / 'ext/js/display/display-generator.js').read_text().split('import ')[0]
f = p / 'test/text-scanner.test.js'
s = f.read_text(); index = s.rfind('\n});'); assert index > 0
s = s[:index] + '''
    test('page handoff cancels a manual lookup without publishing its late result', async () => {
        /** @type {(value: TermsFindResult) => void} */
        let release = () => {};
        /** @type {Promise<TermsFindResult>} */
        const pending = new Promise((resolve) => { release = resolve; });
        const find = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({
            dictionaryEntries: [createMockTermEntry()], originalTextLength: 2,
        });
        const scanner = createScanner(find, []);
        const success = vi.fn();
        scanner.on('searchSuccess', success);
        const oldSearch = scanner.search(createFakeTextSource('暗記'));
        await vi.waitFor(() => { expect(find).toHaveBeenCalledOnce(); });
        // The old fallback removes listeners but does not fence explicit searches.
        const cancel = Reflect.get(scanner, 'cancelPending');
        if (typeof cancel === 'function') { cancel.call(scanner); } else { scanner.setEnabled(false); }
        release({dictionaryEntries: [createMockTermEntry()], originalTextLength: 2});
        await oldSearch;
        expect(success).not.toHaveBeenCalled();
        expect(scanner.getCurrentTextSource()).toBeNull();
        await scanner.search(createFakeTextSource('暗記'));
        expect(success).toHaveBeenCalledOnce();
        scanner.setEnabled(false);
    });

    test('page handoff discards the old queued pointer lookup', async () => {
        /** @type {(value: TermsFindResult) => void} */
        let release = () => {};
        /** @type {Promise<TermsFindResult>} */
        const pending = new Promise((resolve) => { release = resolve; });
        const find = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({dictionaryEntries: [], originalTextLength: 0});
        const scanner = createScanner(find, [createFakeTextSource('暗記')]);
        const active = searchAt(scanner, 10, 10, createInputInfo());
        await vi.waitFor(() => { expect(find).toHaveBeenCalledOnce(); });
        await searchAt(scanner, 20, 20, createInputInfo());
        const cancel = Reflect.get(scanner, 'cancelPending');
        if (typeof cancel === 'function') { cancel.call(scanner); } else { scanner.setEnabled(false); }
        release({dictionaryEntries: [], originalTextLength: 0});
        await active;
        expect(find).toHaveBeenCalledOnce();
        expect(scanner.getCurrentTextSource()).toBeNull();
        scanner.setEnabled(false);
    });
''' + s[index:]
f.write_text(s)
if '--tests-only' in sys.argv: raise SystemExit(0)

f = p / 'ext/js/language/text-scanner.js'; s = f.read_text()
s = s.replace('this._lookupSequence = 0;', 'this._lookupSequence = 0;\n        /** @type {object} */\n        this._cancellationToken = {};', 1)
marker = "    /**\n     * @param {import('text-scanner').Options} options\n     */\n    setOptions"
assert marker in s
s = s.replace(marker, '''    /**
     * Invalidate in-flight and queued work without changing the user's options.
     * Unlike setEnabled(false), this also fences explicit/manual lookups.
     */
    cancelPending() {
        this._cancellationToken = {};
        this._activeLookupSequence = null;
        this._queuedLookup = null;
        this._queuedMouseMoveLookup = null;
        this._scanTimerClear();
        if (this._mouseMoveLookupTimer !== null) {
            clearTimeout(this._mouseMoveLookupTimer);
            this._mouseMoveLookupTimer = null;
        }
        this.clearMousePosition();
        this.clearSelection();
    }

''' + marker, 1)
start = s.index('    async _search(textSource,'); end = s.index('\n    /**', start + 1)
part = s[start:end].replace('        const searchStartedAt', '        const cancellationToken = this._cancellationToken;\n        const searchStartedAt', 1)
part = part.replace('if (this._isLookupStale(lookupSequence))', 'if (cancellationToken !== this._cancellationToken || this._isLookupStale(lookupSequence))')
s = s[:start] + part + s[end:]; f.write_text(s)

f = p / 'ext/js/app/frontend.js'; s = f.read_text()
s = s.replace('this._disabledOverride = false;', '''this._disabledOverride = false;
        /** @type {boolean} */
        this._pageScanningSuspended = false;
        /** @type {Set<Promise<void>>} */
        this._pendingPageShows = new Set();''', 1)
marker = '    /**\n     * Set or clear an override options context object.'; assert marker in s
s = s.replace(marker, '''    /**
     * Pause only this page while a cooperating Reader owns scanning. Never
     * changes extension preferences. Resolve only after old displays have drained.
     * @param {boolean} suspended
     * @returns {Promise<void>}
     */
    async setPageScanningSuspended(suspended) {
        this._pageScanningSuspended = suspended;
        this._updateTextScannerEnabled();
        if (!suspended) { return; }
        this._textScanner.cancelPending();
        this._clearSelection(true);
        await Promise.allSettled([...this._pendingPageShows]);
        if (!this._pageScanningSuspended) { return; }
        this._clearSelection(true);
        if (this._popup !== null) { await this._popup.hide(false); }
    }

''' + marker, 1)
for before, after in [
    ('    async setTextSource(textSource) {', '    async setTextSource(textSource) {\n        if (this._pageScanningSuspended === true) { return; }'),
    ('        this._debugSearchSuccessCount += 1;', '        if (this._pageScanningSuspended === true) { return; }\n        this._debugSearchSuccessCount += 1;'),
    ('    _onSearchError({error, textSource, inputInfo: {passive}}) {', '    _onSearchError({error, textSource, inputInfo: {passive}}) {\n        if (this._pageScanningSuspended === true) { return; }'),
    ('    _showPopupContent(textSource, optionsContext, details, searchSuccessAt = safePerformance.now()) {', '    _showPopupContent(textSource, optionsContext, details, searchSuccessAt = safePerformance.now()) {\n        if (this._pageScanningSuspended === true) { return Promise.resolve(); }'),
    ('        void this._lastShowPromise.then(', '''        const pendingPageShows = this._pendingPageShows;
        const showPromise = this._lastShowPromise;
        pendingPageShows?.add(showPromise);
        const settled = () => { pendingPageShows?.delete(showPromise); };
        void showPromise.then(settled, settled);
        void this._lastShowPromise.then('''),
    ('&& !this._disabledOverride);', '&& !this._disabledOverride && this._pageScanningSuspended !== true);'),
    ('    async _scanSelectedText(allowEmptyRange, disallowExpandSelection, showEmpty = false) {', '    async _scanSelectedText(allowEmptyRange, disallowExpandSelection, showEmpty = false) {\n        if (this._pageScanningSuspended === true) { return false; }'),
]:
    assert s.count(before) == 1, before
    s = s.replace(before, after, 1)
f.write_text(s)

(p / 'ext/js/app/reader-mode-bridge.js').write_text(header + '''/**
 * Narrow document-local cooperation. A page may suspend its own scanner; it
 * cannot enable a disabled profile or read/invoke extension settings/storage.
 * DOM attributes are hints, not authenticated installation detection or an
 * authorization boundary. No privileged API is exposed to webpage scripts.
 */
export class ReaderModeBridge {
    /**
     * @param {import('./frontend.js').Frontend} frontend
     * @param {Document} document
     */
    constructor(frontend, document) {
        this._frontend = frontend;
        this._root = document.documentElement;
        this._generation = 0;
        /** @type {MutationObserver|null} */
        this._observer = null;
    }

    /** @returns {Promise<void>} */
    async prepare() {
        const root = this._root;
        if (root === null || this._observer !== null) { return; }
        this._observer = new MutationObserver(() => { void this._apply(); });
        this._observer.observe(root, {attributes: true, attributeFilter: [
            'data-manabi-reader', 'data-manabi-dictionary-mode', 'data-manabi-dictionary-request',
        ]});
        await this._apply();
    }

    /** @returns {Promise<void>} */
    async dispose() {
        ++this._generation;
        this._observer?.disconnect();
        this._observer = null;
        this._root?.removeAttribute('data-manabitan-reader-protocol');
        this._root?.removeAttribute('data-manabitan-reader-ack');
        await this._frontend.setPageScanningSuspended(false);
    }

    /** @returns {Promise<void>} */
    async _apply() {
        const root = this._root;
        if (root === null) { return; }
        const generation = ++this._generation;
        const mode = root.getAttribute('data-manabi-dictionary-mode');
        const request = root.getAttribute('data-manabi-dictionary-request') ?? '';
        const valid = root.getAttribute('data-manabi-reader') === '1' &&
            (mode === 'builtin' || mode === 'extension' || mode === 'off') &&
            /^[a-zA-Z0-9-]{1,64}$/.test(request);
        root.removeAttribute('data-manabitan-reader-ack');
        if (valid) {
            root.setAttribute('data-manabitan-reader-protocol', '1');
        } else {
            root.removeAttribute('data-manabitan-reader-protocol');
        }
        try {
            await this._frontend.setPageScanningSuspended(valid && mode !== 'extension');
            if (generation !== this._generation || !valid || this._observer === null) { return; }
            root.setAttribute('data-manabitan-reader-ack', `${request}:${mode}`);
        } catch (_) {
            // Never acknowledge an incomplete handoff. The Reader must not start
            // a second scanner when a known cooperating extension failed to yield.
        }
    }
}
''')
f = p / 'ext/js/app/content-script-main.js'; s = f.read_text()
s = s.replace("import {PopupFactory} from './popup-factory.js';", "import {PopupFactory} from './popup-factory.js';\nimport {ReaderModeBridge} from './reader-mode-bridge.js';")
s = s.replace('    await frontend.prepare();', '    const readerModeBridge = new ReaderModeBridge(frontend, document);\n    await readerModeBridge.prepare();\n    await frontend.prepare();')
f.write_text(s)

(p / 'test/reader-mode-bridge.test.js').write_text(header + '''import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {ReaderModeBridge} from '../ext/js/app/reader-mode-bridge.js';
import {setupDomTest} from './fixtures/dom-test.js';

const environment = await setupDomTest();
afterAll(async () => { await environment.teardown(global); });
afterEach(() => {
    for (const name of [...document.documentElement.attributes].map(({name}) => name)) {
        document.documentElement.removeAttribute(name);
    }
});

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    let resolve = () => {};
    /** @type {Promise<void>} */
    const promise = new Promise((r) => { resolve = r; });
    return {promise, resolve};
}

/** @param {boolean} enabled */
function makeFrontend(enabled = true) {
    const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
    let scannerEnabled = enabled;
    const scanner = {
        isEnabled: () => scannerEnabled,
        setEnabled: vi.fn(/** @param {boolean} value */ (value) => { scannerEnabled = value; }),
        cancelPending: vi.fn(),
    };
    const popup = {hide: vi.fn().mockResolvedValue(void 0), showContent: vi.fn().mockResolvedValue(void 0)};
    Object.assign(frontend, {
        _options: {general: {enable: enabled}}, _disabledOverride: false,
        _pageScanningSuspended: false, _pendingPageShows: new Set(),
        _textScanner: scanner, _popup: popup, _textScannerHasBeenEnabled: true,
        _clearSelection: vi.fn(), _updatePageDebugState: vi.fn(), _startPopupPrewarmForHover: vi.fn(),
        _application: {webExtension: {unloaded: false}},
    });
    return {frontend, scanner, popup};
}

/**
 * @param {string} mode
 * @param {string} request
 */
function requestMode(mode, request) {
    const root = document.documentElement;
    root.setAttribute('data-manabi-reader', '1');
    root.setAttribute('data-manabi-dictionary-mode', mode);
    root.setAttribute('data-manabi-dictionary-request', request);
}

describe('document-local Reader handoff', () => {
    test('waits for every old display, including one older than lastShowPromise', async () => {
        const {frontend, popup} = makeFrontend();
        const first = deferred();
        const second = deferred();
        popup.showContent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const source = {getRects: () => [], getWritingMode: () => 'horizontal-tb'};
        const show = Reflect.get(Frontend.prototype, '_showPopupContent');
        const p1 = show.call(frontend, source, null, null);
        const p2 = show.call(frontend, source, null, null);
        const ack = vi.fn();
        const suspension = frontend.setPageScanningSuspended(true).then(ack);
        second.resolve();
        await p2;
        await Promise.resolve();
        expect(ack).not.toHaveBeenCalled();
        first.resolve();
        await p1;
        await suspension;
        expect(ack).toHaveBeenCalledOnce();
        expect(popup.hide).toHaveBeenCalledWith(false);
        await show.call(frontend, source, null, null);
        expect(popup.showContent).toHaveBeenCalledTimes(2);
        await expect(Reflect.get(Frontend.prototype, '_scanSelectedText').call(frontend, false, true)).resolves.toBe(false);
    });

    test('preserves a user-disabled extension when handing back ownership', async () => {
        const {frontend, scanner} = makeFrontend(false);
        await frontend.setPageScanningSuspended(true);
        await frontend.setPageScanningSuspended(false);
        expect(scanner.isEnabled()).toBe(false);
        expect(Reflect.get(frontend, '_options').general.enable).toBe(false);
    });

    test('acknowledges only the latest request when suspension settles late', async () => {
        const old = deferred();
        const suspend = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(void 0);
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ ({setPageScanningSuspended: suspend}));
        requestMode('builtin', 'one');
        const bridge = new ReaderModeBridge(frontend, document);
        const preparing = bridge.prepare();
        requestMode('extension', 'two');
        await vi.waitFor(() => { expect(document.documentElement.getAttribute('data-manabitan-reader-ack')).toBe('two:extension'); });
        old.resolve();
        await preparing;
        expect(document.documentElement.getAttribute('data-manabitan-reader-ack')).toBe('two:extension');
        await bridge.dispose();
    });

    test.each(['builtin', 'off'])('suspends %s before acknowledging', async (mode) => {
        const pending = deferred();
        const suspend = vi.fn().mockReturnValue(pending.promise);
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ ({setPageScanningSuspended: suspend}));
        requestMode(mode, 'request');
        const bridge = new ReaderModeBridge(frontend, document);
        const preparing = bridge.prepare();
        expect(suspend).toHaveBeenCalledWith(true);
        expect(document.documentElement.getAttribute('data-manabitan-reader-ack')).toBeNull();
        pending.resolve();
        await preparing;
        expect(document.documentElement.getAttribute('data-manabitan-reader-ack')).toBe(`request:${mode}`);
        await bridge.dispose();
    });

    test('invalid protocol data cannot acknowledge or keep the page suspended', async () => {
        const suspend = vi.fn().mockResolvedValue(void 0);
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ ({setPageScanningSuspended: suspend}));
        requestMode('builtin', 'invalid:request');
        const bridge = new ReaderModeBridge(frontend, document);
        await bridge.prepare();
        expect(suspend).toHaveBeenLastCalledWith(false);
        expect(document.documentElement.getAttribute('data-manabitan-reader-ack')).toBeNull();
        expect(document.documentElement.getAttribute('data-manabitan-reader-protocol')).toBeNull();
        await bridge.dispose();
    });
});
''')
