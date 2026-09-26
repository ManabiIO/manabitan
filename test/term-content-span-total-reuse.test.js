/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

test('tryAppendSpans reuses the byte total computed while validating spans', async () => {
    const source = new Uint8Array([99, 1, 2, 3, 88, 4, 5, 77, 6, 7, 8, 9]);
    const offsets = new Uint32Array([1, 5, 8]);
    const lengths = new Uint32Array([3, 2, 4]);
    const store = new TermContentBlockStore(new TermContentOpfsStore(), {minInputBytes: 0});
    const appendPacked = vi.spyOn(store, '_tryAppendPacked').mockResolvedValue(null);

    await expect(store.tryAppendSpans(source, offsets, lengths, null, true)).resolves.toBeNull();

    expect(appendPacked).toHaveBeenCalledOnce();
    expect(appendPacked.mock.calls[0][4]).toBe(9);
});

test('shared-span path receives the same validated byte total', async () => {
    const source = new Uint8Array(new SharedArrayBuffer(12));
    source.set([99, 1, 2, 3, 88, 4, 5, 77, 6, 7, 8, 9]);
    const offsets = new Uint32Array([1, 5, 8]);
    const lengths = new Uint32Array([3, 2, 4]);
    const store = new TermContentBlockStore(new TermContentOpfsStore(), {minInputBytes: 0});
    const appendShared = vi.spyOn(store, '_tryAppendSharedSpans').mockResolvedValue(null);

    await expect(store.tryAppendSpans(source, offsets, lengths, 'jmdict', true)).resolves.toBeNull();

    expect(appendShared).toHaveBeenCalledOnce();
    expect(appendShared.mock.calls[0][5]).toBe(9);
});
