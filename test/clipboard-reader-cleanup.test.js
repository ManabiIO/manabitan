/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {ClipboardReader} from '../ext/js/comm/clipboard-reader.js';

/**
 * @returns {{reader: ClipboardReader, plain: {value: string}, rich: {textContent: string}, attributes: Map<string, string>, execCommand: ReturnType<typeof vi.fn>}}
 */
function createReader() {
    const attributes = new Map([['src', 'data:image/png;base64,OLD'], ['srcset', 'old 1x']]);
    const image = {
        /** @param {string} name */
        getAttribute: (name) => attributes.get(name) ?? null,
        /** @param {string} name */
        removeAttribute: (name) => { attributes.delete(name); },
    };
    const rich = {
        textContent: 'stale',
        focus: vi.fn(),
        querySelectorAll: () => [image],
        querySelector: () => (image.getAttribute('src')?.startsWith('data:') ? image : null),
    };
    const plain = {value: 'stale', focus: vi.fn()};
    const execCommand = vi.fn().mockReturnValue(false);
    const reader = /** @type {ClipboardReader} */ (/** @type {unknown} */ (Object.create(ClipboardReader.prototype)));
    Reflect.set(reader, '_browser', null);
    Reflect.set(reader, '_document', {execCommand});
    Reflect.set(reader, '_richContentPasteTarget', rich);
    Reflect.set(reader, '_pasteTarget', plain);
    return {reader, plain, rich, attributes, execCommand};
}

describe('ClipboardReader temporary paste targets', () => {
    test('failed rich paste cannot return text left over in its target', async () => {
        const {reader, rich, attributes, execCommand} = createReader();

        expect(await reader.getText(true)).toBe('');
        expect(execCommand).toHaveBeenCalledWith('paste');
        expect(rich.textContent).toBe('');
        expect(attributes.size).toBe(0);
    });

    test('failed image paste cannot return the previously retained data URL', async () => {
        const {reader, attributes} = createReader();

        expect(await reader.getImage()).toBe(null);
        expect(attributes.size).toBe(0);
    });

    test('rich target is cleared when paste fails after writing private text', async () => {
        const {reader, rich, attributes, execCommand} = createReader();
        execCommand.mockImplementation(() => {
            rich.textContent = 'secret clipboard data';
            attributes.set('src', 'data:image/png;base64,NEW');
            throw new Error('Paste is blocked');
        });

        await expect(reader.getText(true)).rejects.toThrow('Paste is blocked');
        expect(rich.textContent).toBe('');
        expect(attributes.size).toBe(0);
    });

    test('plain text target is cleared even when paste throws', async () => {
        const {reader, plain, execCommand} = createReader();
        execCommand.mockImplementation(() => {
            plain.value = 'secret clipboard data';
            throw new Error('Paste is blocked');
        });

        await expect(reader.getText(false)).rejects.toThrow('Paste is blocked');
        expect(plain.value).toBe('');
    });

    test('successfully pasted rich text is returned and then cleared', async () => {
        const {reader, rich, attributes, execCommand} = createReader();
        execCommand.mockImplementation(() => {
            rich.textContent = 'fresh clipboard data';
            return true;
        });

        expect(await reader.getText(true)).toBe('fresh clipboard data');
        expect(rich.textContent).toBe('');
        expect(attributes.size).toBe(0);
    });

    test('successfully pasted image URL is returned and then removed', async () => {
        const {reader, attributes, execCommand} = createReader();
        execCommand.mockImplementation(() => {
            attributes.set('src', 'data:image/png;base64,NEW');
            return true;
        });

        expect(await reader.getImage()).toBe('data:image/png;base64,NEW');
        expect(attributes.size).toBe(0);
    });

    test('successfully pasted plain text is returned and then cleared', async () => {
        const {reader, plain, execCommand} = createReader();
        execCommand.mockImplementation(() => {
            plain.value = 'fresh clipboard data';
            return true;
        });

        expect(await reader.getText(false)).toBe('fresh clipboard data');
        expect(plain.value).toBe('');
    });
});
