# SPDX-License-Identifier: GPL-3.0-or-later
"""Real upstream acceptance archives plus clearly named adversarial custom fixtures."""
import base64,hashlib,json,pathlib,sys,urllib.request,zipfile
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
url='https://github.com/stephenmk/stephenmk.github.io/releases/download/2026.08.11.0/jitendex-yomitan.zip'
p=root/'jitendex-yomitan.zip'
if not p.exists():
    try:
        with urllib.request.urlopen(url,timeout=120) as response,p.open('wb') as output:
            count=0
            while chunk:=response.read(262144):
                count+=len(chunk)
                if count>38698313:raise ValueError('Jitendex fixture exceeds verified size')
                output.write(chunk)
    except BaseException:
        p.unlink(missing_ok=True);raise
raw=p.read_bytes();assert len(raw)==38698313
assert hashlib.sha256(raw).hexdigest()=='8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc'
with zipfile.ZipFile(p) as z:
    rows=sum(len(json.loads(z.read(n))) for n in z.namelist() if n.startswith('term_bank_') and n.endswith('.json'))
(root/'jitendex.json').write_text(json.dumps({'termRows':rows,'source':url}))
def write(name,title,banks,media=None):
    with zipfile.ZipFile(root/name,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('index.json',json.dumps({'title':title,'revision':'1','format':3,'sequenced':True}))
        for i,bank in enumerate(banks):z.writestr(f'term_bank_{i+1}.json',json.dumps(bank,ensure_ascii=False))
        for n,v in (media or {}).items():z.writestr(n,v)
write('web-interrupted.zip','Web Interrupted',(
    [[f'中断検査{bank*2000+i}','ちゅうだんけんさ','','',0,[f'Interrupted import fixture {bank*2000+i} '+('文書。'*80)],bank*2000+i,''] for i in range(2000)]
    for bank in range(80)))
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
write('web-media.zip','Web Media',[[['画像検査','がぞうけんさ','','',0,[
    '<img onerror=window.__dictionaryExecuted=true>',
    {'type':'structured-content','content':[
        {'tag':'span','style':{'background':'url(http://127.0.0.1:4180/dictionary-probe)'},'content':'安全な本文'},
        {'tag':'img','path':'pixel.png','width':1,'height':1},
        {'tag':'a','href':'javascript:alert(1)','content':'危険なリンク'},
        {'tag':'a','href':'?query=学校','content':'学校を見る'}]}],1,'']]],{'pixel.png':png})
