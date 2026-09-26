/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, expect, vi} from 'vitest'
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js'
import {createDomTest} from './fixtures/dom-test.js'

const test = createDomTest()
afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {Document} document
 * @returns {{controller: DocumentFocusController, target: HTMLDivElement, input: HTMLInputElement}}
 */
function createController(document) {
    const target = document.createElement('div')
    target.id = 'content-scroll-focus'
    target.tabIndex = -1
    const input = document.createElement('input')
    input.id = 'query'
    document.body.replaceChildren(target, input)
    const controller = new DocumentFocusController('#query')
    return {controller, target, input}
}

test('background initialization does not claim focus', ({window}) => {
    const {controller, target} = createController(window.document)
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(target, 'focus')
    controller.prepare()
    expect(focus).not.toHaveBeenCalled()
})

test('an unfocused document ignores a stale window focus event', ({window}) => {
    const {controller, target} = createController(window.document)
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(target, 'focus')
    controller.prepare()
    target.blur()
    focus.mockClear()
    window.dispatchEvent(new window.Event('focus'))
    expect(focus).not.toHaveBeenCalled()
})

test('a focused document still initializes its scrolling target', ({window}) => {
    const {controller, target} = createController(window.document)
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    controller.prepare()
    expect(window.document.activeElement).toBe(target)
})

test('a focused editable element is not replaced', ({window}) => {
    const {controller, input} = createController(window.document)
    input.focus()
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    controller.prepare()
    window.dispatchEvent(new window.Event('focus'))
    expect(window.document.activeElement).toBe(input)
})

test('deferred initialization resumes on genuine document activation', ({window}) => {
    const {controller, target} = createController(window.document)
    const hasFocus = vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(target, 'focus')
    controller.prepare()
    expect(focus).not.toHaveBeenCalled()
    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new window.Event('focus'))
    expect(focus).toHaveBeenCalledWith({preventScroll: true})
    expect(window.document.activeElement).toBe(target)
})

test('explicit autofocus remains available for Search initialization', ({window}) => {
    const {controller, input} = createController(window.document)
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    controller.focusElement()
    expect(window.document.activeElement).toBe(input)
})

test('blurring an active control restores scroll focus in the focused document', ({window}) => {
    const {controller, target, input} = createController(window.document)
    input.focus()
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    controller.blurElement(input)
    expect(window.document.activeElement).toBe(target)
})

test('blurring an inactive control does not alter focus', ({window}) => {
    const {controller, target, input} = createController(window.document)
    target.focus()
    const blur = vi.spyOn(input, 'blur')
    controller.blurElement(input)
    expect(blur).not.toHaveBeenCalled()
    expect(window.document.activeElement).toBe(target)
})

test('scroll focus still restores a selection changed by the browser', ({window}) => {
    const {controller, target} = createController(window.document)
    const text = window.document.createTextNode('selected text')
    window.document.body.append(text)
    const range = window.document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 8)
    const selection = window.getSelection()
    if (selection === null) { throw new Error('Missing selection') }
    selection.addRange(range)
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(target, 'focus').mockImplementation(() => { selection.removeAllRanges() })
    controller.prepare()
    expect(selection.toString()).toBe('elected')
    expect(selection.rangeCount).toBe(1)
})
