from pathlib import Path
import sys
root = Path(sys.argv[1])
p = root / 'block-budget.test.js'
s = p.read_text()
old = '''            if (manual) {
                await new Promise((resolve) => { gates.push(() => resolve(void 0)); });
            } else {
                await nextTurn();
            }'''
new = '''            await (manual ?
                new Promise((resolve) => { gates.push(() => resolve(void 0)); }) :
                nextTurn());'''
assert s.count(old) == 1
s = s.replace(old, new)
old = '    const release = () => { for (const resolve of gates.splice(0)) { resolve(); } };'
new = '''    const release = () => {
        for (const resolve of gates.splice(0)) { resolve(); }
    };'''
assert s.count(old) == 1
p.write_text(s.replace(old, new))
# The existing dev/jsconfig covers .js; do not exclude the probe from lint/types.
(root / 'probe.mjs').rename(root / 'probe.js')
p = root / 'bench.md'
p.write_text(p.read_text().replace('block-read-retention-probe.mjs', 'block-read-retention-probe.js'))
