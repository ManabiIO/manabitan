from pathlib import Path
p=Path('ext/js/dictionary/term-content-opfs-store.js');s=p.read_text()
old='''                currentActiveSegment.fileLength += chunkSize;
                this._length = Math.max'''
new='''                currentActiveSegment.fileLength += chunkSize;
                // The append cursor adds persisted and still-in-flight bytes.
                // Once a queued write advances the persisted length, subtract
                // exactly that progress before another append can observe it.
                // Keeping the entire drain batch counted until completion would
                // double-count completed groups and publish offsets past EOF.
                this._inFlightWriteBytes = Math.max(0, this._inFlightWriteBytes - chunkSize);
                this._length = Math.max'''
assert s.count(old)==1;p.write_text(s.replace(old,new))
