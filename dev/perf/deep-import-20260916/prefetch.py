from pathlib import Path
import hashlib,json,sys
variant=sys.argv[1]
assert variant in ('media-prefetch4m','media-prefetch8m')
cap=4 if variant.endswith('4m') else 8
p=Path('ext/js/dictionary/dictionary-importer.js');s=p.read_text()
def replace(old,new):
    global s
    assert s.count(old)==1,(s.count(old),old[:120])
    s=s.replace(old,new)
replace('        let initialSourcePrefetch = {fileCount: 0, estimatedBytes: 0};\n', '''        let initialSourcePrefetch = {fileCount: 0, estimatedBytes: 0};
        let mediaPrefetch = Promise.resolve();
        let acceptMediaPrefetch = true;
        /** @type {Error|null} */
        let mediaPrefetchFailure = null;
        /** @type {import('dictionary-database').MediaDataArrayBufferContent[]} */
        const prefetchedNoMetadataMedia = [];
        let mediaPrefetchRemainingBytes = CAP * 1024 * 1024;
        let mediaPrefetchRemainingEntries = 256;
'''.replace('CAP',str(cap)))
replace('''                            deferredNoMetadataMediaRequirements.push(...notAddedRequirements);''','''                            /** @type {import('dictionary-importer').ImportRequirement[]} */
                            const prefetchRequirements = [];
                            for (const requirement of notAddedRequirements) {
                                const file = requirement.type === 'structured-content-media-link' ?
                                    void 0 : fileMap.get(requirement.source.path);
                                const size = typeof file === 'undefined' ? void 0 : Reflect.get(file, 'uncompressedSize');
                                if (
                                    typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 ||
                                    size > mediaPrefetchRemainingBytes || mediaPrefetchRemainingEntries === 0
                                ) {
                                    deferredNoMetadataMediaRequirements.push(requirement);
                                    continue;
                                }
                                mediaPrefetchRemainingBytes -= size;
                                --mediaPrefetchRemainingEntries;
                                prefetchRequirements.push(requirement);
                            }
                            if (prefetchRequirements.length > 0) {
                                mediaPrefetch = mediaPrefetch.then(async () => {
                                    if (!acceptMediaPrefetch || importSession.failed || this._isCancelled()) { return; }
                                    try {
                                        const result = await this._resolveAsyncRequirements(prefetchRequirements, fileMap);
                                        prefetchedNoMetadataMedia.push(...result.media);
                                    } catch (error) {
                                        mediaPrefetchFailure = importSession.recordFailure(error);
                                    }
                                });
                            }''')
replace('''                const trackProgress = streamedProgress === null;
''','''                if (mediaPrefetchFailure !== null) { throw mediaPrefetchFailure; }
                const trackProgress = streamedProgress === null;
''')
replace('''            if (deferredNoMetadataMediaRequirements.length > 0) {
                const tMediaResolveStart = Date.now();
                const {media} = await this._resolveAsyncRequirements(deferredNoMetadataMediaRequirements, fileMap);
''','''            if (deferredNoMetadataMediaRequirements.length > 0 || mediaPrefetchRemainingEntries < 256) {
                const tMediaResolveStart = Date.now();
                await mediaPrefetch;
                if (mediaPrefetchFailure !== null) { throw mediaPrefetchFailure; }
                const {media} = await this._resolveAsyncRequirements(deferredNoMetadataMediaRequirements, fileMap);
                media.unshift(...prefetchedNoMetadataMedia);
                prefetchedNoMetadataMedia.length = 0;
''')
replace('''        } finally {
            eventLoopYielder.close();
''','''        } finally {
            acceptMediaPrefetch = false;
            await mediaPrefetch;
            prefetchedNoMetadataMedia.length = 0;
            eventLoopYielder.close();
''')
p.write_text(s)
print(json.dumps({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'tests':[]}))
