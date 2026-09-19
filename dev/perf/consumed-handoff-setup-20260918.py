from pathlib import Path
import importlib.util

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('retention', HERE / 'retention-setup-20260918.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)

OLD = '''                /** @type {(() => void)|null} */
                let consume = null;
                /** @type {Promise<void>|null} */
                let consumed = null;
                if (result.borrowsWorkerMemory) {
                    /** @type {(value?: void|PromiseLike<void>) => void} */
                    let resolveConsumed = () => {};
                    consumed = new Promise((resolve) => { resolveConsumed = resolve; });
                    let pending = true;
                    const consumeResult = () => {
                        if (!pending) { return; }
                        pending = false;
                        this._pendingResultConsumers.delete(consumeResult);
                        resolveConsumed();
                    };
                    consume = consumeResult;
                    this._pendingResultConsumers.add(consume);
                    if (this._failed) { consumeResult(); }
                }
                this._resultSlots[groupIndex].resolve({...result, sourceBytes, consume});
                if (consumed !== null) { await consumed; }'''
NEW = '''                // Owned payloads need the same consumption boundary as borrowed
                // WASM views. Otherwise workers can retain a full lead window of
                // independently allocated chunks while the ordered sink catches up.
                /** @type {(value?: void|PromiseLike<void>) => void} */
                let resolveConsumed = () => {};
                const consumed = new Promise((resolve) => { resolveConsumed = resolve; });
                let pending = true;
                const consume = () => {
                    if (!pending) { return; }
                    pending = false;
                    this._pendingResultConsumers.delete(consume);
                    resolveConsumed();
                };
                this._pendingResultConsumers.add(consume);
                if (this._failed) { consume(); }
                this._resultSlots[groupIndex].resolve({...result, sourceBytes, consume});
                await consumed;'''


def prepare():
    path = retention.prepare()
    text = path.read_text().replace('owned-release', 'owned-consumed')
    text = text.replace("default='release-only,owned-consumed'", "default='owned-consumed'")
    assert text.count('    (ROOT / PARSER).write_text(parser)') == 1
    text = text.replace('    (ROOT / PARSER).write_text(parser)',
        "    if variant == 'owned-consumed':\n        assert parser.count(CONSUMED_OLD) == 1\n        parser = parser.replace(CONSUMED_OLD, CONSUMED_NEW)\n    (ROOT / PARSER).write_text(parser)")
    text = text.replace('def configure(variant):', 'CONSUMED_OLD = ' + repr(OLD) + '\nCONSUMED_NEW = ' + repr(NEW) + '\n\ndef configure(variant):')
    target = path.with_name('consumed-handoff-driver-20260918.py')
    target.write_text(text)
    memory = (HERE / 'owned-memory-20260918.py').read_text()
    assert memory.count("'owned-handoff-20260918.py'") == 1
    memory = memory.replace("'owned-handoff-20260918.py'", "'consumed-handoff-driver-20260918.py'")
    (HERE / 'consumed-handoff-memory-20260918.py').write_text(memory)
    return target


if __name__ == '__main__':
    print(prepare())
