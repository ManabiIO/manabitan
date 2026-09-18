#!/usr/bin/env bash
set -euo pipefail
mkdir -p reader-web-results /tmp/reader-fixtures
python3 - <<'PY'
import base64,gzip,hashlib,pathlib
p=pathlib.Path('test/reader-web')
s=(p/'fixture-runtime.part1.b64').read_text().strip()+(p/'fixture-runtime.part2.b64').read_text().strip()
for a,b in [('T+RZZTVKs','T+RZTVKs'),('PPux/eXPux/eXPw','PPux/eXPw'),('XR95y6WoefVm9PbNr70XR95y6+','XR95y6+')]: s=s.replace(a,b)
patch=gzip.decompress(base64.b64decode(s,validate=True))
assert hashlib.sha256(patch).hexdigest()=='b822ebbb904c1cb0051a4f5e5d177f081a7c6b5107e50a9b48b12f3e0961260e'
pathlib.Path('/tmp/reader-runtime.patch').write_bytes(patch)
PY
git -C reader-fixture apply /tmp/reader-runtime.patch
git rev-parse HEAD > reader-web-results/harness-head.txt
git -C reader-fixture rev-parse HEAD > reader-web-results/reader-upstream.txt
cp /tmp/reader-runtime.patch reader-web-results/reader-runtime.patch
python3 test/reader-web/prepare-harness.py
node --check test/reader-web/run.mjs
npm ci > reader-web-results/manabitan-install.log 2>&1
npm run build:libs > reader-web-results/manabitan-libs.log 2>&1
node dev/bin/build.js chrome-dev > reader-web-results/manabitan-build.log 2>&1
mkdir -p /tmp/manabitan-extension
unzip -q builds/manabitan-chrome-dev.zip -d /tmp/manabitan-extension
npm install --global pnpm@12.3.4
cp reader-fixture/pnpm-lock.yaml reader-web-results/pnpm-lock-before.yaml
(cd reader-fixture && pnpm install --lockfile-only --no-frozen-lockfile) > reader-web-results/reader-lock-reconcile.log 2>&1
cp reader-fixture/pnpm-lock.yaml reader-web-results/pnpm-lock-after.yaml
# pnpm 12 may serialize multiple YAML documents. Retain complete before/after
# locks and their parsed forms, rather than falsely reporting a failed parser
# as a dependency-resolution regression.
node --input-type=module - <<'JS'
import fs from 'node:fs';
import {parseAllDocuments} from 'yaml';
for (const name of ['before','after']) {
  const docs=parseAllDocuments(fs.readFileSync(`reader-web-results/pnpm-lock-${name}.yaml`,'utf8'));
  for (const doc of docs) { if(doc.errors.length) { throw doc.errors[0]; } }
  fs.writeFileSync(`reader-web-results/pnpm-lock-${name}.json`,JSON.stringify(docs.map((d)=>d.toJSON()),null,2));
}
JS
(cd reader-fixture && pnpm install --frozen-lockfile) > reader-web-results/reader-install.log 2>&1
(cd reader-fixture && pnpm --dir apps/web exec svelte-kit sync)
(cd reader-fixture && pnpm build) > reader-web-results/reader-build-a.log 2>&1
cp -a reader-fixture/apps/web/build /tmp/reader-build-a
(cd reader-fixture && pnpm build) > reader-web-results/reader-build-b.log 2>&1
cp -a reader-fixture/apps/web/build /tmp/reader-build-b
npx playwright install --with-deps chromium > reader-web-results/browser-install.log 2>&1
python3 test/reader-web/make-fixtures.py /tmp/reader-fixtures
curl --fail --location --retry 3 --max-time 180 https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-09-18/JMdict_english.zip -o /tmp/reader-fixtures/JMdict_english.zip
python3 - <<'PY'
import hashlib,json,pathlib,zipfile
p=pathlib.Path('/tmp/reader-fixtures/JMdict_english.zip'); raw=p.read_bytes(); digest=hashlib.sha256(raw).hexdigest()
assert len(raw)==15595643
assert digest=='b895d0fa41324d5bdd7bd0a943e73b46d25f849ddab6e0491e619bfc4e4e20d9'
with zipfile.ZipFile(p) as z:
    index=json.loads(z.read('index.json'))
    rows=sum(len(json.loads(z.read(n))) for n in z.namelist() if n.startswith('term_bank_') and n.endswith('.json'))
m={'repository':'yomidevs/jmdict-yomitan','release':'2026-09-18','asset':p.name,'bytes':len(raw),'sha256':digest,'termRows':rows,'index':index}
pathlib.Path('/tmp/reader-fixtures/jmdict.json').write_text(json.dumps(m,indent=2))
pathlib.Path('reader-web-results/jmdict.json').write_text(json.dumps(m,indent=2))
PY
export READER_BUILD=/tmp/reader-build-a READER_BUILD_B=/tmp/reader-build-b
export READER_FIXTURES=/tmp/reader-fixtures MANABITAN_EXTENSION=/tmp/manabitan-extension E2E_OUTPUT=reader-web-results
node test/reader-web/run.mjs 2>&1 | tee reader-web-results/browser-run.log
