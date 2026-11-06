import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {expect, test} from 'vitest';

const source = readFileSync(join(process.cwd(), '.github/workflows/publish-firefox.yml'), 'utf8');
const abortStep = source.match(/ {6}- name: Abort on upload error\n {8}if: \|\n((?: {10}.+\n)+) {8}run: exit 1/u);
if (abortStep === null) { throw new Error('Firefox publication must have an upload failure gate'); }
const condition = abortStep[1].trim();

test.each([
    {name: 'successful submission', outcome: 'success', outputs: {}, abort: false},
    {name: 'already submitted version', outcome: 'failure', outputs: {sameVersionAlreadyUploadedError: 'true'}, abort: false},
    {name: 'validation timeout before version submission', outcome: 'failure', outputs: {timeoutError: 'true'}, abort: true},
    {name: 'validation rejection', outcome: 'failure', outputs: {validationError: 'true'}, abort: true},
    {name: 'unclassified failure', outcome: 'failure', outputs: {}, abort: true},
])('Firefox publication: $name', ({outcome, outputs, abort}) => {
    // This gate uses string comparisons and boolean operators shared by Actions and JavaScript.
    const actual = runInNewContext(condition, {steps: {addonsDeploy: {outcome, outputs}}});
    expect(actual).toBe(abort);
});
