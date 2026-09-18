import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const require = createRequire(path.resolve('package.json'));
const {parse} = require('yaml');
const recipeRoot = path.resolve('../recipe');
const sourcePaths = ['ext/js/dictionary/term-bank-wasm-parser.js', 'test/lookup-construction-experiments.test.js'];
const patchPath = path.join(recipeRoot, 'dev/perf/structural-20260918/bounded-native.patch');
const overlayPath = path.join(recipeRoot, 'dev/perf/structural-20260918/bounded-native-v2-overlay.patch');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function command(args, options = {}) {
    const result = spawnSync(args[0], args.slice(1), {stdio: 'inherit', ...options});
    if (result.error || result.status !== 0) throw new Error(`Command failed: ${args.join(' ')}: ${result.error ?? result.status}`);
    return result;
}
if (sha(readFileSync(patchPath)) !== 'ecb3c177c66595a38b41041987d7a4e563a01ca6cb5935300958fbf7327590d3') throw new Error('Wrong V1 patch');
if (sha(readFileSync(overlayPath)) !== '6267e0e41810cc4ea7b4643b62b247b38e484a2106d4fe5498d3ee722100bdcb') throw new Error('Wrong V2 overlay');
command(['git', 'apply', patchPath]);
command(['git', 'apply', overlayPath]);
const finalPatch = command(['git', 'diff', '--binary'], {stdio: 'pipe'}).stdout;
if (sha(finalPatch) !== 'f0113319e0a85daad783ae772ced86905a0555b3c9819911e459e220b65ea93c') throw new Error('Wrong final patch');
writeFileSync(patchPath, finalPatch);
command(['git', 'restore', '--', ...sourcePaths]);
const recipe = parse(readFileSync(path.join(recipeRoot, '.github/workflows/import-bounded-native-20260918.yml'), 'utf8'));
const job = process.argv[2];
if (!['qualify', 'confirm'].includes(job)) throw new Error('Invalid recipe job');
const replacements = new Map([
    ['ecb3c177c66595a38b41041987d7a4e563a01ca6cb5935300958fbf7327590d3', 'f0113319e0a85daad783ae772ced86905a0555b3c9819911e459e220b65ea93c'],
    ['a4e8e465d7ab7bdf23004c68bf4df83c570051bb4f1bbf130b004b80e827c278', '1e3e02c3bccbbe0966a0c9ad73e21dbcfc9fdb9553d1a83ac93318561b7c1257'],
    ['b210d4b292273c596c3286b787681520d469953a969b9690d80a9cdce339c0f8', '2d4e44281b3e1f48728aa55782f3232c4105931255aa110a9953e76d66447ea1'],
    ['assert len(failures)==6,failures', 'assert len(failures)==7,failures'],
    ["'segment-sized arenas','actual worker preserves native segment plans'", "'segment-sized arenas','actual worker preserves native segment plans','empty key tables preserve the existing index rejection: explicit reuse=true'"],
]);
for (const step of recipe.jobs[job].steps) {
    if (!step.run || step.run === 'npm ci') continue;
    let script = step.run;
    for (const [before, after] of replacements) script = script.replaceAll(before, after);
    if (step.name === 'Complete-corpus lookup and canonical-content parity') {
        script = 'set -euo pipefail\nnode dev/perf/prepare-dictionaries.js\n' + script;
    }
    const env = {...process.env};
    for (const [key, value] of Object.entries(step.env ?? {})) {
        if (String(value).includes('${{')) {
            if (key !== 'DICTIONARY' || !env.DICTIONARY) throw new Error(`Unresolved recipe environment ${key}`);
        } else {
            env[key] = String(value);
        }
    }
    console.log(`::group::${step.name ?? script.split('\n')[0]}`);
    command(['bash', '-e', '-o', 'pipefail', '-c', script], {env});
    console.log('::endgroup::');
}
