/*
 * Copyright (C) 2026  Yomitan Authors
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

for (const complete of [false, true]) {
    test(`real HTTP body ownership: ${complete ? 'completion' : 'observer failure'}`, {timeout: 5000}, async () => {
        const original = new Error('stop consuming this download')
        let requests = 0
        /** @type {() => void} */
        let onBodyClosed = () => {}
        const bodyClosed = new Promise((resolve) => { onBodyClosed = () => resolve(void 0) })
        const expected = Uint8Array.from([1, 2, 3, 4])
        const server = createServer((_request, response) => {
            ++requests
            response.once('close', onBodyClosed)
            response.writeHead(200, {'Content-Type': 'application/octet-stream'})
            response.write(expected)
            if (complete) { response.end() }
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        try {
            const address = server.address()
            if (address === null || typeof address === 'string') { throw new Error('Missing server address') }
            const response = await fetch(`http://127.0.0.1:${address.port}/body`)
            const body = response.body
            assert.ok(body)
            if (complete) {
                const actual = await RequestBuilder.readFetchResponseArrayBuffer(response, () => {})
                assert.deepEqual(actual, expected)
            } else {
                await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(response, () => { throw original }), (error) => error === original)
            }
            assert.equal(body.locked, false)
            // The incomplete endpoint never ends itself. This can complete only
            // when the consumer cancels, not through the test's cleanup below.
            /** @type {ReturnType<typeof setTimeout>|undefined} */
            let timer
            try {
                await Promise.race([
                    bodyClosed,
                    new Promise((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Response body did not close')), 2000)
                    }),
                ])
            } finally {
                clearTimeout(timer)
            }
            assert.equal(requests, 1)
        } finally {
            const closed = once(server, 'close')
            server.closeAllConnections()
            server.close()
            await closed
        }
    })
}
