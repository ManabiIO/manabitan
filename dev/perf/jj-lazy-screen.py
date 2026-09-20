#!/usr/bin/env python3
"""Exact lazy candidate; same fixed complete-import source comparison boundary."""
import shutil,sys,types
from pathlib import Path
base=Path(__file__).with_name('jj-message-screen.py')
source=base.read_text();old='dev/perf/jj-compression-batch.patch';assert source.count(old)==1
source=source.replace(old,'dev/perf/jj-lazy-archive.patch')
m=types.ModuleType('lazy_archive_screen');m.__file__=str(Path(__file__).resolve())
exec(compile(source,str(base),'exec'),m.__dict__)
m.FILES=['ext/js/dictionary/dictionary-importer.js','ext/js/dictionary/term-bank-source-pipeline.js']
m.HASHES=['8f73ff813721f6857781fb71c1f160d5df0543b34011d252c9767da83beadb58','9b120c82e663c54f77dfdb0e68a373abe08f6f54f698da358b0f6d69c17b67ed']
if __name__=='__main__':
    try:m.main()
    finally:
        out=Path(sys.argv[sys.argv.index('--out')+1]).resolve()
        if out.exists():shutil.copyfile(base,out/'base-driver.py')
