#!/usr/bin/env python3
"""Only the candidate changes; preserve the fixed-plan full-import driver."""
import shutil,sys,types
from pathlib import Path
base=Path(__file__).with_name('jj-message-screen.py')
source=base.read_text()
a='dev/perf/jj-compression-batch.patch';assert source.count(a)==1
source=source.replace(a,'dev/perf/jj-shared-archive.patch')
m=types.ModuleType('shared_archive_screen');m.__file__=str(Path(__file__).resolve())
exec(compile(source,str(base),'exec'),m.__dict__)
m.FILES=['ext/js/dictionary/dictionary-importer.js','ext/js/dictionary/term-bank-source-pipeline.js']
m.HASHES=['1e4babb7c0aa0b673c4338f1022f31d8e6bc6bfb6c2eab3911d681a6284e067e','a4e5ffc2d293e6ffd6477d8e6bc862ca0fdbe47d777a34e02b3452f7421a7706']
try:m.main()
finally:
    out=Path(sys.argv[sys.argv.index('--out')+1]).resolve()
    if out.exists():shutil.copyfile(base,out/'base-driver.py')
