import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {describe, expect, test} from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/contribution-license.yml', import.meta.url), 'utf8');
const scriptStart = workflow.indexOf("          node <<'NODE'\n") + "          node <<'NODE'\n".length;
const scriptEnd = workflow.indexOf('\n          NODE', scriptStart);
const runScript = scriptEnd < 0 ?
    '' :
    workflow.slice(scriptStart, scriptEnd)
        .split('\n')
        .map((line) => line.slice(10))
        .join('\n');
const acknowledgement = 'I agree that the copyrightable portions of this contribution that I own are licensed under GPL-3.0-or-later, as described in CONTRIBUTING.md.';
const provenance = 'I identified any copied, adapted, ported, translated, mechanically rewritten, or otherwise third-party-derived material and its license.';

/**
 * @param {string} body
 * @param {{authorId?: string, headRepositoryId?: string, baseRepositoryId?: string}} [pullRequest]
 * @returns {{exitCode: number, error: string}}
 */
function run(body, pullRequest = {}) {
    let exitCode = 0;
    let error = '';
    vm.runInNewContext(runScript, {
        process: {
            env: {
                PR_BODY: body,
                PR_AUTHOR_ID: pullRequest.authorId ?? '12345',
                PR_HEAD_REPOSITORY_ID: pullRequest.headRepositoryId ?? '1165902460',
                PR_BASE_REPOSITORY_ID: pullRequest.baseRepositoryId ?? '1165902460',
                REPOSITORY_ID: '1165902460',
            },
            exit(/** @type {number} */ code) { exitCode = code; },
        },
        console: {
            error(/** @type {string} */ message) { error = message; },
        },
    });
    return {exitCode, error};
}

describe('contribution license acknowledgement workflow', () => {
    test('accepts checked GPL-only acknowledgement and provenance confirmation', () => {
        expect(run(`- [x] ${acknowledgement}\n- [X] ${provenance}`)).toEqual({exitCode: 0, error: ''});
    });

    test('rejects missing GPL acknowledgement', () => {
        expect(run(`- [ ] ${acknowledgement}\n- [x] ${provenance}`).exitCode).toBe(1);
    });

    test('rejects missing third-party provenance confirmation', () => {
        expect(run(`- [x] ${acknowledgement}\n- [ ] ${provenance}`).exitCode).toBe(1);
    });

    test('does not accept the former GPL and BSD dual-grant acknowledgement', () => {
        const oldAcknowledgement = "- [x] I agree that the copyrightable portions of this contribution that I own are licensed separately under GPL-3.0-or-later and BSD-3-Clause, at the recipient's option, as described in CONTRIBUTING.md.\n- [x] " + provenance;
        expect(run(oldAcknowledgement).exitCode).toBe(1);
    });

    test('exempts the verified owner on a same-repository pull request', () => {
        expect(run('', {authorId: '71601'})).toEqual({exitCode: 0, error: ''});
    });

    test('requires acknowledgement and provenance from another contributor', () => {
        expect(run('').exitCode).toBe(1);
        expect(run(`- [x] ${acknowledgement}\n- [x] ${provenance}`).exitCode).toBe(0);
    });

    test('requires acknowledgement and provenance from an owner-authored fork pull request', () => {
        const ownerFork = {authorId: '71601', headRepositoryId: '987654321'};
        expect(run('', ownerFork).exitCode).toBe(1);
        expect(run(`- [x] ${acknowledgement}\n- [x] ${provenance}`, ownerFork).exitCode).toBe(0);
    });

    test('requires acknowledgement and provenance when the owner-authored pull request base is another repository', () => {
        const foreignBase = {authorId: '71601', baseRepositoryId: '987654321'};
        expect(run('', foreignBase).exitCode).toBe(1);
        expect(run(`- [x] ${acknowledgement}\n- [x] ${provenance}`, foreignBase).exitCode).toBe(0);
    });
});
