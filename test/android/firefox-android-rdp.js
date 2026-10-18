import net from 'node:net';

const defaultTimeoutMs = 5_000;
const maximumHeaderBytes = 16;
const maximumPacketBytes = 16 * 1024 * 1024;

/** @typedef {Record<string, unknown>} RdpPacket */
/** @typedef {(packet: RdpPacket) => boolean} PacketPredicate */
/** @typedef {{resolve: (packet: RdpPacket) => void, reject: (error: Error) => void, predicate: PacketPredicate, timeout: NodeJS.Timeout}} PacketWaiter */
/** @typedef {{actor: string, resolve: (packet: RdpPacket) => void, reject: (error: Error) => void, predicate: PacketPredicate, timeout: NodeJS.Timeout}} PendingRequest */
/** @typedef {{extensionId: string, stage: string, packets: {direction: string, packet: RdpPacket}[], targetForms: RdpPacket[], selectedTarget: RdpPacket|null, requests: {stage: string, packet: RdpPacket}[], [key: string]: unknown}} ProbeEvidence */

/** An RDP error response is a failed command, not a successful empty result. */
export class GeckoRdpProtocolError extends Error {
    /**
     * @param {string} actor
     * @param {RdpPacket} packet
     */
    constructor(actor, packet) {
        super(`Gecko RDP ${actor} request failed: ${String(packet.error)}${typeof packet.message === 'string' ? `: ${packet.message}` : ''}`);
        this.name = 'GeckoRdpProtocolError';
        this.actor = actor;
        this.packet = packet;
    }
}

/**
 * Minimal Gecko Remote Debugging Protocol client for the post-ACK web-ext tunnel.
 * @implements {AsyncDisposable}
 */
export class GeckoRdpClient {
    /**
     * @param {net.Socket} socket
     * @param {{timeoutMs?: number, onPacket?: (direction: 'sent'|'received', packet: RdpPacket) => void}} [options]
     */
    constructor(socket, {timeoutMs = defaultTimeoutMs, onPacket = () => {}} = {}) {
        this._socket = socket;
        this._timeoutMs = timeoutMs;
        this._onPacket = onPacket;
        /** @type {Buffer} */
        this._buffer = Buffer.alloc(0);
        /** @type {RdpPacket[]} */
        this._packets = [];
        /** @type {PacketWaiter[]} */
        this._packetWaiters = [];
        /** @type {PendingRequest[]} */
        this._pending = [];
        this._closed = false;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (error) => this._failAll(error));
        socket.on('close', () => this._failAll(new Error('Gecko RDP socket closed')));
    }

    /**
     * @param {number} port
     * @param {{timeoutMs?: number, onPacket?: (direction: 'sent'|'received', packet: RdpPacket) => void}} [options]
     * @returns {Promise<GeckoRdpClient>}
     */
    static async connect(port, options = {}) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error(`Invalid Gecko RDP port: ${String(port)}`); }
        const socket = net.createConnection({host: '127.0.0.1', port});
        const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
        try {
            /** @type {Promise<void>} */
            const connected = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Timed out connecting to Gecko RDP port ${port}`)), timeoutMs);
                socket.once('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                socket.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });
            await connected;
            const client = new GeckoRdpClient(socket, options);
            const greeting = await client.readPacket();
            if (greeting.from !== 'root' || isProtocolError(greeting)) { throw new Error(`Invalid Gecko RDP root greeting: ${JSON.stringify(greeting)}`); }
            return client;
        } catch (error) {
            socket.destroy();
            throw error;
        }
    }

    /**
     * @param {string} actor
     * @param {string} type
     * @param {Record<string, unknown>} [params]
     * @param {PacketPredicate} [responsePredicate]
     * @returns {Promise<RdpPacket>}
     */
    async request(actor, type, params = {}, responsePredicate = (packet) => packet.from === actor && packet.type === undefined) {
        if (this._closed) { throw new Error('Gecko RDP client is closed'); }
        if (this._pending.some((pending) => pending.actor === actor)) {
            throw new Error(`A Gecko RDP request is already pending for actor ${actor}`);
        }
        const packet = {to: actor, type, ...params};
        this._onPacket('sent', packet);
        const bytes = Buffer.from(JSON.stringify(packet));
        return await new Promise((resolve, reject) => {
            const pending = /** @type {PendingRequest} */ ({actor,
                resolve,
                reject,
                predicate: (response) => response.from === actor && (isProtocolError(response) || (response.type === undefined && responsePredicate(response))),
                timeout: setTimeout(() => {
                    this._removePending(pending);
                    reject(new Error(`Timed out waiting for Gecko RDP ${actor}.${type}`));
                }, this._timeoutMs)});
            this._pending.push(pending);
            this._socket.write(Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]), (error) => {
                if (error) {
                    this._removePending(pending);
                    reject(error);
                }
            });
        }).then((response) => {
            if (isProtocolError(response)) { throw new GeckoRdpProtocolError(actor, response); }
            return response;
        });
    }

    /**
     * Wait for one queued packet matching the predicate. Nonmatching packets remain queued.
     * @param {PacketPredicate} [predicate]
     * @returns {Promise<RdpPacket>}
     */
    readPacket(predicate = () => true) {
        const index = this._packets.findIndex(predicate);
        if (index !== -1) { return Promise.resolve(/** @type {RdpPacket} */ (this._packets.splice(index, 1)[0])); }
        if (this._closed) { return Promise.reject(new Error('Gecko RDP client is closed')); }
        return new Promise((resolve, reject) => {
            /** @type {PacketWaiter} */
            const waiter = {
                resolve,
                reject,
                predicate,
                timeout: setTimeout(() => {
                    const index = this._packetWaiters.indexOf(waiter);
                    if (index !== -1) { this._packetWaiters.splice(index, 1); }
                    reject(new Error('Timed out waiting for a Gecko RDP packet'));
                }, this._timeoutMs),
            };
            this._packetWaiters.push(waiter);
        });
    }

    close() {
        this._failAll(new Error('Gecko RDP client closed'));
        this._socket.destroy();
    }

    /** @returns {Promise<void>} */
    async [Symbol.asyncDispose]() { this.close(); }

    /** @param {Buffer} chunk */
    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        while (true) {
            const colon = this._buffer.indexOf(58);
            if (colon === -1) {
                if (this._buffer.length > maximumHeaderBytes || !/^\d*$/.test(this._buffer.toString('ascii'))) {
                    this._failAll(new Error('Invalid or oversized Gecko RDP packet header'));
                    this._socket.destroy();
                }
                return;
            }
            if (colon < 1 || colon > maximumHeaderBytes) {
                this._failAll(new Error('Invalid or oversized Gecko RDP packet header'));
                this._socket.destroy();
                return;
            }
            const lengthText = this._buffer.toString('ascii', 0, colon);
            if (!/^\d+$/.test(lengthText)) {
                this._failAll(new Error(`Invalid Gecko RDP packet length: ${lengthText}`));
                this._socket.destroy();
                return;
            }
            const length = Number(lengthText);
            if (!Number.isSafeInteger(length) || length < 2 || length > maximumPacketBytes) {
                this._failAll(new Error(`Invalid Gecko RDP packet length: ${lengthText}`));
                this._socket.destroy();
                return;
            }
            if (this._buffer.length < colon + 1 + length) { return; }
            const bytes = this._buffer.subarray(colon + 1, colon + 1 + length);
            this._buffer = this._buffer.subarray(colon + 1 + length);
            let parsed;
            try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
                this._failAll(new Error(`Invalid Gecko RDP JSON: ${error instanceof Error ? error.message : String(error)}`));
                this._socket.destroy();
                return;
            }
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof parsed.from !== 'string') {
                this._failAll(new Error('Malformed Gecko RDP packet: expected an object with a from actor'));
                this._socket.destroy();
                return;
            }
            this._onPacket('received', /** @type {RdpPacket} */ (parsed));
            this._dispatch(/** @type {RdpPacket} */ (parsed));
        }
    }

    /** @param {RdpPacket} packet */
    _dispatch(packet) {
        let pendingIndex = this._pending.findIndex((pending) => packet.from === pending.actor && isProtocolError(packet));
        if (pendingIndex === -1) { pendingIndex = this._pending.findIndex((pending) => pending.predicate(packet)); }
        if (pendingIndex !== -1) {
            const [pending] = this._pending.splice(pendingIndex, 1);
            clearTimeout(pending.timeout);
            pending.resolve(packet);
            return;
        }
        const waiterIndex = this._packetWaiters.findIndex((waiter) => waiter.predicate(packet));
        if (waiterIndex !== -1) {
            const [waiter] = this._packetWaiters.splice(waiterIndex, 1);
            clearTimeout(waiter.timeout);
            waiter.resolve(packet);
            return;
        }
        this._packets.push(packet);
    }

    /** @param {PendingRequest} pending */
    _removePending(pending) {
        const index = this._pending.indexOf(pending);
        if (index !== -1) { this._pending.splice(index, 1); }
        clearTimeout(pending.timeout);
    }

    /** @param {Error} error */
    _failAll(error) {
        this._closed = true;
        for (const pending of this._pending.splice(0)) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        for (const waiter of this._packetWaiters.splice(0)) {
            clearTimeout(waiter.timeout);
            waiter.reject(error);
        }
        this._packets = [];
    }
}

/**
 * @param {RdpPacket} packet
 * @returns {boolean}
 */
function isProtocolError(packet) {
    return packet.error !== undefined && packet.error !== null && packet.error !== false;
}

/**
 * @param {string[]} lines
 * @returns {number|null}
 */
export function findWebExtRdpPort(lines) {
    for (const line of lines) {
        const match = /You can connect to this Android device on TCP port (\d+)/.exec(line);
        if (match) { return Number(match[1]); }
    }
    return null;
}

/**
 * Probe extension actors and evaluate a small runtime identity expression.
 * The returned evidence is discovery/context evidence only.
 * @param {number} port
 * @param {string} extensionId
 * @param {(capability: string) => void} [onCapability]
 * @param {(evidence: ProbeEvidence) => void} [onEvidence]
 * @returns {Promise<RdpPacket>}
 */
export async function probeInstalledAddon(port, extensionId, onCapability = /** @type {(capability: string) => void} */ (() => {}), onEvidence = /** @type {(evidence: ProbeEvidence) => void} */ (() => {})) {
    /** @type {ProbeEvidence} */
    const evidence = {extensionId, stage: 'connect', packets: [], targetForms: [], selectedTarget: null, requests: []};
    const publish = () => onEvidence(JSON.parse(JSON.stringify(evidence)));
    const client = await GeckoRdpClient.connect(port, {onPacket: (direction, packet) => {
        const packetText = JSON.stringify(packet);
        const boundedPacket = packetText.length > 16_384 ? {truncated: true, rawPrefix: packetText.slice(0, 16_384)} : JSON.parse(packetText);
        evidence.packets.push({direction, packet: boundedPacket});
        if (evidence.packets.length > 100) { evidence.packets.shift(); }
        if (direction === 'sent') { evidence.requests.push({stage: evidence.stage, packet: boundedPacket}); }
        if (evidence.requests.length > 50) { evidence.requests.shift(); }
        publish();
    }});
    try {
        evidence.stage = 'listAddons'; publish();
        const response = await client.request('root', 'listAddons', {}, (packet) => packet.from === 'root' && packet.type === undefined && Array.isArray(packet.addons));
        onCapability('gecko-rdp-list-addons');
        const addons = /** @type {RdpPacket[]} */ (response.addons);
        const addon = addons.find((entry) => entry.id === extensionId);
        evidence.addon = addon ?? null; publish();
        if (!addon || typeof addon.actor !== 'string') {
            throw new Error(`Gecko RDP listAddons did not expose extension ${extensionId}; addonIds=${JSON.stringify(addons.map((entry) => entry.id ?? null))}`);
        }
        let descriptorResponse = null;
        let watcherResponse = null;
        let watchTargetsResponse = null;
        let targetEvent = null;
        let targetForm = null;
        let targetActor = null;
        let legacyTargetResponse = null;
        let attachResponse = null;
        const addonTraits = isRecord(addon.traits) ? addon.traits : {};
        const legacyPath = addonTraits.watcher !== true;
        if (!legacyPath) {
            evidence.stage = 'getWatcher'; publish();
            descriptorResponse = await client.request(addon.actor, 'getWatcher', {isServerTargetSwitchingEnabled: true}, (packet) => packet.from === addon.actor && packet.type === undefined && (typeof packet.actor === 'string' || 'watcher' in packet));
            onCapability('gecko-rdp-addon-get-watcher');
            watcherResponse = descriptorResponse;
            const watcherValue = watcherResponse.actor ?? watcherResponse.watcher;
            /** @type {string|null} */
            let watcherActor = null;
            if (typeof watcherValue === 'string') {
                watcherActor = watcherValue;
            } else if (isRecord(watcherValue) && typeof watcherValue.actor === 'string') {
                watcherActor = watcherValue.actor;
            }
            if (watcherActor === null) { throw new Error(`Gecko RDP getWatcher response has no watcher actor: ${JSON.stringify(watcherResponse)}`); }
            evidence.watcherActor = watcherActor;
            evidence.stage = 'watchTargets';
            publish();
            watchTargetsResponse = await client.request(watcherActor, 'watchTargets', {targetType: 'frame'}, (packet) => packet.from === watcherActor && packet.type === undefined);
            onCapability('gecko-rdp-watcher-watch-targets');
            evidence.stage = 'target-available-form'; publish();
            const deadline = Date.now() + defaultTimeoutMs;
            for (let count = 0; count < 100; count++) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) { throw new Error('Timed out waiting for a matching nonfallback Firefox extension target'); }
                const event = await client.readPacket((packet) => packet.from === watcherActor && packet.type === 'target-available-form');
                const form = isRecord(event.target) ? event.target : null;
                if (form) {
                    evidence.targetForms.push(form);
                    if (evidence.targetForms.length > 30) { evidence.targetForms.shift(); }
                    publish();
                }
                if (form?.addonId === extensionId && form.isFallbackExtensionDocument !== true && typeof form.url === 'string' && form.url.startsWith('moz-extension://')) {
                    targetEvent = event;
                    targetForm = form;
                    break;
                }
            }
            if (!targetForm) { throw new Error(`No matching nonfallback moz-extension target was exposed; observed=${JSON.stringify(evidence.targetForms)}`); }
            evidence.selectedTarget = targetForm; publish();
            targetActor = typeof targetForm.actor === 'string' ? targetForm.actor : null;
            if (targetActor === null) { throw new Error(`Gecko RDP target-available-form has no target actor: ${JSON.stringify(targetEvent)}`); }
            onCapability('gecko-rdp-watcher-extension-target-available');
        } else {
            // Older Gecko descriptor actors use getTarget instead of the modern watcher.
            evidence.stage = 'legacy-getTarget'; publish();
            legacyTargetResponse = await client.request(addon.actor, 'getTarget', {}, (packet) => packet.from === addon.actor && packet.type === undefined && ('target' in packet || 'targetActor' in packet));
            onCapability('gecko-rdp-addon-get-target');
            const legacyTarget = isRecord(legacyTargetResponse.target) ? legacyTargetResponse.target : null;
            const targetCandidate = legacyTarget?.actor ?? legacyTargetResponse.targetActor ?? (typeof legacyTargetResponse.target === 'string' ? legacyTargetResponse.target : null);
            targetActor = typeof targetCandidate === 'string' ? targetCandidate : null;
            targetForm = legacyTarget;
        }
        const consoleActorCandidate = targetForm?.consoleActor ?? legacyTargetResponse?.consoleActor;
        let consoleActor = typeof consoleActorCandidate === 'string' ? consoleActorCandidate : null;
        if (consoleActor === null && targetActor !== null) {
            evidence.stage = 'attach'; publish();
            attachResponse = await client.request(targetActor, 'attach', {}, (packet) => packet.from === targetActor && packet.type === undefined && 'consoleActor' in packet);
            onCapability('gecko-rdp-target-attach');
            consoleActor = typeof attachResponse.consoleActor === 'string' ? attachResponse.consoleActor : null;
        }
        let evaluation = null;
        if (typeof consoleActor === 'string') {
            const script = 'JSON.stringify({runtimeId: globalThis.browser?.runtime?.id ?? globalThis.chrome?.runtime?.id ?? null, hasExtensionRuntime: Boolean(globalThis.browser?.runtime || globalThis.chrome?.runtime)})';
            evidence.stage = 'evaluateJSAsync'; publish();
            const acknowledgement = await client.request(consoleActor, 'evaluateJSAsync', {text: script}, (packet) => packet.from === consoleActor && packet.type === undefined && typeof packet.resultID === 'string');
            const expectedResultId = acknowledgement.resultID;
            evidence.stage = 'evaluationResult'; publish();
            const event = await client.readPacket((packet) => packet.from === consoleActor && packet.type === 'evaluationResult' && packet.resultID === expectedResultId);
            evaluation = {acknowledgement, result: event};
            onCapability('gecko-rdp-evaluate-extension-context-result');
        }
        evidence.stage = 'complete'; publish();
        return {
            extensionId,
            addonActor: addon.actor,
            addonName: typeof addon.name === 'string' ? addon.name : '',
            descriptorResponse,
            watcherResponse,
            watchTargetsResponse,
            targetEvent,
            targetForm,
            legacyTargetResponse,
            targetActor,
            attachResponse,
            consoleActor: typeof consoleActor === 'string' ? consoleActor : null,
            evaluation,
            evidence,
        };
    } catch (error) {
        evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        publish();
        if (error instanceof Error) { /** @type {Error & {evidence?: ProbeEvidence}} */ (error).evidence = JSON.parse(JSON.stringify(evidence)); }
        throw error;
    } finally {
        client.close();
    }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
