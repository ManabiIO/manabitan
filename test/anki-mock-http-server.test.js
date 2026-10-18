import {afterEach, expect, test} from 'vitest';
import {createAnkiMockState} from './e2e/anki-mock-state.js';
import {startAnkiMockHttpServer} from './e2e/anki-mock-http-server.js';

/** @type {Array<() => Promise<void>>} */
const closeServers = [];

afterEach(async () => {
    await Promise.all(closeServers.splice(0).map((close) => close()));
});

test.each([
    ['unexpected handler exception', async () => {
        const server = await startAnkiMockHttpServer({
            handleRequestBody() {
                throw new Error('internal /private/test/path payload-secret');
            },
            getScenarioState: () => ({}),
        });
        closeServers.push(server.close);
        return fetch(server.ankiConnectUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action: 'test', params: {value: 'request-secret'}}),
        });
    }],
    ['malformed JSON body', async () => {
        const server = await startAnkiMockHttpServer({
            handleRequestBody: () => ({result: null, error: null}),
            getScenarioState: () => ({}),
        });
        closeServers.push(server.close);
        return fetch(server.ankiConnectUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: '{"payload-secret":',
        });
    }],
])('%s returns a stable opaque error', async (_scenario, sendRequest) => {
    const response = await sendRequest();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({error: 'Mock server request failed'}));
    expect(body).not.toMatch(/internal|private|payload-secret|request-secret|SyntaxError|\.js:\d+/i);
});

test('ordinary Anki protocol errors remain visible to the mock client', async () => {
    const mockState = createAnkiMockState();
    const server = await startAnkiMockHttpServer(mockState);
    closeServers.push(server.close);
    const response = await fetch(server.ankiConnectUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'unsupported-test-action'}),
    });
    await expect(response.json()).resolves.toEqual({error: 'unsupported action'});
    expect(mockState.getActionNames()).toEqual(['unsupported-test-action']);
});
