/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest'
import {createSchema, normalizeContext} from '../ext/js/background/profile-conditions-util.js'

describe('Profile condition duplicate tokens', () => {
    test('repeated domains differing only by case match exactly once', () => {
        const conditionGroups = [{
            conditions: [{
                type: /** @type {const} */ ('url'),
                operator: 'matchDomain',
                value: 'Example.COM, example.com; EXAMPLE.com',
            }],
        }]
        const schema = createSchema(conditionGroups)
        expect(schema.schema).toStrictEqual({
            required: ['domain'],
            properties: {domain: {oneOf: [{const: 'example.com'}]}},
        })
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://example.com/'}))).toBe(true)
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://notexample.com/'}))).toBe(false)
    })

    test('duplicate exact modifier keys neither require extra keys nor match unrelated keys', () => {
        for (const operator of ['are', 'areNot']) {
            const schema = createSchema([{
                conditions: [{
                    type: /** @type {const} */ ('modifierKeys'),
                    operator,
                    value: 'alt, shift, alt',
                }],
            }])
            const exact = operator === 'are'
            expect(schema.isValid(normalizeContext({
                depth: 0,
                url: 'https://example.com/',
                modifierKeys: ['alt', 'shift'],
            }))).toBe(exact)
            expect(schema.isValid(normalizeContext({
                depth: 0,
                url: 'https://example.com/',
                modifierKeys: ['alt', 'ctrl'],
            }))).toBe(!exact)
        }
    })

    test('repeated included flags require only one matching flag', () => {
        const schema = createSchema([{
            conditions: [{
                type: /** @type {const} */ ('flags'),
                operator: 'include',
                value: 'clipboard clipboard, clipboard',
            }],
        }])
        expect(schema.schema).toStrictEqual({
            required: ['flags'],
            properties: {
                flags: {
                    type: 'array',
                    minItems: 1,
                    allOf: [{contains: {const: 'clipboard'}}],
                },
            },
        })
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://example.com/', flags: ['clipboard']}))).toBe(true)
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://example.com/', flags: []}))).toBe(false)
    })

    test('duplicate excluded flags remain excluded', () => {
        const schema = createSchema([{
            conditions: [{
                type: /** @type {const} */ ('flags'),
                operator: 'notInclude',
                value: 'clipboard;clipboard',
            }],
        }])
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://example.com/', flags: []}))).toBe(true)
        expect(schema.isValid(normalizeContext({depth: 0, url: 'https://example.com/', flags: ['clipboard']}))).toBe(false)
    })
})
