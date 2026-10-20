/* Generic setting edits keep the profile which owned the displayed control. */
import {expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {GenericSettingController} from '../ext/js/pages/settings/generic-setting-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

function createDeferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((resolve2) => { resolve = resolve2; });
    return {promise, resolve: /** @type {(value?: unknown) => void} */ (resolve)};
}

domTest('a second queued profile edit remains owned by its displayed profile across a profile switch', async ({window}) => {
    vi.stubGlobal('chrome', {permissions: {}});
    vi.stubGlobal('Node', window.Node);
    window.document.body.innerHTML = '<input id="setting" data-setting="general.enable" type="checkbox">';
    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        profileCurrent: 0,
        global: {dataTransmissionConsentShown: false},
        profiles: [
            {id: 'profile-a', name: 'A', conditionGroups: [], options: {general: {enable: true}}},
            {id: 'profile-b', name: 'B', conditionGroups: [], options: {general: {enable: false}}},
        ],
    }));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {createValidatingProxy: (/** @type {unknown} */ value) => value});
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    Reflect.set(backend, '_saveOptions', async (_source, value) => { Reflect.set(backend, '_options', value); });
    const sender = /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({}));
    const firstWriteStarted = createDeferred();
    const releaseFirstWrite = createDeferred();
    const secondWriteStarted = createDeferred();
    const firstReadStarted = createDeferred();
    const releaseFirstRead = createDeferred();
    const firstReadFinished = createDeferred();
    const profileBReadFinished = createDeferred();
    let readCount = 0;
    let writeCount = 0;
    const application = {
        on: vi.fn(),
        api: {
            getSettings: async (/** @type {import('settings-modifications').ScopedRead[]} */ targets) => {
                ++readCount;
                if (readCount === 1) {
                    firstReadStarted.resolve();
                    await releaseFirstRead.promise;
                    const result = await backend._onApiGetSettings({targets}, sender);
                    firstReadFinished.resolve();
                    return result;
                }
                const result = await backend._onApiGetSettings({targets}, sender);
                if (targets.some(({profileId}) => profileId === 'profile-b')) { profileBReadFinished.resolve(); }
                return result;
            },
            modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => {
                ++writeCount;
                if (writeCount === 1) {
                    firstWriteStarted.resolve();
                    await releaseFirstWrite.promise;
                } else if (writeCount === 2) {
                    secondWriteStarted.resolve();
                }
                return await backend._onApiModifySettings({targets, source}, sender);
            },
            optionsGetFull: () => backend._onApiOptionsGetFull(undefined, sender),
            optionsGet: (/** @type {import('settings').OptionsContext} */ optionsContext) => backend._onApiOptionsGet({optionsContext}, sender),
        },
    };
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settings, '_templates', {loadFromFiles: vi.fn()});
    Reflect.set(settings, '_source', 'generic-profile-ownership-test');
    await settings.prepare();
    const generic = new GenericSettingController(settings);
    await generic.prepare();
    const initialBinder = generic._dataBinder;
    const input = /** @type {HTMLInputElement} */ (window.document.querySelector('#setting'));
    await firstReadStarted.promise;
    const initialReadTask = initialBinder._updateTasks._activePromise;

    input.checked = false;
    input.dispatchEvent(new window.Event('change'));
    await firstWriteStarted.promise;
    input.checked = true;
    input.dispatchEvent(new window.Event('change'));

    const profileBReady = createDeferred();
    settings.on('optionsChanged', ({optionsContext}) => {
        if ('profileId' in optionsContext && optionsContext.profileId === 'profile-b') { profileBReady.resolve(); }
    });
    settings.profileIndex = 1;
    await profileBReady.promise;
    await profileBReadFinished.promise;
    const profileBReadTask = generic._dataBinder.refresh();
    releaseFirstRead.resolve();
    await firstReadFinished.promise;
    await Promise.all([initialReadTask, profileBReadTask]);
    expect(input.checked).toBe(false);
    releaseFirstWrite.resolve();
    await secondWriteStarted.promise;

    const activeAssignment = initialBinder._assignTasks._activePromise;
    expect(activeAssignment).not.toBeNull();
    await activeAssignment;

    const committed = /** @type {any} */ (Reflect.get(backend, '_options'));
    expect(committed.profiles[0].options.general.enable).toBe(true);
    expect(committed.profiles[1].options.general.enable).toBe(false);

    input.checked = true;
    input.dispatchEvent(new window.Event('change'));
    const currentViewWrite = generic._dataBinder._assignTasks._deferPromise ?? generic._dataBinder._assignTasks._activePromise;
    expect(currentViewWrite).not.toBeNull();
    await currentViewWrite;
    expect(/** @type {any} */ (Reflect.get(backend, '_options')).profiles[1].options.general.enable).toBe(true);
    generic._dataBinder.disconnect();
    generic._globalDataBinder.disconnect();
    await Promise.resolve();
});
