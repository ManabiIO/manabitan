/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DisplayResizer} from '../ext/js/display/display-resizer.js';

function setup() {
    const root = {dataset: /** @type {Record<string, string>} */ ({})};
    const handle = Object.assign(new EventTarget(), {getBoundingClientRect: () => ({width: 12, height: 10})});
    const display = {parentPopupId: 'popup', invokeParentFrame: vi.fn(), onError: vi.fn()};
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', {documentElement: root, querySelector: () => handle});
    const resizer = new DisplayResizer(/** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)));
    resizer.prepare();
    return {resizer, display, root};
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {MouseEvent}
 */
function mouse(x, y) {
    return /** @type {MouseEvent} */ (/** @type {unknown} */ ({clientX: x, clientY: y, buttons: 1}));
}

/**
 * @param {ReturnType<typeof setup>} context
 * @returns {Promise<void>}
 */
function initialize(context) {
    const {resizer, root} = context;
    /** @type {import('core').TokenObject} */
    const token = {};
    resizer._token = token;
    resizer._startOffset = {x: 100, y: 100};
    root.dataset.isResizing = 'true';
    return resizer._initializeFrameResize(token);
}

afterEach(() => { vi.unstubAllGlobals(); });

test('keeps the latest mouse position while the starting size is pending', async () => {
    const context = setup();
    const {resizer, display} = context;
    const size = Promise.withResolvers();
    display.invokeParentFrame.mockReturnValueOnce(size.promise).mockResolvedValue(true);
    const pending = initialize(context);
    resizer._onFrameResizerMouseMove(mouse(120, 130));
    resizer._onFrameResizerMouseMove(mouse(145, 155));
    size.resolve({width: 400, height: 300, valid: true});
    await pending;
    expect(display.invokeParentFrame.mock.calls).toEqual([
        ['popupFactoryGetFrameSize', {id: 'popup'}],
        ['popupFactorySetFrameSize', {id: 'popup', width: 445, height: 355}],
    ]);
});

test('keeps the tracked touch position while the starting size is pending', async () => {
    const context = setup();
    const {resizer, display} = context;
    const size = Promise.withResolvers();
    display.invokeParentFrame.mockReturnValueOnce(size.promise).mockResolvedValue(true);
    const pending = initialize(context);
    resizer._touchIdentifier = 7;
    /**
     * @param {number} identifier
     * @param {number} clientX
     * @param {number} clientY
     * @returns {TouchEvent}
     */
    const touch = (identifier, clientX, clientY) => /** @type {TouchEvent} */ (/** @type {unknown} */ ({changedTouches: [{identifier, clientX, clientY}]}));
    resizer._onFrameResizerTouchMove(touch(8, 300, 400));
    resizer._onFrameResizerTouchMove(touch(7, 140, 160));
    size.resolve({width: 400, height: 300, valid: true});
    await pending;
    expect(display.invokeParentFrame).toHaveBeenLastCalledWith('popupFactorySetFrameSize', {id: 'popup', width: 440, height: 360});
});

test('does not replay movement after the drag ends during initialization', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    const size = Promise.withResolvers();
    display.invokeParentFrame.mockReturnValueOnce(size.promise);
    const pending = initialize(context);
    resizer._onFrameResizerMouseMove(mouse(140, 160));
    resizer._onFrameResizerMouseUp();
    size.resolve({width: 400, height: 300, valid: true});
    await pending;
    expect(display.invokeParentFrame).toHaveBeenCalledTimes(1);
    expect(root.dataset.isResizing).toBeUndefined();
});

test('failed initialization cleans up the gesture and allows another attempt', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    const failure = new Error('Parent frame disconnected');
    display.invokeParentFrame.mockRejectedValueOnce(failure);
    await expect(initialize(context)).resolves.toBeUndefined();
    expect(resizer._token).toBeNull();
    expect(root.dataset.isResizing).toBeUndefined();
    expect(display.onError).toHaveBeenCalledWith(failure);
    display.invokeParentFrame.mockResolvedValue({width: 400, height: 300, valid: true});
    await initialize(context);
    expect(resizer._startSize).toEqual({width: 400, height: 300});
});

test('an unavailable starting size ends the gesture without shrinking the popup', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    display.invokeParentFrame.mockResolvedValue({width: 0, height: 0, valid: false});
    await initialize(context);
    await resizer._updateFrameSize(120, 130);
    expect(display.invokeParentFrame).toHaveBeenCalledTimes(1);
    expect(resizer._token).toBeNull();
    expect(root.dataset.isResizing).toBeUndefined();
    expect(display.onError).not.toHaveBeenCalled();
});

test('a rejected resize write settles and cleans up even if reporting fails', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    display.invokeParentFrame.mockResolvedValueOnce({width: 400, height: 300, valid: true});
    await initialize(context);
    const failure = new Error('Resize transport failed');
    display.invokeParentFrame.mockRejectedValue(failure);
    display.onError.mockImplementation(() => { throw new Error('Reporting failed'); });
    await expect(resizer._updateFrameSize(120, 130)).resolves.toBeUndefined();
    expect(resizer._token).toBeNull();
    expect(root.dataset.isResizing).toBeUndefined();
    expect(display.onError).toHaveBeenCalledWith(failure);
});

test('a failed old write cannot stop or report into the next gesture', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    display.invokeParentFrame.mockResolvedValueOnce({width: 400, height: 300, valid: true});
    await initialize(context);
    const write = Promise.withResolvers();
    display.invokeParentFrame.mockReturnValueOnce(write.promise);
    const oldWrite = resizer._updateFrameSize(120, 130);
    resizer._stopFrameResize();
    display.invokeParentFrame.mockResolvedValueOnce({width: 500, height: 350, valid: true});
    await initialize(context);
    const current = resizer._token;
    write.reject(new Error('Old write failed'));
    await expect(oldWrite).resolves.toBeUndefined();
    expect(resizer._token).toBe(current);
    expect(root.dataset.isResizing).toBe('true');
    expect(display.onError).not.toHaveBeenCalled();
});

test('a failed old size read cannot stop the next gesture', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    const read = Promise.withResolvers();
    display.invokeParentFrame.mockReturnValueOnce(read.promise);
    const oldRead = initialize(context);
    resizer._stopFrameResize();
    display.invokeParentFrame.mockResolvedValueOnce({width: 500, height: 350, valid: true});
    await initialize(context);
    const current = resizer._token;
    read.reject(new Error('Old size read failed'));
    await expect(oldRead).resolves.toBeUndefined();
    expect(resizer._token).toBe(current);
    expect(resizer._startSize).toEqual({width: 500, height: 350});
    expect(root.dataset.isResizing).toBe('true');
    expect(display.onError).not.toHaveBeenCalled();
});

test('an unsuccessful size write ends only its own gesture', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    display.invokeParentFrame.mockResolvedValueOnce({width: 400, height: 300, valid: true});
    await initialize(context);
    display.invokeParentFrame.mockResolvedValueOnce(false);
    await resizer._updateFrameSize(120, 130);
    expect(resizer._token).toBeNull();
    expect(root.dataset.isResizing).toBeUndefined();
    expect(display.onError).not.toHaveBeenCalled();
});

test('a gesture without a parent popup releases resize state', async () => {
    const context = setup();
    const {resizer, display, root} = context;
    display.parentPopupId = /** @type {typeof display.parentPopupId} */ (/** @type {unknown} */ (null));
    await initialize(context);
    expect(resizer._token).toBeNull();
    expect(root.dataset.isResizing).toBeUndefined();
    expect(display.invokeParentFrame).not.toHaveBeenCalled();
});
