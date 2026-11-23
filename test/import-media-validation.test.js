/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, describe, expect, test} from 'vitest'
import {verifyBenchmarkMedia} from '../dev/perf/import-media-validation.js'

/** @type {string[]} */
const directories = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map(async (dir) => await rm(dir, {recursive: true, force: true})))
})

/**
 * @param {number} [count]
 * @returns {Promise<{
 *   archivePath: string,
 *   fixture: {expectedTitle: string, mediaFiles: number, mediaBytes: number},
 *   readMedia: (paths: string[]) => Promise<{dictionary: string, path: string, content: string}[]>,
 *   calls: string[][],
 * }>}
 */
async function setup(count = 3) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'manabitan-media-oracle-'))
    directories.push(directory)
    const writer = new ZipWriter(new Uint8ArrayWriter())
    /** @type {Map<string, Buffer>} */
    const images = new Map()
    for (let i = 0; i < count; ++i) {
        const name = `images/${String(i).padStart(4, '0')}.png`
        const bytes = Buffer.from(`image bytes ${i}`)
        images.set(name, bytes)
        await writer.add(name, new Uint8ArrayReader(bytes), {level: i % 2 === 0 ? 0 : 6, useWebWorkers: false})
    }
    await writer.add('index.json', new Uint8ArrayReader(Buffer.from('{}')), {useWebWorkers: false})
    const archivePath = path.join(directory, 'dictionary.zip')
    await writeFile(archivePath, await writer.close())
    const fixture = {expectedTitle: 'Image fixture', mediaFiles: count, mediaBytes: [...images.values()].reduce((sum, bytes) => sum + bytes.length, 0)}
    /** @type {string[][]} */
    const calls = []
    const readMedia = async (/** @type {string[]} */ paths) => {
        calls.push(paths)
        return paths.map((mediaPath) => ({dictionary: fixture.expectedTitle, path: mediaPath, content: images.get(mediaPath)?.toString('base64') ?? ''}))
    }
    return {archivePath, fixture, readMedia, calls}
}

describe('complete import media verification', () => {
    test('checks stored and DEFLATE image bytes by identity regardless of response order', async () => {
        const {archivePath, fixture, readMedia} = await setup()
        const ordered = await verifyBenchmarkMedia(archivePath, fixture, readMedia)
        const reversed = await verifyBenchmarkMedia(archivePath, fixture, async (paths) => (await readMedia(paths)).reverse())
        expect(ordered).toEqual(reversed)
        expect(ordered).toMatchObject({mode: 'all', totalFiles: 3, totalBytes: fixture.mediaBytes, files: 3, bytes: fixture.mediaBytes, sha256: expect.stringMatching(/^[a-f0-9]{64}$/)})
    })

    test.each(['missing', 'duplicate', 'wrong dictionary', 'changed bytes'])('rejects %s persisted images', async (fault) => {
        const {archivePath, fixture, readMedia} = await setup()
        await expect(verifyBenchmarkMedia(archivePath, fixture, async (paths) => {
            const result = await readMedia(paths)
            if (fault === 'missing') { result.pop() }
            if (fault === 'duplicate') { result[1] = result[0] }
            if (fault === 'wrong dictionary') { result[0].dictionary = 'Another dictionary' }
            if (fault === 'changed bytes') { result[0].content = Buffer.from('Image bytes 0').toString('base64') }
            return result
        })).rejects.toThrow()
    })

    test('bounds requests and checks every image for a large media manifest', async () => {
        const {archivePath, fixture, readMedia, calls} = await setup(257)
        const result = await verifyBenchmarkMedia(archivePath, fixture, readMedia)
        expect(calls.map((paths) => paths.length)).toEqual([256, 1])
        expect(result.files).toBe(257)
        expect(result.bytes).toBe(fixture.mediaBytes)
    })

    test('marks sampled evidence and spans the complete manifest', async () => {
        const {archivePath, fixture, readMedia, calls} = await setup(70)
        const result = await verifyBenchmarkMedia(archivePath, fixture, readMedia, 'sample')
        expect(result).toMatchObject({mode: 'sample', totalFiles: 70, totalBytes: fixture.mediaBytes, files: 64})
        expect(result.bytes).toBeLessThan(fixture.mediaBytes)
        expect(calls[0][0]).toBe('images/0000.png')
        expect(calls[0].at(-1)).toBe('images/0069.png')
    })

    test('rejects an incomplete source archive before querying installed data', async () => {
        const {archivePath, fixture, readMedia, calls} = await setup()
        await expect(verifyBenchmarkMedia(archivePath, {...fixture, mediaFiles: 4}, readMedia)).rejects.toThrow('image count')
        expect(calls).toEqual([])
    })

    test('excludes only explicitly pinned unused images and verifies every other payload', async () => {
        const {archivePath, fixture, readMedia, calls} = await setup()
        const referenced = {...fixture, mediaFiles: 2, mediaBytes: fixture.mediaBytes - Buffer.byteLength('image bytes 1'), unreferencedMediaPaths: ['images/0001.png']}
        await expect(verifyBenchmarkMedia(archivePath, referenced, readMedia)).resolves.toMatchObject({mode: 'all', totalFiles: 2, totalBytes: referenced.mediaBytes, files: 2, bytes: referenced.mediaBytes})
        expect(calls).toEqual([['images/0000.png', 'images/0002.png']])

        await expect(verifyBenchmarkMedia(archivePath, {...referenced, unreferencedMediaPaths: []}, readMedia)).rejects.toThrow('image count')
        await expect(verifyBenchmarkMedia(archivePath, {...referenced, mediaBytes: fixture.mediaBytes}, readMedia)).rejects.toThrow('Referenced image bytes')
        await expect(verifyBenchmarkMedia(archivePath, referenced, async (paths) => (await readMedia(paths)).slice(0, 1))).rejects.toThrow('response count')
    })

    test.each([
        {paths: ['images/missing.png'], message: 'absent from archive'},
        {paths: ['index.json'], message: 'absent from archive'},
        {paths: ['images/0001.png', 'images/0001.png'], message: 'Duplicate unreferenced'},
        {paths: [''], message: 'Invalid unreferenced'},
    ])('rejects an invalid unused-image allowlist: $paths', async ({paths, message}) => {
        const {archivePath, fixture, readMedia, calls} = await setup()
        await expect(verifyBenchmarkMedia(archivePath, {...fixture, unreferencedMediaPaths: paths}, readMedia)).rejects.toThrow(message)
        expect(calls).toEqual([])
    })

    test('records zero image bytes without requesting unrelated media', async () => {
        const {archivePath, fixture, readMedia, calls} = await setup(0)
        expect(await verifyBenchmarkMedia(archivePath, fixture, readMedia)).toMatchObject({files: 0, bytes: 0})
        expect(calls).toEqual([])
    })
})
