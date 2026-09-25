import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderLookupBridge} from '../../ext/js/app/reader-lookup-bridge.js';

function fixture(t, options = {}) {
  // Unit-test the callbacks, not browser trust. Real trusted-input coverage is
  // in the Chromium DOM suite; no trust bypass is exposed by production code.
  const OldElement = globalThis.Element;
  class FakeElement {
    constructor() { this.isConnected = true; this.nodeType = 1; this.tagName = 'SPAN'; this.childNodes = [{nodeType: 3, nodeValue: '猫', childNodes: []}]; }
    getAttribute() { return 'original'; }
  }
  globalThis.Element = FakeElement;
  t.after(() => { if (OldElement) globalThis.Element = OldElement; else delete globalThis.Element; });
  const anchor = new FakeElement(), calls = [], reports = [];
  const document = {addEventListener() {}, removeEventListener() {}, getSelection: () => null};
  let bridge;
  bridge = new ReaderLookupBridge({document, enabled: () => true,
    invalidateSearch: () => { calls.push('clear'); bridge.invalidate(); options.clear?.(); },
    show: async (_request, _anchor, isCurrent) => { calls.push(isCurrent() ? 'shown' : 'stale'); },
    report: status => reports.push(status)});
  if (options.show) bridge._show = options.show;
  bridge._target = () => ({anchor, request: {surface: '猫'}, context: null, contextRaw: null});
  t.after(() => bridge.dispose());
  const activate = () => bridge._click({target: anchor, isTrusted: true, button: 0, detail: 0, preventDefault() {}, stopImmediatePropagation() {}});
  return {bridge, anchor, calls, reports, activate};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('selection-clear callbacks cannot invalidate their successor lookup', async t => {
  const f = fixture(t); f.activate(); await settle();
  assert.deepEqual(f.calls, ['clear', 'shown']);
});
test('a detached anchor after clearing never publishes', async t => {
  const f = fixture(t); f.bridge._invalidateSearch = () => { f.anchor.isConnected = false; };
  f.activate(); await settle(); assert.deepEqual(f.calls, []);
});
test('synchronous display errors are reported without unhandled rejection', async t => {
  const f = fixture(t, {show: () => { throw new Error('display failed'); }});
  assert.doesNotThrow(f.activate); await settle(); assert.deepEqual(f.reports, ['lookup-failed']);
});
test('dispose before the scheduled display prevents it', async t => {
  const f = fixture(t); f.activate(); f.bridge.dispose(); await settle();
  assert.deepEqual(f.calls, ['clear']);
});
