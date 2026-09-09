#!/usr/bin/env bash
set -euo pipefail
: "${CANDIDATE_SHA:?}" "${CANDIDATE_TREE:?}" "${PACKAGE_CHANGE:?}"
export EVIDENCE="$RUNNER_TEMP/evidence"
mkdir -p "$EVIDENCE" "$RUNNER_TEMP/packages"
cp .github/owned-copy-paired.py "$EVIDENCE/paired.py"
git switch --detach ff9cbf2e848a86d6bbfd281179a6d753349e52f4
test "$(git rev-parse HEAD^{tree})" = dc3098b9acc761caf193952537d568652196dc76
npm ci
if ! command -v clang >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y clang lld
fi
node node_modules/playwright/cli.js install --with-deps chromium
node --input-type=module <<'NODE'
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end('<!doctype html><title>Native policy preflight</title>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
    browser=await chromium.launch({channel:'chromium',headless:true,args:['--no-sandbox']});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const native=await page.evaluate(async()=>{
        const page={memory:navigator.deviceMemory,cores:navigator.hardwareConcurrency,isolated:crossOriginIsolated};
        const url=URL.createObjectURL(new Blob(['postMessage({memory:navigator.deviceMemory,cores:navigator.hardwareConcurrency,isolated:crossOriginIsolated})'],{type:'text/javascript'}));
        const worker=new Worker(url);
        try{return {page,worker:await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=reject;})};}
        finally{worker.terminate();URL.revokeObjectURL(url);}
    });
    writeFileSync(`${process.env.EVIDENCE}/native-policy.json`,JSON.stringify({browser:browser.version(),runner:process.env.RUNNER_LABEL,native},null,2));
    if(native.page.memory!==native.worker.memory||!native.page.isolated||!native.worker.isolated)throw new Error('Native page/worker policy mismatch');
    if(process.env.RUNNER_LABEL==='ubuntu-slim'&&native.page.memory!==4)throw new Error('Constrained runner did not expose native 4 GiB policy');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
NODE
node --version > "$EVIDENCE/node.txt"
clang --version > "$EVIDENCE/compiler.txt"
lscpu > "$EVIDENCE/cpu.txt"
free -b > "$EVIDENCE/memory.txt"
for file in memory.max cpu.max; do
    if test -f "/sys/fs/cgroup/$file"; then cat "/sys/fs/cgroup/$file" > "$EVIDENCE/cgroup-$file.txt"; fi
done
node dev/perf/prepare-dictionaries.js > "$EVIDENCE/fixtures.log" 2>&1
node dev/bin/build.js --target chrome-dev > "$EVIDENCE/baseline-build.log" 2>&1
cp builds/manabitan-chrome-dev.zip "$RUNNER_TEMP/packages/baseline.zip"
git switch --detach "$CANDIDATE_SHA"
test "$(git rev-parse HEAD^{tree})" = "$CANDIDATE_TREE"
node dev/bin/build.js --target chrome-dev > "$EVIDENCE/candidate-build.log" 2>&1
cp builds/manabitan-chrome-dev.zip "$RUNNER_TEMP/packages/candidate.zip"
python3 - <<'PY'
import zipfile,os,json,hashlib
root=os.environ['RUNNER_TEMP']
with zipfile.ZipFile(root+'/packages/baseline.zip') as za, zipfile.ZipFile(root+'/packages/candidate.zip') as zb:
    a={n:za.read(n) for n in za.namelist()};b={n:zb.read(n) for n in zb.namelist()}
changed=sorted(n for n in a.keys()|b.keys() if a.get(n)!=b.get(n))
assert changed==os.environ['PACKAGE_CHANGE'].split(','),changed
json.dump({'changed':changed,'baseline':{n:hashlib.sha256(v).hexdigest() for n,v in a.items()},'candidate':{n:hashlib.sha256(v).hexdigest() for n,v in b.items()}},open(root+'/evidence/package-payloads.json','w'),indent=2)
PY
git worktree add --detach "$RUNNER_TEMP/baseline" ff9cbf2e848a86d6bbfd281179a6d753349e52f4
printf '\nnode_modules\n' >> .git/info/exclude
ln -s "$GITHUB_WORKSPACE/node_modules" "$RUNNER_TEMP/baseline/node_modules"
cp -a ext/lib/. "$RUNNER_TEMP/baseline/ext/lib/"
mkdir -p "$RUNNER_TEMP/baseline/builds"
cp "$RUNNER_TEMP/packages/baseline.zip" "$RUNNER_TEMP/baseline/builds/manabitan-chrome-dev.zip"
ln -s "$GITHUB_WORKSPACE/builds/e2e-dictionary-cache" "$RUNNER_TEMP/baseline/builds/e2e-dictionary-cache"
test -z "$(git status --porcelain)"
test -z "$(git -C "$RUNNER_TEMP/baseline" status --porcelain)"
git diff ff9cbf2e848a86d6bbfd281179a6d753349e52f4 "$CANDIDATE_SHA" > "$EVIDENCE/source.patch"
python3 "$EVIDENCE/paired.py" --baseline "$RUNNER_TEMP/baseline" --candidate "$GITHUB_WORKSPACE" --output "$EVIDENCE/paired" --dictionaries "$DICTIONARY" --pairs 6 --reverse 2>&1 | tee "$EVIDENCE/driver.log"
