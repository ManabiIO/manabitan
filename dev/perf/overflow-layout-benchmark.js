/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {loadavg} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({options: {
    baseline: {type: 'string', default: '98ecaa39^'},
    font: {type: 'string'},
    pairs: {type: 'string', default: '8'},
    out: {type: 'string', default: 'builds/perf/overflow-layout.json'},
}});
assert(values.font, '--font must identify a local font file covering the ASCII fixture');
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs >= 2, '--pairs must be an integer >= 2');
const fontBytes = await readFile(values.font);
const controllerPath = 'ext/js/display/element-overflow-controller.js';
const baseline = execFileSync('git', ['show', `${values.baseline}:${controllerPath}`], {cwd: root});
const candidate = await readFile(path.join(root, controllerPath));
/** @typedef {'baseline'|'candidate'} BenchmarkVariant */
/** @typedef {'expanded'|'collapsed'|'not-collapsible'} CollapseMode */
/** @typedef {{scrollUpToElementTop: () => void}} OverflowDisplayFixture */
/** @typedef {{dictionaries: Array<{name: string, definitionsCollapsible: CollapseMode}>}} OverflowOptions */
/** @typedef {{setOptions: (options: OverflowOptions) => void, addElements: (element: Element) => void, clearElements: () => void, _update: () => void}} OverflowController */
/** @typedef {new (display: OverflowDisplayFixture) => OverflowController} OverflowControllerConstructor */
/** @typedef {{classes: string[], height: number, width: number, scrollHeight: number, scrollWidth: number}} LayoutSnapshot */
/** @typedef {{durationMs: number, initial: LayoutSnapshot[], resized: LayoutSnapshot[], toggled: LayoutSnapshot[], computedFont: string}} LayoutResult */
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const styles = ['material.css', 'display.css', 'display-pronunciation.css', 'structured-content.css'];
const styleHashes = {};
for (const name of styles) { Reflect.set(styleHashes, name, hash(await readFile(path.join(root, 'ext/css', name)))); }
const browser = await chromium.launch({headless: true});
const results = [];
try {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    await page.route('http://layout.test/**', async (route) => {
        const url = new URL(route.request().url());
        // eslint-disable-next-line unicorn/prefer-switch -- preserve the benchmark route order
        if (url.pathname === '/') {
            await route.fulfill({contentType: 'text/html', body: `<!doctype html><html data-page-type="popup"><head>${styles.map((name) => `<link rel="stylesheet" href="/css/${name}">`).join('')}<style>@font-face{font-family:Benchmark;src:url('/font')}body{font-family:Benchmark}</style></head><body><div id="dictionary-entries"></div></body></html>`});
        } else if (url.pathname === '/font') {
            await route.fulfill({body: fontBytes, contentType: 'font/ttf'});
        } else if (url.pathname === '/js/display/baseline.js' || url.pathname === '/js/display/candidate.js') {
            await route.fulfill({body: url.pathname.endsWith('/baseline.js') ? baseline : candidate, contentType: 'text/javascript'});
        } else {
            const relative = decodeURIComponent(url.pathname).slice(1);
            const target = path.resolve(root, 'ext', relative);
            if (!target.startsWith(path.join(root, 'ext') + path.sep)) {
                await route.abort();
                return;
            }
            try {
                await route.fulfill({body: await readFile(target), contentType: target.endsWith('.css') ? 'text/css' : 'text/javascript'});
            } catch { await route.abort(); }
        }
    });
    await page.goto('http://layout.test/');
    await page.evaluate(async () => {
        await document.fonts.load('14px Benchmark', 'dictionary');
        await document.fonts.ready;
        if (!document.fonts.check('14px Benchmark', 'dictionary')) { throw new Error('Benchmark font not loaded'); }
    });
    for (const mode of ['expanded', 'collapsed', 'not-collapsible']) {
        for (const width of [360, 800]) {
            await page.setViewportSize({width, height: 600});
            for (let pair = -1; pair < pairs; ++pair) {
                const order = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
                const arms = [];
                for (const arm of order) {
                    const hostLoad = loadavg();
                    /**
                     * @param {{variant: BenchmarkVariant, collapseMode: CollapseMode}} args
                     * @returns {Promise<LayoutResult>}
                     */
                    const result = await page.evaluate(async ({variant, collapseMode}) => {
                        /** @type {{ElementOverflowController: OverflowControllerConstructor}} */
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, no-unsanitized/method -- variant is restricted to benchmark fixture modules
                        const controllerModule = await import(`/js/display/${variant}.js`);
                        const {ElementOverflowController} = controllerModule;
                        const controller = new ElementOverflowController({scrollUpToElementTop() {}});
                        controller.setOptions({dictionaries: [{name: 'Fixture', definitionsCollapsible: /** @type {CollapseMode} */ (collapseMode)}]});
                        const container = document.querySelector('#dictionary-entries');
                        if (!container) { throw new Error('Missing fixture container'); }
                        container.replaceChildren();
                        container.removeAttribute('style');
                        const entries = [];
                        for (let i = 0; i < 16; ++i) {
                            const entry = document.createElement('div');
                            entry.className = 'entry';
                            const list = document.createElement('ol');
                            list.className = 'definition-list';
                            for (let j = 0; j < 4; ++j) {
                                const item = document.createElement('li');
                                item.className = 'definition-item';
                                item.dataset.dictionary = 'Fixture';
                                const inner = document.createElement('div');
                                inner.className = 'definition-item-inner';
                                const button = document.createElement('button');
                                button.className = 'expansion-button';
                                button.textContent = '+';
                                const content = document.createElement('div');
                                content.className = 'definition-item-content';
                                // eslint-disable-next-line unicorn/no-nested-ternary -- preserve fixture content distribution
                                content.textContent = j === 0 ? 'dictionary' : j === 1 ? 'word; expression; language; reading; definition; '.repeat(15) : j === 2 ? 'unbreakable'.repeat(70) : 'short definition';
                                inner.append(button, content);
                                item.append(inner);
                                list.append(item);
                            }
                            entry.append(list);
                            entries.push(entry);
                        }
                        await new Promise(requestAnimationFrame);
                        // eslint-disable-next-line no-restricted-syntax -- benchmark uses browser monotonic timing
                        const start = performance.now();
                        for (const entry of entries) {
                            container.append(entry);
                            controller.addElements(entry);
                        }
                        // Include final layout, not merely deferred class mutations.
                        container.getBoundingClientRect();
                        // eslint-disable-next-line no-restricted-syntax -- benchmark uses browser monotonic timing
                        const durationMs = performance.now() - start;
                        const snapshot = () => [...container.querySelectorAll('.definition-item-inner')].map((element) => ({
                            classes: [...element.classList].sort(),
                            height: element.getBoundingClientRect().height,
                            width: element.getBoundingClientRect().width,
                            scrollHeight: element.scrollHeight,
                            scrollWidth: element.scrollWidth,
                        }));
                        const initial = snapshot();
                        container.setAttribute('style', 'width: 75%');
                        // eslint-disable-next-line no-underscore-dangle -- benchmark explicitly probes the update path
                        controller._update();
                        const resized = snapshot();
                        const button = container.querySelectorAll('button')[1];
                        button?.click();
                        const toggled = snapshot();
                        controller.clearElements();
                        return {durationMs, initial, resized, toggled, computedFont: getComputedStyle(container).fontFamily};
                    }, {variant: arm, collapseMode: mode});
                    arms.push({arm, hostLoad, ...result});
                }
                const a = arms.find((arm) => arm.arm === 'baseline');
                const b = arms.find((arm) => arm.arm === 'candidate');
                assert(a && b);
                assert.deepEqual(b.initial, a.initial, `Initial layout differs (${mode}/${width})`);
                assert.deepEqual(b.resized, a.resized, `Recheck differs (${mode}/${width})`);
                assert.deepEqual(b.toggled, a.toggled, `Toggle differs (${mode}/${width})`);
                assert.equal(b.computedFont, a.computedFont);
                const collapsibleCount = b.initial.filter((item) => item.classes.includes('collapsible')).length;
                assert(mode === 'not-collapsible' ? collapsibleCount === 0 : collapsibleCount > 0 && collapsibleCount < 64);
                if (pair >= 0) { results.push({mode, width, pair, order, baselineMs: a.durationMs, candidateMs: b.durationMs, hostLoad: arms.map(({arm, hostLoad}) => ({arm, hostLoad})), collapsibleCount}); }
            }
        }
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const {root: documentNode} = await cdp.send('DOM.getDocument');
    const {nodeId} = await cdp.send('DOM.querySelector', {nodeId: documentNode.nodeId, selector: '.definition-item-content'});
    const {fonts} = await cdp.send('CSS.getPlatformFontsForNode', {nodeId});
    assert(fonts.length > 0 && fonts.every((font) => font.isCustomFont), 'Fixture used an unpinned system fallback font');
    const output = path.resolve(root, values.out);
    await mkdir(path.dirname(output), {recursive: true});
    await writeFile(output, JSON.stringify({schemaVersion: 1, scope: 'Overflow component: entry insertion + addElements + final layout; not full popup or Anki latency', browserVersion: browser.version(), baselineRef: values.baseline, baselineSha256: hash(baseline), candidateSha256: hash(candidate), fontSha256: hash(fontBytes), fonts, styleHashes, results}, null, 2));
    console.log(`Validated ${results.length} adjacent pairs; report: ${output}`);
} finally {
    await browser.close();
}
