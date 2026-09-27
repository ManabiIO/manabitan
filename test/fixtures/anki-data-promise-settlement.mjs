import {AnkiController} from '../../ext/js/pages/settings/anki-controller.js';

const controller = Object.create(AnkiController.prototype);
controller._getAnkiDataPromise = null;
let calls = 0;
controller._getAnkiData = async () => {
    ++calls;
    if (calls === 1) { throw new Error('anki data failed'); }
    return {deckNames: ['Deck'], modelNames: ['Model']};
};

try {
    await controller.getAnkiData();
    throw new Error('Expected first request to reject');
} catch (error) {
    if (!(error instanceof Error) || error.message !== 'anki data failed') { throw error; }
}

const [first, second] = await Promise.all([controller.getAnkiData(), controller.getAnkiData()]);
if (calls !== 2) { throw new Error(`Expected one retry request, got ${calls} total calls`); }
if (first.deckNames[0] !== 'Deck' || second.modelNames[0] !== 'Model') {
    throw new Error('Unexpected retry result');
}

await new Promise((resolve) => { setImmediate(resolve); });
if (controller._getAnkiDataPromise !== null) { throw new Error('Cached promise was not cleared'); }
