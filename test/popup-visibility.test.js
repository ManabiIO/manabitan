/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {Popup} from '../ext/js/app/popup.js';

describe('Popup visibility', () => {
    test('hiding an already-hidden parent still hides its visible child', () => {
        const popup = /** @type {Popup} */ (Object.create(Popup.prototype));
        const childHide = vi.fn();
        Reflect.set(popup, '_visible', {value: false});
        Reflect.set(popup, '_hidePopupTimer', null);
        Reflect.set(popup, '_child', {hide: childHide});

        popup.hide(false);

        expect(childHide).toHaveBeenCalledExactlyOnceWith(false);
    });
});
