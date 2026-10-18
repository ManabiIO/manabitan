import net from 'node:net';
import {describe, expect, test} from 'vitest';
import {findWebExtRdpPort, GeckoRdpClient, probeInstalledAddon} from './firefox-android-rdp.js';

/** @typedef {(socket: net.Socket) => void} ConnectionHandler */
/** @typedef {Record<string, unknown>} RdpPacket */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Create a loopback RDP peer and make fixture cleanup destroy accepted sockets too.
 * @param {ConnectionHandler} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
async function createServer(handler) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        handler(socket);
    });
    /** @type {Promise<void>} */
    const listening = new Promise((resolve) => {
        server.listen({port: 0, host: '127.0.0.1'}, () => resolve());
    });
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Missing test TCP server address'); }
    return {
        port: address.port,
        close: () => new Promise((resolve) => {
            for (const socket of sockets) { socket.destroy(); }
            server.close(() => resolve());
        }),
    };
}

/**
 * @param {net.Socket} socket
 * @param {RdpPacket} packet
 */
function send(socket, packet) {
    const bytes = Buffer.from(JSON.stringify(packet));
    socket.write(Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]));
}

/**
 * Split any number of complete length-prefixed frames from arbitrary TCP chunks.
 * @param {Buffer} buffer
 * @param {Buffer} chunk
 * @returns {{buffer: Buffer, packets: RdpPacket[]}}
 */
function takeFrames(buffer, chunk) {
    let rest = Buffer.concat([buffer, chunk]);
    /** @type {RdpPacket[]} */
    const packets = [];
    while (rest.includes(58)) {
        const colon = rest.indexOf(58);
        const length = Number(rest.toString('ascii', 0, colon));
        if (rest.length < colon + 1 + length) { break; }
        packets.push(/** @type {RdpPacket} */ (JSON.parse(rest.toString('utf8', colon + 1, colon + 1 + length))));
        rest = rest.subarray(colon + 1 + length);
    }
    return {buffer: rest, packets};
}

/**
 * @param {net.Socket|undefined} socket
 * @returns {net.Socket}
 */
function requireSocket(socket) {
    if (!socket) { throw new Error('Test server socket was not connected'); }
    return socket;
}

describe('Firefox Android Gecko RDP capability helper', () => {
    test('parses the port announced by web-ext after installation', () => {
        expect(findWebExtRdpPort(['noise', 'You can connect to this Android device on TCP port 43475'])).toBe(43475);
        expect(findWebExtRdpPort(['Installed addon'])).toBeNull();
    });

    test('handles fragmented headers and bodies plus concatenated packets', async () => {
        const fixture = await createServer((socket) => {
            const greeting = Buffer.from(`${Buffer.byteLength('{"from":"root","applicationType":"gecko"}')}:` + '{"from":"root","applicationType":"gecko"}');
            const first = Buffer.from('{"from":"root","type":"one"}');
            const second = Buffer.from('{"from":"root","type":"two"}');
            const frames = Buffer.concat([greeting, Buffer.from(`${first.length}:`), first, Buffer.from(`${second.length}:`), second]);
            socket.write(frames.subarray(0, 1));
            setTimeout(() => socket.write(frames.subarray(1, 5)), 5);
            setTimeout(() => socket.write(frames.subarray(5)), 10);
        });
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port);
            await expect(client.readPacket((packet) => packet.type === 'one')).resolves.toMatchObject({type: 'one'});
            await expect(client.readPacket((packet) => packet.type === 'two')).resolves.toMatchObject({type: 'two'});
        } finally {
            client?.close();
            await fixture.close();
        }
    });

    test('destroys the connected socket when the root greeting times out', async () => {
        let socketClosed = false;
        const fixture = await createServer((socket) => socket.on('close', () => { socketClosed = true; }));
        try {
            await expect(GeckoRdpClient.connect(fixture.port, {timeoutMs: 30})).rejects.toThrow('Timed out waiting for a Gecko RDP packet');
            const deadline = Date.now() + 500;
            while (!socketClosed && Date.now() < deadline) { await delay(5); }
            expect(socketClosed).toBe(true);
        } finally {
            await fixture.close();
        }
    });

    test('retires a timed-out packet waiter so the next waiter receives the packet', async () => {
        /** @type {net.Socket|undefined} */
        let serverSocket;
        const fixture = await createServer((socket) => {
            serverSocket = socket;
            send(socket, {from: 'root', applicationType: 'gecko'});
        });
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port, {timeoutMs: 25});
            await expect(client.readPacket()).rejects.toThrow('Timed out waiting for a Gecko RDP packet');
            send(requireSocket(serverSocket), {from: 'root', type: 'survived-timeout'});
            await expect(client.readPacket()).resolves.toMatchObject({type: 'survived-timeout'});
        } finally {
            client?.close();
            await fixture.close();
        }
    });

    test('close rejects and clears packet waiters when no request is pending', async () => {
        const fixture = await createServer((socket) => send(socket, {from: 'root', applicationType: 'gecko'}));
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port);
            const waiting = client.readPacket();
            client.close();
            await expect(waiting).rejects.toThrow('Gecko RDP client closed');
            expect(client._packetWaiters).toHaveLength(0);
        } finally {
            client?.close();
            await fixture.close();
        }
    });

    test('does not let an actor notification satisfy an outstanding request', async () => {
        /** @type {Buffer} */ let buffer = Buffer.alloc(0);
        const fixture = await createServer((socket) => {
            send(socket, {from: 'root', applicationType: 'gecko'});
            socket.on('data', (chunk) => {
                const frames = takeFrames(buffer, chunk);
                buffer = frames.buffer;
                for (const request of frames.packets) {
                    send(socket, {from: 'root', type: 'tabNavigated', state: 'stop'});
                    send(socket, {from: 'root', addons: [{id: 'fixture@example.test'}]});
                }
            });
        });
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port);
            const response = await client.request('root', 'listAddons', {}, (packet) => Array.isArray(packet.addons));
            expect(response.addons).toHaveLength(1);
            await expect(client.readPacket((packet) => packet.type === 'tabNavigated')).resolves.toMatchObject({type: 'tabNavigated'});
        } finally {
            client?.close();
            await fixture.close();
        }
    });

    test('correlates modern Gecko watcher target and evaluation event before the acknowledgement', async () => {
        /** @type {Buffer} */ let buffer = Buffer.alloc(0);
        const fixture = await createServer((socket) => {
            send(socket, {from: 'root', applicationType: 'gecko'});
            socket.on('data', (chunk) => {
                const frames = takeFrames(buffer, chunk);
                buffer = frames.buffer;
                for (const request of frames.packets) {
                    if (request.type === 'listAddons') { send(socket, {from: 'root', addons: [{id: 'fixture@example.test', actor: 'addon1', traits: {watcher: true}}]}); }
                    if (request.type === 'getWatcher') {
                        expect(request.isServerTargetSwitchingEnabled).toBe(true);
                        send(socket, {from: 'addon1', actor: 'watcher1', traits: {}});
                    }
                    if (request.type === 'watchTargets') {
                        send(socket, {from: 'watcher1', type: 'target-available-form', target: {actor: 'fallback', addonId: 'fixture@example.test', isFallbackExtensionDocument: true, url: 'chrome://extensions/content/dummy.html'}});
                        send(socket, {from: 'watcher1', type: 'target-available-form', target: {actor: 'target1', addonId: 'fixture@example.test', isFallbackExtensionDocument: false, url: 'moz-extension://fixture/background.html', consoleActor: 'console1'}});
                        send(socket, {from: 'watcher1'});
                    }
                    if (request.type === 'evaluateJSAsync') {
                        const resultID = 'evaluation-17';
                        send(socket, {from: 'console1', type: 'evaluationResult', resultID, result: {type: 'string', value: '{"runtimeId":"fixture@example.test","hasExtensionRuntime":true}'}, hasException: false});
                        send(socket, {from: 'console1', resultID});
                    }
                }
            });
        });
        /** @type {string[]} */
        const capabilities = [];
        try {
            const result = await probeInstalledAddon(fixture.port, 'fixture@example.test', (capability) => capabilities.push(capability), undefined, undefined, 60_000);
            expect(result).toMatchObject({
                watcherResponse: {actor: 'watcher1'},
                targetActor: 'target1',
                evidence: {runtimeQualificationTimeoutMs: 60_000,
                    targetForms: [
                        {actor: 'fallback', isFallbackExtensionDocument: true},
                        {actor: 'target1', isFallbackExtensionDocument: false},
                    ]},
                consoleActor: 'console1',
                evaluation: {acknowledgement: {resultID: 'evaluation-17'}, result: {type: 'evaluationResult', resultID: 'evaluation-17', hasException: false}},
            });
            expect(capabilities).toEqual(['gecko-rdp-list-addons', 'gecko-rdp-addon-get-watcher', 'gecko-rdp-watcher-watch-targets', 'gecko-rdp-watcher-extension-target-available', 'gecko-rdp-evaluate-extension-context-result']);
        } finally {
            await fixture.close();
        }
    });

    test('waits for an evaluation event arriving after the acknowledgement and retains wrong result IDs', async () => {
        /** @type {Buffer} */ let buffer = Buffer.alloc(0);
        /** @type {net.Socket|undefined} */ let serverSocket;
        const fixture = await createServer((socket) => {
            serverSocket = socket;
            send(socket, {from: 'root', applicationType: 'gecko'});
            socket.on('data', (chunk) => {
                const frames = takeFrames(buffer, chunk);
                buffer = frames.buffer;
                for (const request of frames.packets) {
                    if (request.type === 'evaluateJSAsync') { send(socket, {from: 'console1', resultID: 'right-id'}); }
                }
            });
        });
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port);
            const wrongEvent = {from: 'console1', type: 'evaluationResult', resultID: 'wrong-id'};
            const rightEvent = {from: 'console1', type: 'evaluationResult', resultID: 'right-id'};
            send(requireSocket(serverSocket), wrongEvent);
            const acknowledgement = await client.request('console1', 'evaluateJSAsync', {text: '1'}, (packet) => typeof packet.resultID === 'string');
            send(requireSocket(serverSocket), rightEvent);
            await expect(client.readPacket((packet) => packet.from === 'console1' && packet.type === 'evaluationResult' && packet.resultID === acknowledgement.resultID)).resolves.toMatchObject(rightEvent);
            await expect(client.readPacket((packet) => packet.resultID === 'wrong-id')).resolves.toMatchObject(wrongEvent);
        } finally {
            client?.close();
            await fixture.close();
        }
    });

    test('rejects overlapping untagged requests to the same actor', async () => {
        const fixture = await createServer((socket) => send(socket, {from: 'root', applicationType: 'gecko'}));
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port);
            const first = client.request('root', 'first');
            await expect(client.request('root', 'second')).rejects.toThrow('A Gecko RDP request is already pending for actor root');
            client.close();
            await expect(first).rejects.toThrow('Gecko RDP client closed');
        } finally {
            client?.close();
            await fixture.close();
        }
    });

    test('preserves listAddons actor errors instead of timing out', async () => {
        /** @type {Buffer} */ let buffer = Buffer.alloc(0);
        const fixture = await createServer((socket) => {
            send(socket, {from: 'root', applicationType: 'gecko'});
            socket.on('data', (chunk) => {
                const frames = takeFrames(buffer, chunk);
                buffer = frames.buffer;
                for (const request of frames.packets) {
                    if (request.type === 'listAddons') { send(socket, {from: 'root', error: 'noSuchActor', message: 'root request rejected'}); }
                }
            });
        });
        try {
            /** @type {unknown} */ let caught;
            try {
                await probeInstalledAddon(fixture.port, 'fixture@example.test');
            } catch (error) {
                caught = error;
            }
            expect(caught).toMatchObject({name: 'GeckoRdpProtocolError', packet: {error: 'noSuchActor'}, evidence: {stage: 'listAddons'}});
            const errorEvidence = /** @type {{evidence: {packets: {direction: string, packet: RdpPacket}[]}}} */ (caught);
            expect(errorEvidence.evidence.packets.map(({direction, packet}) => [direction, packet.type ?? packet.from])).toContainEqual(['received', 'root']);
        } finally {
            await fixture.close();
        }
    });

    test('preserves legacy getTarget actor errors instead of treating them as absent targets', async () => {
        /** @type {Buffer} */ let buffer = Buffer.alloc(0);
        const fixture = await createServer((socket) => {
            send(socket, {from: 'root', applicationType: 'gecko'});
            socket.on('data', (chunk) => {
                const frames = takeFrames(buffer, chunk);
                buffer = frames.buffer;
                for (const request of frames.packets) {
                    if (request.type === 'listAddons') { send(socket, {from: 'root', addons: [{id: 'fixture@example.test', actor: 'addon1'}]}); }
                    if (request.type === 'getTarget') { send(socket, {from: 'addon1', error: 'noSuchActor', message: 'actor was destroyed'}); }
                }
            });
        });
        try {
            await expect(probeInstalledAddon(fixture.port, 'fixture@example.test')).rejects.toMatchObject({
                name: 'GeckoRdpProtocolError',
                packet: {error: 'noSuchActor', message: 'actor was destroyed'},
            });
        } finally {
            await fixture.close();
        }
    });

    test('preserves evaluateJSAsync actor errors after modern watcher discovery', async () => {
        /** @type {Buffer} */ let buffer = Buffer.alloc(0);
        const fixture = await createServer((socket) => {
            send(socket, {from: 'root', applicationType: 'gecko'});
            socket.on('data', (chunk) => {
                const frames = takeFrames(buffer, chunk);
                buffer = frames.buffer;
                for (const request of frames.packets) {
                    if (request.type === 'listAddons') { send(socket, {from: 'root', addons: [{id: 'fixture@example.test', actor: 'addon1', traits: {watcher: true}}]}); }
                    if (request.type === 'getWatcher') { send(socket, {from: 'addon1', actor: 'watcher1', traits: {}}); }
                    if (request.type === 'watchTargets') {
                        send(socket, {from: 'watcher1', type: 'target-available-form', target: {actor: 'target1', addonId: 'fixture@example.test', isFallbackExtensionDocument: false, url: 'moz-extension://fixture/background.html', consoleActor: 'console1'}});
                        send(socket, {from: 'watcher1'});
                    }
                    if (request.type === 'evaluateJSAsync') { send(socket, {from: 'console1', error: 'noSuchActor', message: 'console actor unavailable'}); }
                }
            });
        });
        try {
            await expect(probeInstalledAddon(fixture.port, 'fixture@example.test')).rejects.toMatchObject({
                name: 'GeckoRdpProtocolError',
                packet: {error: 'noSuchActor', message: 'console actor unavailable'},
            });
        } finally {
            await fixture.close();
        }
    });

    test('rejects oversized framing headers and rejects outstanding waiters', async () => {
        /** @type {net.Socket|undefined} */ let serverSocket;
        const fixture = await createServer((socket) => {
            serverSocket = socket;
            send(socket, {from: 'root', applicationType: 'gecko'});
        });
        /** @type {GeckoRdpClient|undefined} */
        let client;
        try {
            client = await GeckoRdpClient.connect(fixture.port);
            const waiting = client.readPacket();
            requireSocket(serverSocket).write(Buffer.from('12345678901234567890'));
            await expect(waiting).rejects.toThrow('Invalid or oversized Gecko RDP packet header');
        } finally {
            client?.close();
            await fixture.close();
        }
    });
});
