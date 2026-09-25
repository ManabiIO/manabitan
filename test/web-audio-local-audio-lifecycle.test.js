/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'vitest'
import {WebAudioLocalAudio} from '../ext/js/media/web-audio-local-audio.js'

/** @returns {{promise: Promise<void>, resolve: () => void, reject: (error: Error) => void}} */
function deferred() {
    /** @type {() => void} */
    let resolve = () => { throw new Error('Uninitialized deferred') }
    /** @type {(error: Error) => void} */
    let reject = () => { throw new Error('Uninitialized deferred') }
    /** @type {Promise<void>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2
        reject = reject2
    })
    return {promise, resolve, reject}
}

class FakeSource {
    constructor() {
        /** @type {unknown} */
        this.buffer = null
        /** @type {(() => void)|null} */
        this.onended = null
        this.connected = false
        this.disconnects = 0
        this.stops = 0
        /** @type {number[][]} */
        this.starts = []
    }

    /** @returns {void} */
    connect() {
        if (context.failAt === 'source-connect') { throw failure }
        this.connected = true
    }

    /** @returns {void} */
    disconnect() {
        this.connected = false
        ++this.disconnects
    }

    /**
     * @param {number} when
     * @param {number} offset
     */
    start(when, offset) {
        if (context.failAt === 'start') { throw failure }
        this.starts.push([when, offset])
    }

    /** @returns {void} */
    stop() {
        ++this.stops
        if (this.starts.length === 0) { throw new Error('Source has not started') }
    }
}

class FakeGain {
    constructor() {
        this.gain = {value: 1}
        this.connected = false
        this.disconnects = 0
    }

    /** @returns {void} */
    connect() {
        if (context.failAt === 'gain-connect') { throw failure }
        this.connected = true
    }

    /** @returns {void} */
    disconnect() {
        this.connected = false
        ++this.disconnects
    }
}

class FakeAudioContext {
    constructor() {
        context = this
        /** @type {string} */
        this.state = 'running'
        this.destination = {}
        /** @type {FakeSource[]} */
        this.sources = []
        /** @type {FakeGain[]} */
        this.gains = []
        /** @type {ReturnType<typeof deferred>[]} */
        this.resumes = []
        /** @type {string|null} */
        this.failAt = null
        /** @type {number[]} */
        this.decodedBytes = []
    }

    /**
     * @param {ArrayBuffer} bytes
     * @returns {Promise<{duration: number}>}
     */
    async decodeAudioData(bytes) {
        this.decodedBytes = [...new Uint8Array(bytes)]
        return {duration: 2}
    }

    /** @returns {Promise<void>} */
    resume() {
        const pending = deferred()
        this.resumes.push(pending)
        return pending.promise
    }

    /** @returns {FakeSource} */
    createBufferSource() {
        const source = new FakeSource()
        this.sources.push(source)
        return source
    }

    /** @returns {FakeGain} */
    createGain() {
        if (this.failAt === 'create-gain') { throw failure }
        const gain = new FakeGain()
        this.gains.push(gain)
        return gain
    }
}

const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
/** @type {FakeAudioContext} */
let context
const failure = new Error('Injected audio setup failure')

beforeEach(() => {
    Object.defineProperty(globalThis, 'AudioContext', {value: FakeAudioContext, configurable: true})
})

afterEach(() => {
    context.state = 'closed'
    if (originalAudioContext) {
        Object.defineProperty(globalThis, 'AudioContext', originalAudioContext)
    } else {
        Reflect.deleteProperty(globalThis, 'AudioContext')
    }
})

/** @returns {Promise<WebAudioLocalAudio>} */
async function preparedAudio() {
    const audio = new WebAudioLocalAudio('AQID', 'audio/wav')
    await audio.prepare()
    return audio
}

test('pause cancels playback waiting for a suspended context to resume', async () => {
    const audio = await preparedAudio()
    context.state = 'suspended'
    const playing = audio.play()
    audio.pause()
    context.state = 'running'
    context.resumes[0].resolve()
    await playing
    assert.equal(context.sources.length, 0)
    assert.equal(context.gains.length, 0)
})

test('an older resume completion cannot replace newer playback', async () => {
    const audio = await preparedAudio()
    context.state = 'suspended'
    const first = audio.play()
    const second = audio.play()
    context.state = 'running'
    context.resumes[1].resolve()
    await second
    const source = context.sources[0]
    context.resumes[0].resolve()
    await first
    assert.equal(context.sources.length, 1)
    assert.equal(source.stops, 0)
    assert.equal(audio._bufferSource, source)
    audio.pause()
})

test('same-order overlapping resume completions create only the latest source', async () => {
    const audio = await preparedAudio()
    context.state = 'suspended'
    const first = audio.play()
    const second = audio.play()
    context.state = 'running'
    context.resumes[0].resolve()
    context.resumes[1].resolve()
    await Promise.all([first, second])
    assert.equal(context.sources.length, 1)
    audio.pause()
})

test('an obsolete resume rejection propagates without stopping the newer source', async () => {
    const audio = await preparedAudio()
    context.state = 'suspended'
    const first = audio.play()
    const rejected = assert.rejects(first, failure)
    const second = audio.play()
    context.state = 'running'
    context.resumes[1].resolve()
    await second
    const source = context.sources[0]
    context.resumes[0].reject(failure)
    await rejected
    assert.equal(audio._bufferSource, source)
    assert.equal(source.stops, 0)
    audio.pause()
})

test('normal playback retains decoded bytes, duration, volume and requested offset', async () => {
    const audio = await preparedAudio()
    audio.volume = 0.4
    audio.currentTime = 0.25
    await audio.play()
    assert.deepEqual(context.decodedBytes, [1, 2, 3])
    assert.equal(audio.duration, 2)
    assert.deepEqual(context.sources[0].starts, [[0, 0.25]])
    assert.equal(context.gains[0].gain.value, 0.4)
    audio.volume = 0.7
    assert.equal(context.gains[0].gain.value, 0.7)
    audio.pause()
})

test('pause stops and disconnects both nodes exactly once', async () => {
    const audio = await preparedAudio()
    await audio.play()
    const source = context.sources[0]
    const gain = context.gains[0]
    audio.pause()
    audio.pause()
    assert.equal(source.stops, 1)
    assert.equal(source.disconnects, 1)
    assert.equal(gain.disconnects, 1)
    assert.equal(source.onended, null)
    assert.equal(audio._bufferSource, null)
    assert.equal(audio._gainNode, null)
})

test('natural completion releases the source and gain', async () => {
    const audio = await preparedAudio()
    await audio.play()
    context.sources[0].onended?.()
    assert.equal(audio._bufferSource, null)
    assert.equal(audio._gainNode, null)
    assert.equal(context.sources[0].disconnects, 1)
    assert.equal(context.gains[0].disconnects, 1)
})

test('an ended callback from replaced playback cannot stop its successor', async () => {
    const audio = await preparedAudio()
    await audio.play()
    const ended = context.sources[0].onended
    assert.equal(typeof ended, 'function')
    await audio.play()
    const source = context.sources[1]
    ended?.()
    assert.equal(audio._bufferSource, source)
    assert.equal(source.stops, 0)
    assert.equal(source.disconnects, 0)
    audio.pause()
})

for (const stage of ['create-gain', 'source-connect', 'gain-connect', 'start']) {
    test(`a ${stage} failure releases every acquired node and remains retryable`, async () => {
        const audio = await preparedAudio()
        context.failAt = stage
        await assert.rejects(audio.play(), failure)
        assert.equal(audio._bufferSource, null)
        assert.equal(audio._gainNode, null)
        for (const source of context.sources) { assert.equal(source.disconnects, 1) }
        for (const gain of context.gains) { assert.equal(gain.disconnects, 1) }
        context.failAt = null
        await audio.play()
        assert.equal(context.sources.at(-1)?.starts.length, 1)
        audio.pause()
    })
}

test('a current resume failure rejects and permits a subsequent successful play', async () => {
    const audio = await preparedAudio()
    context.state = 'suspended'
    const playing = audio.play()
    const rejected = assert.rejects(playing, failure)
    context.resumes[0].reject(failure)
    await rejected
    assert.equal(context.sources.length, 0)
    context.state = 'running'
    await audio.play()
    assert.equal(context.sources.length, 1)
    audio.pause()
})

test('unprepared playback remains a no-op', async () => {
    const audio = new WebAudioLocalAudio('AQID', 'audio/wav')
    await audio.play()
    assert.equal(context.sources.length, 0)
    assert.equal(context.resumes.length, 0)
})
