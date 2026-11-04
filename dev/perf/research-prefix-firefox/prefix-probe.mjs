export function armPrefixGuardProbe() {
    const sequenceBefore = Number(globalThis.__manabitanImportCompletionSequence || 0);
    const handler = (event) => {
        const completion = event.detail;
        if (!completion || completion.importRunCurrent !== true || completion.sequence <= sequenceBefore) { return; }
        globalThis.removeEventListener('manabitan:dictionary-import-complete', handler);
        const send = (params) => new Promise((resolve, reject) => {
            globalThis.chrome.runtime.sendMessage({action: 'termsFind', params}, (response) => {
                const error = globalThis.chrome.runtime.lastError;
                if (error) { reject(new Error(error.message)); return; }
                if (response && Object.hasOwn(response, 'error')) { reject(new Error(JSON.stringify(response.error))); return; }
                resolve(response && typeof response === 'object' ? response.result : response);
            });
        });
        const promise = (async () => {
            const samples = [], oracles = {};
            for (const mode of ['exact', 'prefix', 'suffix']) {
                for (let repeat = 0; repeat < 4; ++repeat) {
                    const startedAtMs = globalThis.performance.now();
                    const result = await send({text: '日本', details: {primaryReading: '', matchType: mode, deinflect: false}, optionsContext: {index: 0}});
                    const elapsedMs = globalThis.performance.now() - startedAtMs;
                    if (!Array.isArray(result?.dictionaryEntries) || result.dictionaryEntries.length === 0) { throw new Error('Unreadable '+mode+' query'); }
                    samples.push({mode, repeat, startedAtMs, elapsedMs, completionToStartMs: startedAtMs - completion.completedAtMonotonicMs, count: result.dictionaryEntries.length});
                    if (repeat === 0) { oracles[mode] = result; }
                }
            }
            const startedAtMs = globalThis.performance.now();
            const miss = await send({text: 'manabitan-absent-entry-611100-no-match', details: {primaryReading: '', matchType: 'exact', deinflect: false}, optionsContext: {index: 0}});
            const missElapsedMs = globalThis.performance.now() - startedAtMs;
            if (!Array.isArray(miss?.dictionaryEntries) || miss.dictionaryEntries.length !== 0) { throw new Error('Ordinary miss returned entries'); }
            const settled = [];
            await new Promise(resolve => globalThis.setTimeout(resolve, 2000));
            for (const mode of ['exact', 'prefix', 'suffix']) {
                for (let repeat = 0; repeat < 12; ++repeat) {
                    const startedAtMs = globalThis.performance.now();
                    const result = await send({text: '日本', details: {primaryReading: '', matchType: mode, deinflect: false}, optionsContext: {index: 0}});
                    const elapsedMs = globalThis.performance.now() - startedAtMs;
                    if (!Array.isArray(result?.dictionaryEntries) || result.dictionaryEntries.length === 0) { throw new Error('Unreadable settled '+mode+' query'); }
                    settled.push({mode, repeat, startedAtMs, elapsedMs, count: result.dictionaryEntries.length});
                }
            }
            return {settled, sequence: completion.sequence, completionAtMs: completion.completedAtMonotonicMs, samples, oracles, missElapsedMs, missCount: miss.dictionaryEntries.length};
        })();
        globalThis.__prefixGuardProbe = promise;
        void promise.catch(() => {});
    };
    globalThis.addEventListener('manabitan:dictionary-import-complete', handler);
    return {armed: true, sequenceBefore};
}
