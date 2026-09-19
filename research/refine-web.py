from pathlib import Path
import subprocess
subprocess.run(['git','apply','--check','research/web-refinements.patch'],check=True)
subprocess.run(['git','apply','research/web-refinements.patch'],check=True)
p=Path('web/e2e.mjs');s=p.read_text()
s=s.replace("import {chromium, expect} from '@playwright/test';", "import {chromium, expect} from '@playwright/test';\nimport {runExtended} from './extended-e2e.mjs';")
s=s.replace('const results=[], errors=[];', 'const results=[], errors=[], requests=[];')
s=s.replace('<p id="text"', '<link rel="stylesheet" href="/vendor/css/structured-content.css"><p id="text"')
s=s.replace("try{window.importResult=await runtime.importDictionary(event.target.files[0],{onProgress:p=>{window.progress=p;}});}", "window.importController=new AbortController();\ntry{window.importResult=await runtime.importDictionary(event.target.files[0],{signal:importController.signal,onProgress:p=>{window.progress=p;if(window.cancelDuringImport && p.count>20 && p.index>0)importController.abort();}});}")
needle=" const pathname=new URL(req.url,'http://localhost').pathname;"
assert needle in s
s=s.replace(needle,needle+'''
 requests.push(pathname);
 if(pathname==='/short-default.zip'){res.writeHead(200).end('bad');return;}
 if(pathname==='/default.zip'){
  try{res.writeHead(200,{'Content-Type':'application/zip'}).end(await fs.readFile(path.join(fixtures,'jitendex-yomitan.zip')));}
  catch{res.writeHead(404).end();}return;
 }''')
s=s.replace("'.json':'application/json'", "'.json':'application/json','.css':'text/css'")
marker=" await check('disable and re-enable persists explicit choice without reimport'"
assert s.count(marker)==1
s=s.replace(marker," await runExtended({context,page,origin,fixtures,check,importFile,dictionary,requests});\n"+marker)
p.write_text(s)
