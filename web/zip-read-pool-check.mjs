// SPDX-License-Identifier: GPL-3.0-or-later
// Run the identical assertions with Node's test runner, without npm packages.
import {readFile} from 'node:fs/promises';

const testUrl = new URL('../test/zip-read-pool-lifetime.test.js', import.meta.url);
const productionUrl = new URL('../ext/js/dictionary/term-bank-source-pipeline.js', import.meta.url);
const source = (await readFile(testUrl, 'utf8'))
    .replace("from 'vitest'", "from 'node:test'")
    .replace("from '../ext/js/dictionary/term-bank-source-pipeline.js'", `from '${productionUrl.href}'`);
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
