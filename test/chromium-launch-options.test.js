import {expect, test} from 'vitest';
import {getChromiumLaunchOptions} from './e2e/chromium-launch-options.js';

/**
 * @param {{args?: string[]}} options
 * @returns {string[]}
 */
function features(options) {
    const switches = options.args?.filter((arg) => arg.startsWith('--disable-features=')) ?? [];
    expect(switches).toHaveLength(1);
    return switches[0].slice('--disable-features='.length).split(',');
}

test('Mac launch keeps Playwright defaults and merges caller features without mutating inputs', () => {
    const options = {
        headless: true,
        channel: 'chromium',
        args: [
            '--load-extension=/owned/extension',
            '--disable-features=CustomFeature,MacAppCodeSignClone,OptimizationHints',
            '--disable-features=OtherFeature,CustomFeature',
            '--window-size=800,600',
        ],
        ignoreDefaultArgs: ['--mute-audio'],
    };
    const original = structuredClone(options);
    const result = getChromiumLaunchOptions(options, 'darwin');
    const disabled = features(result);
    const ignored = result.ignoreDefaultArgs;
    if (!Array.isArray(ignored)) { throw new Error('Expected a filtered default switch'); }
    const defaultSwitch = ignored[1];
    expect(typeof defaultSwitch).toBe('string');
    expect(defaultSwitch).toContain('--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,');
    const defaults = String(defaultSwitch).slice('--disable-features='.length).split(',');
    expect(defaults).toHaveLength(15);
    expect(disabled).toEqual([...defaults, 'CustomFeature', 'MacAppCodeSignClone', 'OtherFeature']);
    expect(new Set(disabled).size).toBe(disabled.length);
    expect(result.args?.slice(0, 2)).toEqual(['--load-extension=/owned/extension', '--window-size=800,600']);
    expect(result.headless).toBe(true);
    expect(result.channel).toBe('chromium');
    expect(ignored[0]).toBe('--mute-audio');
    expect(options).toEqual(original);
});

test('Mac launch adds its clone guard when args are absent', () => {
    const disabled = features(getChromiumLaunchOptions({}, 'darwin'));
    expect(disabled).toContain('MacAppCodeSignClone');
    expect(disabled).toContain('OptimizationHints');
    expect(disabled).toContain('DestroyProfileOnBrowserClose');
});

test('ignoring all defaults preserves that choice and only merges caller features and clone guard', () => {
    const result = getChromiumLaunchOptions({ignoreDefaultArgs: true, args: ['--enable-automation', '--disable-features=OnlyCaller']}, 'darwin');
    expect(result.ignoreDefaultArgs).toBe(true);
    expect(features(result)).toEqual(['OnlyCaller', 'MacAppCodeSignClone']);
    expect(result.args?.[0]).toBe('--enable-automation');
});

test('an explicitly ignored default feature switch is not reinserted', () => {
    const configured = getChromiumLaunchOptions({}, 'darwin');
    const ignored = configured.ignoreDefaultArgs;
    if (!Array.isArray(ignored)) { throw new Error('Expected a filtered default switch'); }
    const result = getChromiumLaunchOptions({ignoreDefaultArgs: ignored}, 'darwin');
    expect(features(result)).toEqual(['MacAppCodeSignClone']);
    expect(result.ignoreDefaultArgs).toEqual(ignored);
});

test('reapplying the helper retains merged defaults and creates no duplicate flags', () => {
    const configured = getChromiumLaunchOptions({args: ['--disable-features=CustomFeature']}, 'darwin');
    expect(getChromiumLaunchOptions(configured, 'darwin')).toEqual(configured);
});

test.each(['linux', 'win32'])('non-Mac launch options pass through unchanged (%s)', (platform) => {
    const options = {args: ['--disable-features=Caller'], ignoreDefaultArgs: false, headless: false};
    expect(getChromiumLaunchOptions(options, /** @type {NodeJS.Platform} */ (platform))).toBe(options);
});
