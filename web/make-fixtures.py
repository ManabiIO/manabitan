# SPDX-License-Identifier: GPL-3.0-or-later
import json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(root/'web-frequency.zip','w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.json',json.dumps({'title':'Web Frequency','revision':'1','format':3,'sequenced':False}))
    z.writestr('term_meta_bank_1.json',json.dumps([['猫','freq',{'reading':'ねこ','frequency':42}]],ensure_ascii=False))
