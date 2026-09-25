/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {RequestBuilder} from '../../ext/js/background/request-builder.js'

for (const {name, input, expected} of [
    {name: 'escaped path separator', input: 'https://example.com/a%2Fb.mp3', expected: 'https://example.com/a%2Fb.mp3'},
    {name: 'escaped query delimiters', input: 'https://example.com/audio?term=a%26b%3Dc', expected: 'https://example.com/audio?term=a%26b%3Dc'},
    {name: 'escaped fragment marker', input: 'https://example.com/audio?term=a%23b', expected: 'https://example.com/audio?term=a%23b'},
    {name: 'escaped question mark in path', input: 'https://example.com/a%3Fb.mp3', expected: 'https://example.com/a%3Fb.mp3'},
    {name: 'escaped plus in query', input: 'https://example.com/audio?term=a%2Bb', expected: 'https://example.com/audio?term=a%2Bb'},
    {name: 'escaped space retains case', input: 'https://example.com/a%20b.mp3?q=%2f', expected: 'https://example.com/a%20b.mp3?q=%2f'},
    {name: 'escaped unreserved byte retains spelling', input: 'https://example.com/%61udio?q=%7e', expected: 'https://example.com/%61udio?q=%7e'},
    {name: 'non-UTF8 percent byte', input: 'https://example.com/%FF.mp3', expected: 'https://example.com/%FF.mp3'},
    {name: 'literal percent sign', input: 'https://example.com/100%.mp3', expected: 'https://example.com/100%.mp3'},
    {name: 'Unicode hostname and path', input: 'https://例え.jp/音声.mp3', expected: 'https://xn--r8jz45g.jp/%E9%9F%B3%E5%A3%B0.mp3'},
    {name: 'canonical host and default port', input: 'HTTPS://EXAMPLE.COM:443/audio', expected: 'https://example.com/audio'},
    {name: 'absent path becomes slash', input: 'https://example.com', expected: 'https://example.com/'},
    {name: 'fragment is not a network selector', input: 'https://example.com/audio#preview', expected: 'https://example.com/audio'},
    {name: 'escaped hash survives real fragment removal', input: 'https://example.com/a%23b#preview', expected: 'https://example.com/a%23b'},
    {name: 'ordinary URL control', input: 'https://example.com/audio?term=cat&reading=cat', expected: 'https://example.com/audio?term=cat&reading=cat'},
    {name: 'double-escaped bytes control', input: 'https://example.com/audio?term=%252F', expected: 'https://example.com/audio?term=%252F'},
    {name: 'IPv6 nondefault port control', input: 'http://[::1]:8765/audio', expected: 'http://[::1]:8765/audio'},
]) {
    test(`anonymous request preserves network URL: ${name}`, async (context) => {
        const builder = new RequestBuilder()
        const operations = context.mock.method(builder, '_updateSessionRules', async () => {})
        const response = new Response('ok')
        const request = context.mock.method(globalThis, 'fetch', async () => response)
        const init = {method: 'GET', credentials: /** @type {RequestCredentials} */ ('omit')}
        assert.equal(await builder.fetchAnonymous(input, init), response)
        assert.equal(request.mock.callCount(), 1)
        assert.equal(request.mock.calls[0].arguments[0], expected)
        assert.equal(request.mock.calls[0].arguments[1], init)
        const [registration, cleanup] = operations.mock.calls
        const rule = registration.arguments[0].addRules?.[0]
        assert.ok(rule)
        assert.equal(rule.condition.urlFilter, `|${expected}|`)
        assert.equal(rule.action.requestHeaders?.find(({header}) => header === 'Origin')?.value, new URL(expected).origin)
        assert.deepEqual(cleanup.arguments[0], {removeRuleIds: [rule.id]})
        assert.equal(builder._ruleIds.size, 0)
    })
}

test('failed fetch still removes its rule and releases the rule identifier', async (context) => {
    const builder = new RequestBuilder()
    const operations = context.mock.method(builder, '_updateSessionRules', async () => {})
    const error = new Error('Network failed')
    context.mock.method(globalThis, 'fetch', async () => { throw error })
    await assert.rejects(builder.fetchAnonymous('https://example.com/audio', {}), (value) => value === error)
    assert.equal(operations.mock.callCount(), 2)
    assert.deepEqual(operations.mock.calls[1].arguments[0], {removeRuleIds: [1]})
    assert.equal(builder._ruleIds.size, 0)
})

test('invalid URLs fail before installing rules or fetching', async (context) => {
    const builder = new RequestBuilder()
    const operations = context.mock.method(builder, '_updateSessionRules', async () => {})
    const request = context.mock.method(globalThis, 'fetch', async () => new Response())
    await assert.rejects(builder.fetchAnonymous('not a URL', {}), TypeError)
    assert.equal(operations.mock.callCount(), 0)
    assert.equal(request.mock.callCount(), 0)
    assert.equal(builder._ruleIds.size, 0)
})

test('real HTTP server receives escaped path and query bytes unchanged', async (context) => {
    /** @type {string[]} */
    const received = []
    const server = createServer((request, response) => {
        received.push(request.url ?? '')
        response.end('ok')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
        const address = server.address()
        if (address === null || typeof address === 'string') { throw new Error('No HTTP server address') }
        const builder = new RequestBuilder()
        context.mock.method(builder, '_updateSessionRules', async () => {})
        const path = '/a%2Fb%3Fc%23d?term=A%26B%3DC%2BD&sig=%7e%2f'
        const response = await builder.fetchAnonymous(`http://127.0.0.1:${address.port}${path}#preview`, {})
        assert.equal(await response.text(), 'ok')
        assert.deepEqual(received, [path])
    } finally {
        const closed = once(server, 'close')
        server.closeAllConnections()
        server.close()
        await closed
    }
})
