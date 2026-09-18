from pathlib import Path
import subprocess
fix='7e73f29465d6225bc60c7629bb057d303dbe20c0'
subprocess.run(['git','fetch','--depth=1','origin',fix],check=True)
expected={'ext/js/core/fetch-utilities.js':'47ad12eb9c1889d3401dd8be3b0fc86e33321672','test/web-asset-fetch.test.js':'a9f1311bda193e93c40207e8814ab32aaa85c012'}
for filename,blob in expected.items():
    data=subprocess.check_output(['git','show',f'{fix}:{filename}'])
    actual=subprocess.check_output(['git','hash-object','--stdin'],input=data).decode().strip()
    assert actual==blob,(filename,actual)
    Path(filename).write_bytes(data)
p=Path('test/reader-web/qualify.sh');s=p.read_text()
needle='python3 test/reader-web/refine-browser-assertions.py'
assert s.count(needle)==1
s=s.replace(needle,needle+'\npython3 test/reader-web/nonzero-bookmark-assertions.py')
s=s.replace('npm run build:libs > reader-web-results/manabitan-libs.log 2>&1','npm run build:libs > reader-web-results/manabitan-libs.log 2>&1\nnode node_modules/vitest/vitest.mjs run test/web-asset-fetch.test.js test/web-asset-paths.test.js test/dictionary-worker-backend.test.js > reader-web-results/manabitan-focused-tests.log 2>&1\nprintf "%s\\n" '+fix+' > reader-web-results/manabitan-runtime-fix.txt')
p.write_text(s)
