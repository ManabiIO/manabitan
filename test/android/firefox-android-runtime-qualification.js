import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {BlobWriter, Uint8ArrayReader, ZipWriter} from '@zip.js/zip.js';
import {createAnkiMockState} from '../e2e/anki-mock-state.js';
import {startAnkiMockHttpServer} from '../e2e/anki-mock-http-server.js';

const dictionaryTitle = 'android-runtime-fixture';
const expression = '読む';
const reading = 'よむ';
const glossary = 'to read';
export const androidMiningBackTemplate = '{reading} / {glossary-plain-no-dictionary}';
const execFileAsync = promisify(execFile);

/** @typedef {(actor: string, script: string, stage: string) => Promise<Record<string, unknown>>} RuntimeEvaluate */
/** @typedef {{term: string, reading: string}} LookupHeadword */
/** @typedef {{dictionary?: string, [key: string]: unknown}} LookupDefinition */
/** @typedef {{headwords?: LookupHeadword[], definitions?: LookupDefinition[]}} LookupEntry */
/** @typedef {{dictionaryEntries?: LookupEntry[], [key: string]: unknown}} LookupResult */
/** @typedef {{title: string, revision?: string, [key: string]: unknown}} DictionaryInfo */
/** @typedef {{status: string, timeoutMs: number, extensionId: string, backgroundTarget: Record<string, unknown>, stages: Array<{name: string, value: unknown}>, errors: string[], verifiedCapabilities: string[], unverifiedCapabilities: string[]}} RuntimeQualificationReport */

/**
 * Runs a bounded import and lookup through real Firefox Android extension pages and product APIs.
 * All async work is owned by a namespaced page state and every RDP evaluation is resultID-correlated.
 * @param {{extensionId: string, backgroundTarget: Record<string, unknown>, evaluate: RuntimeEvaluate, waitForTarget: (predicate: (target: Record<string, unknown>) => boolean, stage: string) => Promise<Record<string, unknown>>, fixtureDirectory: string, adbDevice: string, runtimeQualificationTimeoutMs: number, prepareNativeReadiness?: () => Promise<unknown>, onFailureEvidence?: (stage: string) => Promise<unknown>}} options
 * @returns {Promise<RuntimeQualificationReport>}
 */
export async function qualifyAndroidDictionaryRuntime({extensionId, backgroundTarget, evaluate, waitForTarget, fixtureDirectory, adbDevice, runtimeQualificationTimeoutMs, prepareNativeReadiness, onFailureEvidence}) {
    /** @type {RuntimeQualificationReport} */
    const report = {status: 'running', timeoutMs: runtimeQualificationTimeoutMs, extensionId, backgroundTarget, stages: [], errors: [], verifiedCapabilities: [], unverifiedCapabilities: ['dictionary-import', 'dictionary-lookup', 'anki-mining', 'dictionary-update']};
    /**
     * @param {string} name
     * @param {unknown} value
     * @returns {number}
     */
    const stage = (name, value) => report.stages.push({name, value});
    stage('runtime-qualification-timeout-budget', {timeoutMs: runtimeQualificationTimeoutMs, fixtureTerms: 38, boundedByProbe: true, note: 'qualification-only whole callback budget; install and actor discovery retain their own deadlines'});
    /** @type {Awaited<ReturnType<typeof startDictionaryFixtureServer>>|null} */
    let fixtureServer = null;
    /** @type {Error|null} */
    let fixtureCleanupFailure = null;
    /** @type {number|null} */
    let fixtureReversePort = null;
    /** @type {(Error & {cleanupError?: string})|null} */
    let qualificationFailure = null;
    try {
        assert.equal(backgroundTarget.addonId, extensionId, 'The accepted initial target belongs to another add-on');
        assert.equal(backgroundTarget.isFallbackExtensionDocument, false, 'The accepted initial target is a fallback context');
        if (prepareNativeReadiness) { stage('native-readiness', await prepareNativeReadiness()); }
        fixtureServer = await startDictionaryFixtureServer();
        const candidateReversePort = Number(new URL(fixtureServer.baseUrl).port);
        await execFileAsync('adb', ['-s', adbDevice, 'reverse', '--no-rebind', `tcp:${candidateReversePort}`, `tcp:${candidateReversePort}`], {timeout: 10_000});
        fixtureReversePort = candidateReversePort;
        stage('local-dictionary-fixture-route', {device: adbDevice, baseUrl: fixtureServer.baseUrl, reversePort: fixtureReversePort});
        const initialArchive = await createQualifiedArchive(fixtureDirectory, 'android-runtime-revision-1', `${glossary} revision 1`, fixtureServer.baseUrl);
        fixtureServer.setRevision('android-runtime-revision-1', initialArchive);
        const archive = Buffer.from(initialArchive).toString('base64');
        const openSettings = await evaluate(String(backgroundTarget.consoleActor), `(() => { globalThis.__manabitanAndroidRuntimeQualification = {phase:'opening-settings', ownedExtensionPageTabs:[], ownedExtensionPageTabIds:{}}; return ${buildOwnedExtensionPageOpenScript('settings.html')}; })()`, 'open-settings-page');
        stage('open-settings-page', openSettings);
        const settingsTarget = await waitForTarget((target) => target.url === `moz-extension://${new URL(String(backgroundTarget.url)).host}/settings.html`, 'settings-extension-page');
        assert.equal(settingsTarget.addonId, extensionId);
        assert.notEqual(settingsTarget.actor, backgroundTarget.actor, 'Settings watcher matched the background page rather than the new Settings page');
        assert.equal(settingsTarget.isFallbackExtensionDocument, false);
        assert.ok(typeof settingsTarget.innerWindowId === 'number' || (typeof settingsTarget.innerWindowId === 'string' && settingsTarget.innerWindowId.length > 0), `Settings target has no actual innerWindowID: ${JSON.stringify(settingsTarget)}`);
        const settingsActor = String(settingsTarget.consoleActor || '');
        assert.ok(settingsActor, 'Settings extension target has no console actor');
        const settingsFocus = await evaluateJSON(evaluate, String(backgroundTarget.consoleActor), buildOwnedPageActivationScript('settings.html'), 'activate-owned-settings-after-open');
        stage('activate-owned-settings-after-open', settingsFocus);
        const settingsVisibility = await evaluateJSON(evaluate, settingsActor, buildDocumentVisibilityWaitScript('settings.html'), 'wait-settings-visible');
        stage('settings-document-visible', settingsVisibility);
        stage('settings-extension-page', {actor: settingsTarget.actor, url: settingsTarget.url, innerWindowId: settingsTarget.innerWindowId});

        const importStart = await evaluate(settingsActor, buildSettingsFileImportStartScript(archive), 'start-settings-import');
        stage('start-settings-import', importStart);
        const importOutcome = await pollPageState(evaluate, settingsActor, 'wait-settings-import', 180_000);
        assert.equal(importOutcome.phase, 'import-visible', `Production import failed: ${importOutcome.error || JSON.stringify(importOutcome)}`);
        assert.ok(importOutcome.imported, 'Production import did not publish a dictionary summary');
        assert.equal(importOutcome.imported.title, dictionaryTitle);
        stage('production-import-published', importOutcome.imported);
        assert.equal(importOutcome.imported.isUpdatable, true, `Imported fixture was not published as updatable: ${JSON.stringify(importOutcome.imported)}`);
        assert.equal(importOutcome.imported.indexUrl, `${fixtureServer.baseUrl}/dictionary/index.json`);
        assert.equal(importOutcome.imported.downloadUrl, `${fixtureServer.baseUrl}/dictionary/current.zip`);
        const counts = await evaluateJSON(evaluate, settingsActor, `new Promise((resolve,reject)=>browser.runtime.sendMessage({action:'getDictionaryCounts',params:{dictionaryNames:['${dictionaryTitle}'],getTotal:true}},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))`, 'production-dictionary-counts');
        assert.equal(counts.counts?.length, 1, `Expected one actual dictionary count group: ${JSON.stringify(counts)}`);
        assert.equal(counts.counts?.[0]?.terms, 38, `Expected exactly 38 imported terms: ${JSON.stringify(counts)}`);
        assert.equal(counts.total?.terms, 38, `Expected total term count 38: ${JSON.stringify(counts)}`);
        stage('production-dictionary-summary', {title: dictionaryTitle, info: importOutcome.imported, counts});
        const configured = await evaluateJSON(evaluate, settingsActor, `new Promise((resolve,reject)=>{ const call=(action,params)=>new Promise((done,fail)=>browser.runtime.sendMessage({action,params},response=>{const error=browser.runtime.lastError;if(error)fail(new Error(error.message));else if(response?.error)fail(new Error(JSON.stringify(response.error)));else done(response?.result??response)})); (async()=>{const options=await call('optionsGetFull');for(const profile of options.profiles){let item=profile.options.dictionaries.find(value=>value.name==='${dictionaryTitle}');if(!item){item={name:'${dictionaryTitle}',alias:'${dictionaryTitle}',enabled:true,allowSecondarySearches:false,definitionsCollapsible:'not-collapsible',partsOfSpeechFilter:true,useDeinflections:true,styles:''};profile.options.dictionaries.push(item);}item.enabled=true;if(!profile.options.general.mainDictionary)profile.options.general.mainDictionary='${dictionaryTitle}';}await call('setAllSettings',{value:options,source:'firefox-android-capability'});resolve({configuredProfiles:options.profiles.length,enabled:true});})().catch(reject); })`, 'configure-imported-dictionary');
        stage('configure-imported-dictionary', configured);
        const storage = await evaluateJSON(evaluate, settingsActor, 'new Promise((resolve,reject)=>browser.runtime.sendMessage({action:\'debugDictionaryStorageState\'},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))', 'production-storage-diagnostics');
        stage('production-storage-diagnostics', storage);
        assert.equal(storage.usesFallbackStorage, false, 'Dictionary database reports fallback storage');
        assert.equal(storage.openStorageDiagnostics?.mode, 'opfs-sahpool', `Unexpected production storage mode: ${JSON.stringify(storage.openStorageDiagnostics)}`);
        assert.equal(storage.openStorageDiagnostics?.hasOpfsSahpoolVfs, true, `SAHPool VFS is not active: ${JSON.stringify(storage.openStorageDiagnostics)}`);
        assert.equal(storage.openStorageDiagnostics?.opfsSahpoolInstallResult, 'installed', `SAHPool installation did not succeed: ${JSON.stringify(storage.openStorageDiagnostics)}`);
        assert.equal(storage.openStorageDiagnostics?.runtimeContext?.isDedicatedWorkerGlobalScope, true, `Expected dedicated dictionary worker runtime: ${JSON.stringify(storage.openStorageDiagnostics)}`);
        assert.equal(storage.openStorageDiagnostics?.runtimeContext?.hasStorageGetDirectory, true, `Worker storage.getDirectory evidence missing: ${JSON.stringify(storage.openStorageDiagnostics)}`);
        assert.equal(storage.openStorageDiagnostics?.runtimeContext?.hasCreateSyncAccessHandle, true, `Worker createSyncAccessHandle evidence missing: ${JSON.stringify(storage.openStorageDiagnostics)}`);

        const lookup = /** @type {LookupResult} */ (await evaluateJSON(evaluate, settingsActor, `new Promise((resolve,reject)=>browser.runtime.sendMessage({action:'termsFind',params:{text:'${expression}',details:{matchType:'exact',deinflect:true,primaryReading:''},optionsContext:{current:true}}},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))`, 'exact-lookup'));
        const matching = lookup.dictionaryEntries?.flatMap((entry) => (entry.headwords || []).filter((headword) => headword.term === expression && headword.reading === reading).map((headword) => ({headword, definitions: entry.definitions || []}))) || [];
        assert.ok(matching.length > 0, `Exact lookup did not return expression/reading identity: ${JSON.stringify(lookup)}`);
        assert.ok(matching.some(({definitions}) => definitions.some((definition) => definition?.dictionary === dictionaryTitle && JSON.stringify(definition).includes(`${glossary} revision 1`))), `Exact lookup omitted initial revision glossary: ${JSON.stringify(lookup)}`);
        stage('exact-lookup', {expression, reading, glossary, dictionaryEntryCount: lookup.dictionaryEntries?.length || 0, headwordCount: matching.length});
        const deinflected = /** @type {LookupResult} */ (await evaluateJSON(evaluate, settingsActor, 'new Promise((resolve,reject)=>browser.runtime.sendMessage({action:\'termsFind\',params:{text:\'読んだ\',details:{matchType:\'exact\',deinflect:true,primaryReading:\'\'},optionsContext:{current:true}}},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))', 'deinflected-lookup'));
        assert.ok(deinflected.dictionaryEntries?.some((entry) => entry.headwords?.some((headword) => headword.term === expression && headword.reading === reading)), `Relevant deinflection query did not resolve to ${expression}/${reading}: ${JSON.stringify(deinflected)}`);
        stage('deinflected-lookup', {query: '読んだ', expression, reading});
        const ordinaryMiss = /** @type {LookupResult} */ (await evaluateJSON(evaluate, settingsActor, "new Promise((resolve,reject)=>browser.runtime.sendMessage({action:'termsFind',params:{text:'ぜんぜん',details:{matchType:'exact',deinflect:true,primaryReading:''},optionsContext:{current:true}}},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))", 'ordinary-miss-lookup'));
        assert.equal(ordinaryMiss.dictionaryEntries?.length || 0, 0, `Ordinary miss query unexpectedly matched: ${JSON.stringify(ordinaryMiss)}`);
        stage('ordinary-miss', {query: 'ぜんぜん', meaning: 'ordinary exact-search miss', dictionaryEntryCount: 0});
        const backgroundActor = String(backgroundTarget.consoleActor || '');
        assert.ok(backgroundActor, 'Accepted background target has no console actor for harness-owned Search tab');
        const openSearch = await evaluate(backgroundActor, buildOwnedExtensionPageOpenScript('search.html'), 'open-search-page');
        stage('open-search-page', openSearch);
        const searchTarget = await waitForTarget((target) => target.url === `moz-extension://${new URL(String(backgroundTarget.url)).host}/search.html`, 'search-extension-page');
        assert.equal(searchTarget.addonId, extensionId);
        assert.notEqual(searchTarget.actor, settingsTarget.actor, 'Search watcher matched Settings rather than the new Search page');
        const searchActor = String(searchTarget.consoleActor || '');
        assert.ok(searchActor, 'Search extension target has no console actor');
        const searchFocus = await evaluateJSON(evaluate, String(backgroundTarget.consoleActor), buildOwnedPageActivationScript('search.html'), 'activate-owned-search');
        stage('activate-owned-search', searchFocus);
        const searchVisibility = await evaluateJSON(evaluate, searchActor, buildDocumentVisibilityWaitScript('search.html'), 'wait-search-visible');
        stage('search-document-visible', searchVisibility);
        const audioConsent = await evaluateJSON(evaluate, searchActor, 'new Promise((resolve,reject)=>{const deadline=Date.now()+20000;const ready=()=>document.documentElement?.dataset?.loaded===\'true\'&&document.documentElement.dataset.audioConsentRequired!==undefined&&document.documentElement.dataset.audioConsentState!==undefined;if(!ready()){const wait=()=>{if(ready()){setTimeout(inspect,500);return;}if(Date.now()>deadline){reject(new Error(\'Search page did not settle product audio-consent state\'));return;}setTimeout(wait,100);};wait();return;}inspect();function inspect(){const modal=document.querySelector(\'#firefox-data-transmission-consent-modal\');const state={required:document.documentElement.dataset.audioConsentRequired||null,consentState:document.documentElement.dataset.audioConsentState||null,modalPresent:modal instanceof HTMLElement,modalVisible:modal instanceof HTMLElement&&!modal.hidden};if(!(modal instanceof HTMLElement)||modal.hidden){resolve({...state,action:\'no-visible-consent-modal\'});return;}const decline=modal.querySelector(\'#decline-data-transmission\');if(!(decline instanceof HTMLButtonElement)||decline.hidden){reject(new Error(\'Visible Firefox audio consent modal has no visible Decline control\'));return;}decline.click();const finish=()=>{const error=document.querySelector(\'#data-transmission-consent-save-error\');if(error instanceof HTMLElement&&!error.hidden&&error.textContent.trim()){reject(new Error(\'Firefox audio consent decline failed: \'+error.textContent.trim()));return;}if(modal.hidden){resolve({...state,action:\'declined-through-product-ui\',finalState:document.documentElement.dataset.audioConsentState||null});return;}if(Date.now()>deadline){reject(new Error(\'Firefox audio consent modal remained visible after Decline\'));return;}setTimeout(finish,100);};finish();}})', 'handle-search-audio-consent');
        stage('search-audio-consent', audioConsent);
        const visibleSearch = /** @type {{expression: string, reading: string, glossary: string[], dictionary: string, render: {visible: boolean, width: number, height: number, display: string, visibility: string, consentModalVisible: boolean}}} */ (await evaluateJSON(evaluate, searchActor, buildVisibleSearchScript({expression, reading, glossary: `${glossary} revision 1`, dictionaryTitle}), 'visible-search-result'));
        assert.ok(visibleSearch.expression.includes(expression), `Visible DOM omitted expression: ${JSON.stringify(visibleSearch)}`);
        assert.ok(visibleSearch.reading.includes(reading), `Visible DOM omitted reading: ${JSON.stringify(visibleSearch)}`);
        assert.ok(visibleSearch.glossary.some((value) => value.includes(`${glossary} revision 1`)), `Visible DOM omitted revision 1 glossary: ${JSON.stringify(visibleSearch)}`);
        assert.equal(visibleSearch.dictionary, dictionaryTitle, `Visible DOM dictionary mismatch: ${JSON.stringify(visibleSearch)}`);
        assert.equal(visibleSearch.render?.visible, true, `Visible Search oracle did not prove rendered, unoccluded result: ${JSON.stringify(visibleSearch)}`);
        stage('visible-search-result', visibleSearch);
        report.verifiedCapabilities.push('dictionary-import', 'dictionary-lookup');
        report.unverifiedCapabilities = ['anki-mining', 'dictionary-update'];
        const settingsModalFocus = await evaluateJSON(evaluate, String(backgroundTarget.consoleActor), buildOwnedPageActivationScript('settings.html'), 'activate-owned-settings-before-modal');
        stage('activate-owned-settings-before-modal', settingsModalFocus);
        const settingsModalVisibility = await evaluateJSON(evaluate, settingsActor, buildDocumentVisibilityWaitScript('settings.html'), 'wait-settings-visible-before-modal');
        stage('settings-visible-before-modal', settingsModalVisibility);
        const dictionaryModal = await evaluateJSON(evaluate, settingsActor, buildDictionaryModalOpenScript({id: settingsModalFocus.activeTabId, url: settingsModalFocus.url}), 'open-dictionaries-modal-through-product-ui');
        stage('open-dictionaries-modal-through-product-ui', dictionaryModal);
        const settingsUpdateFocus = await evaluateJSON(evaluate, String(backgroundTarget.consoleActor), buildOwnedPageActivationScript('settings.html'), 'activate-settings-before-update-ui');
        stage('activate-settings-before-update-ui', settingsUpdateFocus);
        const settingsUpdateVisibility = await evaluateJSON(evaluate, settingsActor, buildDocumentVisibilityWaitScript('settings.html'), 'wait-settings-visible-before-update-ui');
        stage('settings-visible-before-update-ui', settingsUpdateVisibility);
        assert.ok(fixtureServer, 'Local dictionary update server was not started');
        const updateArchive = await createQualifiedArchive(fixtureDirectory, 'android-runtime-revision-2', `${glossary} revision 2`, fixtureServer.baseUrl);
        fixtureServer.setRevision('android-runtime-revision-2', updateArchive);
        const dictionaryTitleLiteral = JSON.stringify(dictionaryTitle);
        const updateStartScript = `new Promise((resolve,reject)=>{const visible=node=>{const rect=node?.getBoundingClientRect();const style=node&&getComputedStyle(node);let shown=Boolean(rect&&style&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden');for(let parent=node;shown&&parent instanceof HTMLElement;parent=parent.parentElement){if(parent.hidden||parent.getAttribute('aria-hidden')==='true')shown=false;}return {shown,width:rect?.width||0,height:rect?.height||0};};const button=document.querySelector('#dictionary-check-updates');if(!(button instanceof HTMLButtonElement)||!visible(button).shown){reject(new Error('Actually rendered normal Check for Updates control is unavailable'));return;}button.click();const deadline=Date.now()+60000;const inspect=()=>{const badge=[...document.querySelectorAll('.dictionary-update-available')].find(item=>{const title=item.closest('.dictionary-item-title-container')?.querySelector('.dictionary-alias')?.textContent?.trim();return item instanceof HTMLButtonElement&&visible(item).shown&&item.dataset.downloadUrl?.length>0&&title===${dictionaryTitleLiteral};});if(badge){resolve({available:true,downloadUrl:badge.dataset.downloadUrl,rowTitle:badge.closest('.dictionary-item-title-container')?.querySelector('.dictionary-alias')?.textContent?.trim(),badgeVisible:true,render:visible(badge)});return;}if(Date.now()>deadline){reject(new Error('Normal update check did not expose a visible badge for the imported dictionary row'));return;}setTimeout(inspect,250);};inspect();})`;
        const updateStart = await evaluateJSON(evaluate, settingsActor, updateStartScript, 'normal-check-for-updates');
        stage('normal-update-available', updateStart);
        const updateClickScript = `new Promise((resolve,reject)=>{const visible=node=>{const rect=node?.getBoundingClientRect();const style=node&&getComputedStyle(node);let shown=Boolean(rect&&style&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden');for(let parent=node;shown&&parent instanceof HTMLElement;parent=parent.parentElement){if(parent.hidden||parent.getAttribute('aria-hidden')==='true')shown=false;}return {shown,width:rect?.width||0,height:rect?.height||0};};const badge=[...document.querySelectorAll('.dictionary-update-available')].find(item=>item instanceof HTMLButtonElement&&visible(item).shown&&item.dataset.downloadUrl?.length>0&&item.closest('.dictionary-item-title-container')?.querySelector('.dictionary-alias')?.textContent?.trim()===${dictionaryTitleLiteral});if(!(badge instanceof HTMLButtonElement)){reject(new Error('Visible genuine update badge for the imported dictionary disappeared before click'));return;}const downloadUrl=badge.dataset.downloadUrl;badge.click();const deadline=Date.now()+15000;const inspect=()=>{const modal=document.querySelector('#dictionary-confirm-update-modal');const title=modal?.querySelector('#dictionary-confirm-update-name')?.textContent?.trim();const confirm=modal?.querySelector('#dictionary-confirm-update-button');if(modal instanceof HTMLElement&&!modal.hidden&&modal.dataset.dictionaryTitle===${dictionaryTitleLiteral}&&modal.dataset.downloadUrl===downloadUrl&&title===${dictionaryTitleLiteral}&&confirm instanceof HTMLButtonElement&&visible(modal).shown&&visible(confirm).shown){confirm.click();resolve({clicked:true,dictionary:title,downloadUrl,confirmModalVisible:true,confirmButtonVisible:true,confirmedThroughProductUI:true});return;}if(Date.now()>deadline){reject(new Error('Normal update confirmation modal did not become visible for the expected dictionary and URL'));return;}setTimeout(inspect,100);};inspect();})`;
        const updateClick = await evaluateJSON(evaluate, settingsActor, updateClickScript, 'click-normal-update-badge-and-confirm');
        stage('click-normal-update-badge', updateClick);
        const updated = await evaluateJSON(evaluate, settingsActor, `new Promise((resolve,reject)=>{const deadline=Date.now()+180000;const check=()=>browser.runtime.sendMessage({action:'getDictionaryInfo'},response=>{const error=browser.runtime.lastError;if(error){if(String(error.message).includes('dictionary import is in progress')&&Date.now()<deadline){setTimeout(check,250);return;}reject(new Error(error.message));return;}if(response?.error){const message=JSON.stringify(response.error);if(message.includes('dictionary import is in progress')&&Date.now()<deadline){setTimeout(check,250);return;}reject(new Error(message));return;}const info=response?.result??response;const current=Array.isArray(info)?info.find(item=>item.title==='${dictionaryTitle}'):null;if(current?.revision==='android-runtime-revision-2'){resolve({phase:'import-visible',imported:current});return;}if(Date.now()>deadline){reject(new Error('Timed out waiting for normal update path to publish revision 2: '+JSON.stringify(info)));return;}setTimeout(check,250);});check();})`, 'wait-normal-update-publication');
        assert.equal(updated.phase, 'import-visible', `Production dictionary update failed: ${updated.error || JSON.stringify(updated)}`);
        assert.equal(updated.imported.title, dictionaryTitle);
        assert.equal(updated.imported.revision, 'android-runtime-revision-2', `Updated dictionary revision is missing: ${JSON.stringify(updated.imported)}`);
        stage('production-update-published', updated.imported);
        const updatedLookup = /** @type {LookupResult} */ (await evaluateJSON(evaluate, settingsActor, `new Promise((resolve,reject)=>browser.runtime.sendMessage({action:'termsFind',params:{text:'${expression}',details:{matchType:'exact',deinflect:true,primaryReading:''},optionsContext:{current:true}}},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))`, 'updated-exact-lookup'));
        const updatedMatch = updatedLookup.dictionaryEntries?.filter((entry) => entry.headwords?.some((headword) => headword.term === expression && headword.reading === reading)) || [];
        const updatedDefinitions = updatedMatch.flatMap((entry) => entry.definitions || []).filter((definition) => definition?.dictionary === dictionaryTitle);
        assert.ok(updatedDefinitions.some((definition) => JSON.stringify(definition).includes(`${glossary} revision 2`)), `Updated glossary was not visible in the intended dictionary definition: ${JSON.stringify(updatedLookup)}`);
        assert.ok(!updatedDefinitions.some((definition) => JSON.stringify(definition).includes(`${glossary} revision 1`)), `Revision 1 glossary remained in the intended dictionary definition: ${JSON.stringify(updatedLookup)}`);
        const updatedInfo = /** @type {DictionaryInfo[]} */ (await evaluateJSON(evaluate, settingsActor, "new Promise((resolve,reject)=>browser.runtime.sendMessage({action:'getDictionaryInfo'},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)}))", 'updated-dictionary-inventory'));
        assert.equal(updatedInfo.filter((item) => item.title === dictionaryTitle).length, 1, `Expected exactly one durable dictionary after update: ${JSON.stringify(updatedInfo)}`);
        assert.equal(updatedInfo.some((item) => String(item.title).includes('staging')), false, `A staging dictionary remained after update: ${JSON.stringify(updatedInfo)}`);
        stage('updated-exact-lookup', {revision: updated.imported.revision, glossary: `${glossary} revision 2`, oldRevisionGlossaryAbsent: true, durableDictionaryCount: 1, stagingDictionaryPresent: false});
        assert.ok(backgroundActor, 'Accepted background target has no console actor for owned Settings reload');
        const reloadSettings = await evaluateJSON(evaluate, backgroundActor, buildOwnedPageReloadScript('settings.html'), 'reload-owned-settings-tab');
        stage('reload-owned-settings-tab', reloadSettings);
        const reloadedSettings = await waitForTarget((target) => target.url === `moz-extension://${new URL(String(backgroundTarget.url)).host}/settings.html` && target.innerWindowId !== settingsTarget.innerWindowId, 'settings-page-reload');
        assert.ok(typeof reloadedSettings.innerWindowId === 'number' || (typeof reloadedSettings.innerWindowId === 'string' && reloadedSettings.innerWindowId.length > 0), `Reloaded Settings target has no actual innerWindowID: ${JSON.stringify(reloadedSettings)}`);
        assert.notEqual(reloadedSettings.innerWindowId, settingsTarget.innerWindowId, 'Settings reload did not expose a fresh innerWindowID');
        const reloadedSettingsActor = String(reloadedSettings.consoleActor || '');
        assert.ok(reloadedSettingsActor, 'Reloaded Settings page has no console actor');
        const reloadedSettingsFocus = await evaluateJSON(evaluate, backgroundActor, buildOwnedPageActivationScript('settings.html'), 'activate-reloaded-owned-settings');
        stage('activate-reloaded-owned-settings', reloadedSettingsFocus);
        const reloadedSettingsVisibility = await evaluateJSON(evaluate, reloadedSettingsActor, buildDocumentVisibilityWaitScript('settings.html'), 'wait-reloaded-settings-visible');
        stage('reloaded-settings-document-visible', reloadedSettingsVisibility);
        const freshPageLookup = /** @type {LookupResult} */ (await evaluateJSON(evaluate, reloadedSettingsActor, `new Promise((resolve,reject)=>{if(document.documentElement?.dataset?.loaded!=='true'){const deadline=Date.now()+30000;const check=()=>{if(document.documentElement?.dataset?.loaded==='true'){browser.runtime.sendMessage({action:'termsFind',params:{text:'${expression}',details:{matchType:'exact',deinflect:true,primaryReading:''},optionsContext:{current:true}}},response=>{const error=browser.runtime.lastError;if(error)reject(new Error(error.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)});return;}if(Date.now()>deadline){reject(new Error('Reloaded Settings did not reach ready state'));return;}setTimeout(check,100);};check();}else browser.runtime.sendMessage({action:'termsFind',params:{text:'${expression}',details:{matchType:'exact',deinflect:true,primaryReading:''},optionsContext:{current:true}}},response=>{const error=browser.runtime.lastError;if(error)reject(new Error(error.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response)});})`, 'fresh-page-lookup-after-settings-reload'));
        const freshPageEntries = freshPageLookup.dictionaryEntries?.filter((entry) => entry.headwords?.some((headword) => headword.term === expression && headword.reading === reading)) || [];
        const freshPageDefinitions = freshPageEntries.flatMap((entry) => entry.definitions || []).filter((definition) => definition.dictionary === dictionaryTitle);
        assert.ok(freshPageDefinitions.some((definition) => JSON.stringify(definition).includes(`${glossary} revision 2`)), `Fresh Settings page omitted the updated glossary from the exact dictionary definition: ${JSON.stringify(freshPageLookup)}`);
        assert.ok(!freshPageDefinitions.some((definition) => JSON.stringify(definition).includes(`${glossary} revision 1`)), `Fresh Settings page retained the old revision glossary in the exact dictionary definition: ${JSON.stringify(freshPageLookup)}`);
        stage('fresh-page-lookup-after-settings-reload', {revision: 'android-runtime-revision-2', glossary: `${glossary} revision 2`, boundary: 'fresh extension page; backend/browser restart remains unverified'});
        report.verifiedCapabilities.push('dictionary-update');
        report.unverifiedCapabilities = ['anki-mining'];
        const refreshedSearchFocus = await evaluateJSON(evaluate, backgroundActor, buildOwnedPageActivationScript('search.html', {searchQuery: expression}), 'activate-search-before-updated-visible-result');
        stage('activate-search-before-updated-visible-result', refreshedSearchFocus);
        const refreshedSearchVisibility = await evaluateJSON(evaluate, searchActor, buildDocumentVisibilityWaitScript('search.html', {searchQuery: expression}), 'wait-search-visible-before-updated-result');
        stage('search-document-visible-before-updated-result', refreshedSearchVisibility);
        const refreshedVisibleSearch = await evaluateJSON(evaluate, searchActor, buildVisibleSearchScript({expression, reading, glossary: `${glossary} revision 2`, dictionaryTitle}), 'updated-visible-search-result');
        stage('updated-visible-search-result', refreshedVisibleSearch);
        await qualifyMiningAction({evaluate, backgroundActor, settingsActor: reloadedSettingsActor, searchActor, adbDevice, stage});
        report.verifiedCapabilities.push('anki-mining');
        report.unverifiedCapabilities = [];
        report.status = 'success';
    } catch (error) {
        report.status = 'failure';
        report.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        qualificationFailure = error instanceof Error ? /** @type {Error & {cleanupError?: string}} */ (error) : new Error(String(error));
        if (onFailureEvidence) {
            const capturedAtIso = new Date().toISOString();
            try {
                const evidence = await onFailureEvidence('runtime-failure-before-owned-tab-cleanup');
                stage('native-failure-evidence', {capturedAtIso, evidence});
            } catch (evidenceError) {
                stage('native-failure-evidence', {capturedAtIso, status: 'error', error: evidenceError instanceof Error ? `${evidenceError.name}: ${evidenceError.message}` : String(evidenceError)});
            }
        }
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {runtimeQualification: report});
    } finally {
        const backgroundActor = typeof backgroundTarget.consoleActor === 'string' ? backgroundTarget.consoleActor : null;
        if (backgroundActor !== null) {
            try {
                const tabCleanup = await evaluateJSON(evaluate, backgroundActor, buildOwnedTabCleanupScript(), 'cleanup-owned-extension-tabs');
                assert.equal(tabCleanup.failures.length, 0, `Owned extension tabs failed to close: ${JSON.stringify(tabCleanup)}`);
                stage('cleanup-owned-extension-tabs', tabCleanup);
            } catch (cleanupError) {
                const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                if (qualificationFailure) {
                    qualificationFailure.cleanupError = [qualificationFailure.cleanupError, `Owned extension tabs: ${cleanup.name}: ${cleanup.message}`].filter(Boolean).join('; ');
                } else {
                    fixtureCleanupFailure = cleanup;
                }
                report.errors.push(`Owned extension tab cleanup: ${cleanup.name}: ${cleanup.message}`);
            }
        }
        if (fixtureReversePort !== null) {
            try {
                await execFileAsync('adb', ['-s', adbDevice, 'reverse', '--remove', `tcp:${fixtureReversePort}`], {timeout: 10_000});
            } catch (cleanupError) {
                const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                if (qualificationFailure) {
                    qualificationFailure.cleanupError = [qualificationFailure.cleanupError, `${cleanup.name}: ${cleanup.message}`].filter(Boolean).join('; ');
                    report.errors.push(`ADB reverse cleanup: ${cleanup.name}: ${cleanup.message}`);
                } else {
                    fixtureCleanupFailure = cleanup;
                }
            }
        }
        if (fixtureServer) {
            try { await fixtureServer.close(); } catch (cleanupError) {
                const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                if (qualificationFailure) {
                    qualificationFailure.cleanupError = [qualificationFailure.cleanupError, `${cleanup.name}: ${cleanup.message}`].filter(Boolean).join('; ');
                    report.errors.push(`Cleanup: ${cleanup.name}: ${cleanup.message}`);
                } else {
                    fixtureCleanupFailure = cleanup;
                }
            }
        }
    }
    if (fixtureCleanupFailure) {
        report.status = 'failure';
        const cleanupMessage = `${fixtureCleanupFailure.name}: ${fixtureCleanupFailure.message}`;
        report.errors.push(`Fixture cleanup: ${cleanupMessage}`);
        Object.assign(fixtureCleanupFailure, {runtimeQualification: report});
        throw fixtureCleanupFailure;
    }
    return report;
}

/**
 * @param {RuntimeEvaluate} evaluate
 * @param {string} actor
 * @param {string} expression
 * @param {string} stage
 * @returns {Promise<import('core').SafeAny>}
 */
export async function evaluateJSON(evaluate, actor, expression, stage) {
    const key = `__manabitanAndroidJob_${randomUUID().replaceAll('-', '')}`;
    const keyLiteral = JSON.stringify(key);
    const start = buildRuntimeJobStart(key, expression);
    const deadline = Date.now() + 180_000;
    /** @type {(Error & {cleanupError?: string, cleanupErrors?: string[]})|null} */
    let primaryError = null;
    /** @type {Error|null} */
    let cleanupFailure = null;
    /** @type {import('core').SafeAny} */
    let operationResult;
    let operationCompleted = false;
    try {
        decodeRuntimeEvaluation(await evaluate(actor, start, `${stage}:start`), stage);
        while (Date.now() < deadline) {
            const state = decodeRuntimeEvaluation(await evaluate(actor, `JSON.stringify(globalThis[${keyLiteral}] ?? null)`, `${stage}:poll`), stage);
            if (state !== null && typeof state === 'object') {
                if (state.status === 'rejected') { throw new Error(`Page operation ${stage} rejected: ${JSON.stringify(state.error)}`); }
                if (state.status === 'fulfilled') {
                    operationResult = /** @type {import('core').SafeAny} */ (state.value);
                    operationCompleted = true;
                    break;
                }
            }
            await new Promise((resolve) => { setTimeout(resolve, 100); });
        }
        if (!operationCompleted) {
            throw new Error(`Page operation ${stage} exceeded its deadline`);
        }
    } catch (error) {
        primaryError = error instanceof Error ? error : new Error(String(error));
        throw primaryError;
    } finally {
        // This namespace belongs to the harness; never mutate product readiness globals.
        try {
            const cleanup = decodeRuntimeEvaluation(await evaluate(actor, `(() => { delete globalThis[${keyLiteral}]; return JSON.stringify({cleaned:!Object.hasOwn(globalThis,${keyLiteral})}); })()`, `${stage}:cleanup`), `${stage}:cleanup`);
            if (cleanup?.cleaned !== true) {
                const error = new Error(`Page operation ${stage} cleanup did not remove its owned state`);
                if (primaryError) {
                    primaryError.cleanupError = error.message;
                } else {
                    cleanupFailure = error;
                }
            }
        } catch (cleanupError) {
            const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
            if (primaryError) {
                primaryError.cleanupError = `${cleanup.name}: ${cleanup.message}`;
            } else { cleanupFailure = cleanup; }
        }
    }
    if (cleanupFailure) { throw cleanupFailure; }
    return operationResult;
}

/**
 * @param {string} key
 * @param {string} expression
 * @returns {string}
 */
export function buildRuntimeJobStart(key, expression) {
    return `(() => {
        const key = ${JSON.stringify(key)};
        if (Object.hasOwn(globalThis, key)) throw new Error('Harness operation key already exists');
        const serializeRuntimeError = error => { const record=typeof error==='object'&&error!==null?error:{};return {name:typeof record.name==='string'?record.name:'Error',message:typeof record.message==='string'?record.message:String(error),stack:typeof record.stack==='string'?record.stack:null,diagnostic:record.diagnostic??null}; };
        const state = {status:'pending'};
        globalThis[key] = state;
        Promise.resolve().then(() => (${expression})).then(
            value => { state.status='fulfilled'; state.value=value; },
            error => { state.status='rejected'; state.error=serializeRuntimeError(error); }
        );
        return JSON.stringify({started:true, key});
    })()`;
}

/**
 * @param {string} page
 * @returns {string}
 */
export function buildOwnedExtensionPageOpenScript(page) {
    return `(() => { const serializeRuntimeError=error=>{const record=typeof error==='object'&&error!==null?error:{};return {name:typeof record.name==='string'?record.name:'Error',message:typeof record.message==='string'?record.message:String(error),stack:typeof record.stack==='string'?record.stack:null,diagnostic:record.diagnostic??null};}; const state=globalThis.__manabitanAndroidRuntimeQualification; const page=${JSON.stringify(page)}; if(!state||!Array.isArray(state.ownedExtensionPageTabs)) throw new Error('Harness background tab ownership state is unavailable'); state.ownedExtensionPageTabIds??={}; browser.tabs.create({url:browser.runtime.getURL(page)}).then(tab=>{if(!Number.isInteger(tab?.id)){state.error=serializeRuntimeError(new Error('Created extension page has no tab ID'));state.phase='failed';return;}state.ownedExtensionPageTabs.push(tab.id);state.ownedExtensionPageTabIds[page]=tab.id;state.lastOpenedPage=page;state.phase='page-open';},error=>{state.error=serializeRuntimeError(error);state.phase='failed';}); return JSON.stringify({started:true,page}); })()`;
}

/**
 * @param {string} page
 * @param {{searchQuery?: string}} [options]
 * @returns {string}
 */
export function buildOwnedPageActivationScript(page, {searchQuery} = {}) {
    const searchUrlSuffix = searchQuery === undefined ? '' : `?${new URLSearchParams({query: searchQuery, type: 'terms'})}`;
    return `new Promise(async(resolve,reject)=>{try{const state=globalThis.__manabitanAndroidRuntimeQualification;const page=${JSON.stringify(page)};const id=state?.ownedExtensionPageTabIds?.[page];const expectedUrl=browser.runtime.getURL(page)+${JSON.stringify(searchUrlSuffix)};if(!Number.isInteger(id)||!Array.isArray(state.ownedExtensionPageTabs)||!state.ownedExtensionPageTabs.includes(id)){throw new Error('Owned '+page+' tab ID is unavailable or not in the owned tab list');}const tab=await browser.tabs.get(id);if(tab.url!==expectedUrl){throw new Error('Owned '+page+' tab URL mismatch: '+JSON.stringify({id,expectedUrl,actualUrl:tab.url}));}await browser.tabs.update(id,{active:true});const active=await browser.tabs.query({active:true,currentWindow:true});const actual=active.find(item=>item.id===id);if(!actual||actual.url!==expectedUrl){throw new Error('Owned '+page+' tab did not become the active expected page: '+JSON.stringify(active));}resolve({page,tabId:id,activeTabId:actual.id,url:actual.url});}catch(error){reject(error);}})`;
}

/**
 * @param {string} page
 * @returns {string}
 */
export function buildOwnedPageReloadScript(page) {
    return `new Promise(async(resolve,reject)=>{try{const state=globalThis.__manabitanAndroidRuntimeQualification;const page=${JSON.stringify(page)};const id=state?.ownedExtensionPageTabIds?.[page];const expectedUrl=browser.runtime.getURL(page);if(!Number.isInteger(id)||!Array.isArray(state.ownedExtensionPageTabs)||!state.ownedExtensionPageTabs.includes(id)){throw new Error('Owned '+page+' tab ID is unavailable or not in the owned tab list');}const tab=await browser.tabs.get(id);if(tab.url!==expectedUrl){throw new Error('Owned '+page+' tab URL mismatch: '+JSON.stringify({id,expectedUrl,actualUrl:tab.url}));}await browser.tabs.reload(id);resolve({reloaded:true,page,tabId:id,url:tab.url});}catch(error){reject(error);}})`;
}

/**
 * @param {string} page
 * @param {{searchQuery?: string}} [options]
 * @returns {string}
 */
export function buildDocumentVisibilityWaitScript(page, {searchQuery} = {}) {
    const searchUrlSuffix = searchQuery === undefined ? '' : `?${new URLSearchParams({query: searchQuery, type: 'terms'})}`;
    return `new Promise((resolve,reject)=>{const expectedUrl=browser.runtime.getURL(${JSON.stringify(page)})+${JSON.stringify(searchUrlSuffix)};const deadline=Date.now()+15000;const inspect=()=>{const viewport={innerWidth,innerHeight,outerWidth,outerHeight,documentElementWidth:document.documentElement?.clientWidth||0,documentElementHeight:document.documentElement?.clientHeight||0};if(location.href!==expectedUrl){reject(new Error('Document URL changed while waiting for visible '+${JSON.stringify(page)}+': '+location.href));return;}if(document.visibilityState==='visible'&&viewport.innerWidth>0&&viewport.innerHeight>0){resolve({page:${JSON.stringify(page)},url:location.href,visibilityState:document.visibilityState,viewport});return;}if(Date.now()>deadline){reject(new Error('Owned '+${JSON.stringify(page)}+' document did not become visible with a nonzero page viewport: '+JSON.stringify({url:location.href,visibilityState:document.visibilityState,viewport})));return;}setTimeout(inspect,100);};inspect();})`;
}

/**
 * @param {{id: number, url: string}} activeOwnedSettingsTab
 * @returns {string}
 */
// The template literal is emitted as source in the Firefox page actor.
export function buildDictionaryModalOpenScript(activeOwnedSettingsTab) {
    return `new Promise((resolve,reject)=>{
        const visible=node=>{const rect=node?.getBoundingClientRect();const style=node&&getComputedStyle(node);let shown=Boolean(rect&&style&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden');for(let parent=node;shown&&parent instanceof HTMLElement;parent=parent.parentElement){if(parent.hidden||parent.getAttribute('aria-hidden')==='true')shown=false;}return {shown,width:rect?.width||0,height:rect?.height||0};};
        const diagnostic=()=>{
            const triggerSelector='.settings-item-button[data-modal-action="show,dictionaries"]';
            const modalSelector='#dictionaries-modal';
            const trigger=document.querySelector(triggerSelector);
            const modal=document.querySelector(modalSelector);
            const describe=node=>{
                if(!(node instanceof HTMLElement))return null;
                const rect=node.getBoundingClientRect();
                const style=getComputedStyle(node);
                return {tag:node.tagName,id:node.id||null,className:String(node.className||''),disabled:node instanceof HTMLButtonElement?node.disabled:null,hidden:node.hidden,ariaHidden:node.getAttribute('aria-hidden'),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},display:style.display,visibility:style.visibility,position:style.position,transform:style.transform,contain:style.contain,overflow:style.overflow,overflowX:style.overflowX,overflowY:style.overflowY};
            };
            const ancestors=node=>{const result=[];for(let parent=node;parent instanceof HTMLElement;parent=parent.parentElement)result.push(describe(parent));return result;};
            const hitTest=(x,y)=>{if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=innerWidth||y>=innerHeight)return null;const element=document.elementFromPoint(x,y);return element instanceof HTMLElement?{tag:element.tagName,id:element.id||null,className:String(element.className||'')}:null;};
            const viewport={innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,documentElement:{clientWidth:document.documentElement?.clientWidth||0,clientHeight:document.documentElement?.clientHeight||0,scrollWidth:document.documentElement?.scrollWidth||0,scrollHeight:document.documentElement?.scrollHeight||0},body:{clientWidth:document.body?.clientWidth||0,clientHeight:document.body?.clientHeight||0,scrollWidth:document.body?.scrollWidth||0,scrollHeight:document.body?.scrollHeight||0},visualViewport:globalThis.visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null};
            const center={x:Math.floor(innerWidth/2),y:Math.floor(innerHeight/2)};
            return {documentReadyState:document.readyState,documentVisibilityState:document.visibilityState,documentUrl:location.href,triggerSelector,modalSelector,activeOwnedTab:${JSON.stringify(activeOwnedSettingsTab)},viewport,root:describe(document.documentElement),body:describe(document.body),trigger:describe(trigger),modal:describe(modal),triggerAncestors:ancestors(trigger),modalAncestors:ancestors(modal),viewportCenterHit:hitTest(center.x,center.y),modalCenterHit:modal instanceof HTMLElement?hitTest((()=>{const rect=modal.getBoundingClientRect();return rect.left+rect.width/2;})(),(()=>{const rect=modal.getBoundingClientRect();return rect.top+rect.height/2;})()):null};
        };
        const trigger=document.querySelector('.settings-item-button[data-modal-action="show,dictionaries"]');
        if(!(trigger instanceof HTMLElement)||!visible(trigger).shown){reject(Object.assign(new Error('Shipped visible Configure installed and enabled dictionaries trigger is unavailable'),{diagnostic:diagnostic()}));return;}
        trigger.scrollIntoView({block:'center',inline:'nearest'});
        trigger.click();
        const deadline=Date.now()+15000;
        const inspect=()=>{const modal=document.querySelector('#dictionaries-modal');const render=modal instanceof HTMLElement?visible(modal):{shown:false,width:0,height:0};if(modal instanceof HTMLElement&&!modal.hidden&&render.shown){resolve({openedThroughProductTrigger:true,modalVisible:true,render,diagnostic:diagnostic()});return;}if(Date.now()>deadline){reject(Object.assign(new Error('Shipped Dictionaries modal did not become visible'),{diagnostic:diagnostic()}));return;}setTimeout(inspect,100);};
        inspect();
    })`;
}

/**
 * @returns {string}
 */
export function buildOwnedTabCleanupScript() {
    return 'new Promise((resolve,reject)=>{const state=globalThis.__manabitanAndroidRuntimeQualification;const ids=Array.isArray(state?.ownedExtensionPageTabs)?[...new Set(state.ownedExtensionPageTabs.filter(Number.isInteger))]:[];Promise.all(ids.map(async id=>{try{await browser.tabs.remove(id);return {id,removed:true};}catch(error){return {id,removed:false,error:{name:error?.name||\'Error\',message:error?.message||String(error),stack:error?.stack||null}};}})).then(results=>{if(state){state.ownedExtensionPageTabs=[];state.ownedExtensionPageTabIds={};}resolve({ownedIds:ids,removed:results.filter(item=>item.removed).map(item=>item.id),failures:results.filter(item=>!item.removed)});},reject);})';
}

/**
 * @param {string} archive
 * @returns {string}
 */
export function buildSettingsFileImportStartScript(archive) {
    return `(() => { const serializeRuntimeError=error=>{const record=typeof error==='object'&&error!==null?error:{};return {name:typeof record.name==='string'?record.name:'Error',message:typeof record.message==='string'?record.message:String(error),stack:typeof record.stack==='string'?record.stack:null,diagnostic:record.diagnostic??null};}; const state={phase:'waiting-settings', error:null, imported:null}; globalThis.__manabitanAndroidRuntimeQualification=state; state.promise=(async()=>{ const deadline=Date.now()+180000; while(Date.now()<deadline && document.documentElement?.dataset?.loaded!=='true') await new Promise(r=>setTimeout(r,100)); if(document.documentElement?.dataset?.loaded!=='true') throw new Error('Settings page did not reach normal loaded state'); const input=document.querySelector('#dictionary-import-file-input'); if(!(input instanceof HTMLInputElement)) throw new Error('Shipped dictionary import file input is unavailable'); const bytes=Uint8Array.from(atob('${archive}'),c=>c.charCodeAt(0)); const file=new File([bytes],'android-runtime-fixture.zip',{type:'application/zip'}); const transfer=new DataTransfer(); transfer.items.add(file); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); state.phase='import-started'; while(Date.now()<deadline){ const error=document.querySelector('#dictionary-error'); if(error instanceof HTMLElement && !error.hidden && error.textContent.trim()) throw new Error('Product import UI reported: '+error.textContent.trim()); try { const info=await new Promise((resolve,reject)=>browser.runtime.sendMessage({action:'getDictionaryInfo'},response=>{const e=browser.runtime.lastError;if(e)reject(new Error(e.message));else if(response?.error)reject(new Error(JSON.stringify(response.error)));else resolve(response?.result??response);})); if(Array.isArray(info)&&info.some(item=>item.title==='${dictionaryTitle}')){state.imported=info.find(item=>item.title==='${dictionaryTitle}');state.phase='import-visible';return state.imported;} } catch(error){if(!String(error?.message||error).includes('dictionary import is in progress')) throw error;} await new Promise(r=>setTimeout(r,250)); } throw new Error('Timed out waiting for production import publication'); })().catch(error=>{state.phase='failed';state.error=serializeRuntimeError(error)}); return JSON.stringify({started:true}); })()`;
}

/**
 * @param {{expression: string, reading: string, glossary: string, dictionaryTitle: string}} expected
 * @param {{timeoutMs?: number, pollIntervalMs?: number}} [options]
 * @returns {string}
 */
export function buildVisibleSearchScript({expression, reading, glossary, dictionaryTitle: title}, {timeoutMs = 60_000, pollIntervalMs = 250} = {}) {
    const args = JSON.stringify({expression, reading, glossary, title});
    const timeout = JSON.stringify(timeoutMs);
    const interval = JSON.stringify(pollIntervalMs);
    return `new Promise((resolve,reject)=>{const expected=${args};const deadline=Date.now()+${timeout};const poll=${interval};const plainTerm=(node)=>{const copy=node.cloneNode(true);for(const rubyPart of copy.querySelectorAll('rt,rp'))rubyPart.remove();return String(copy.textContent||'').replace(/\\s+/g,'').trim();};const isRendered=(node)=>{const rect=node.getBoundingClientRect();const style=getComputedStyle(node);const consentModal=document.querySelector('#firefox-data-transmission-consent-modal');let visible=style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&!(consentModal instanceof HTMLElement&&!consentModal.hidden);for(let parent=node;visible&&parent instanceof HTMLElement;parent=parent.parentElement){if(parent.hidden||parent.getAttribute('aria-hidden')==='true')visible=false;}return {visible,width:rect.width,height:rect.height,display:style.display,visibility:style.visibility,consentModalVisible:consentModal instanceof HTMLElement&&!consentModal.hidden};};const attempt=()=>{if(document.documentElement?.dataset?.loaded!=='true'){if(Date.now()>deadline){reject(new Error('Search page did not reach normal loaded state'));return;}setTimeout(attempt,Math.min(100,poll));return;}const input=document.querySelector('#search-textbox');const button=document.querySelector('#search-button');if(!(input instanceof HTMLTextAreaElement)||!(button instanceof HTMLButtonElement)){reject(new Error('Shipped search controls are unavailable'));return;}input.value=expected.expression;input.dispatchEvent(new Event('input',{bubbles:true,cancelable:true}));button.click();const inspect=()=>{const candidates=[...document.querySelectorAll('#dictionary-entries .entry')];for(const entry of candidates){const matchedHeadword=[...entry.querySelectorAll('.headword')].map(headword=>({term:headword.querySelector('.headword-term'),reading:headword.querySelector('.headword-reading')})).find(pair=>pair.term&&pair.reading&&plainTerm(pair.term)===expected.expression&&String(pair.reading.textContent||'').trim()===expected.reading);if(!matchedHeadword)continue;const definition=[...entry.querySelectorAll('.definition-item[data-dictionary]')].find(item=>item.dataset.dictionary===expected.title&&[...item.querySelectorAll('.gloss-content')].some(gloss=>String(gloss.textContent||'').trim().includes(expected.glossary)));if(!definition)continue;const render=isRendered(entry);if(!render.visible){if(Date.now()>deadline){reject(new Error('Matching Search entry is not rendered: '+JSON.stringify(render)));return;}setTimeout(inspect,poll);return;}resolve({expression:plainTerm(matchedHeadword.term),reading:String(matchedHeadword.reading.textContent||'').trim(),glossary:[...definition.querySelectorAll('.gloss-content')].map(item=>String(item.textContent||'').trim()),dictionary:definition.dataset.dictionary,entryCount:candidates.length,render});return;}if(Date.now()>deadline){reject(new Error('No single visible Search entry contained the exact term/reading pair and its dictionary glossary'));return;}setTimeout(inspect,poll);};inspect();};attempt();})`;
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} stage
 * @returns {import('core').SafeAny}
 */
export function decodeRuntimeEvaluation(entry, stage) {
    const packet = entry.result;
    if (!(packet && typeof packet === 'object' && !Array.isArray(packet))) { throw new Error(`Missing RDP evaluationResult packet for ${stage}`); }
    const result = /** @type {Record<string, unknown>} */ (packet);
    if (result.type !== 'evaluationResult' || result.hasException === true || result.topLevelAwaitRejected === true || (result.exception !== undefined && result.exception !== null)) {
        throw new Error(`RDP evaluation failed at ${stage}: ${JSON.stringify(result)}`);
    }
    const acknowledgement = entry.acknowledgement;
    if (!(acknowledgement && typeof acknowledgement === 'object' && 'resultID' in acknowledgement && acknowledgement.resultID === result.resultID)) {
        throw new Error(`RDP resultID mismatch at ${stage}`);
    }
    const grip = result.result;
    const text = grip !== null && typeof grip === 'object' && 'value' in grip ? grip.value : grip;
    if (typeof text !== 'string') { throw new Error(`RDP ${stage} returned a non-string value: ${JSON.stringify(result)}`); }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`RDP ${stage} returned invalid JSON: ${text.slice(0, 1000)} (${error instanceof Error ? error.message : String(error)})`);
    }
}

/**
 * @param {RuntimeEvaluate} evaluate
 * @param {string} actor
 * @param {string} stage
 * @param {number} timeoutMs
 * @returns {Promise<{phase: string, error: {name: string, message: string, stack: string|null, diagnostic: unknown}|null, imported: DictionaryInfo}>}
 */
async function pollPageState(evaluate, actor, stage, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastState = null;
    while (Date.now() < deadline) {
        lastState = await evaluateJSON(evaluate, actor, '(globalThis.__manabitanAndroidRuntimeQualification||null)', stage);
        if (lastState?.phase === 'failed') { throw new Error(`Owned import operation failed: ${JSON.stringify(lastState.error)}`); }
        if (lastState?.phase === 'import-visible' && typeof lastState.imported === 'object' && lastState.imported !== null) { return /** @type {{phase: string, error: {name: string, message: string, stack: string|null, diagnostic: unknown}|null, imported: DictionaryInfo}} */ (lastState); }
        await new Promise((resolve) => {
            setTimeout(resolve, 250);
        });
    }
    throw new Error(`Timed out after ${timeoutMs}ms polling actual Settings import state: ${JSON.stringify(lastState)}`);
}

/**
 * @returns {Promise<{baseUrl: string, setRevision: (revision: string, archive: ArrayBuffer) => void, close: () => Promise<void>}>}
 */
async function startDictionaryFixtureServer() {
    /** @type {{revision: string, archive: ArrayBuffer}|null} */
    let current = null;
    const server = createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', '*');
        if (request.method === 'OPTIONS') {
            response.writeHead(204).end();
            return;
        }
        if (request.method !== 'GET' || !current) {
            response.writeHead(404).end();
            return;
        }
        if (request.url === '/dictionary/index.json') {
            response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({title: dictionaryTitle, format: 3, revision: current.revision, isUpdatable: true, indexUrl: `${baseUrl}/dictionary/index.json`, downloadUrl: `${baseUrl}/dictionary/current.zip`}));
        } else if (request.url === '/dictionary/current.zip') {
            response.writeHead(200, {'Content-Type': 'application/zip'}).end(Buffer.from(current.archive));
        } else {
            response.writeHead(404).end();
        }
    });
    /** @type {Promise<void>} */
    const listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({port: 0, host: '127.0.0.1'}, () => { resolve(); });
    });
    await listening;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
        baseUrl,
        setRevision: (revision, archive) => { current = {revision, archive}; },
        close: async () => {
            /** @type {Promise<void>} */
            const closed = new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
            await closed;
        },
    };
}

/**
 * @param {string} directory
 * @param {string} revision
 * @param {string} targetGlossary
 * @param {string} baseUrl
 * @returns {Promise<ArrayBuffer>}
 */
async function createQualifiedArchive(directory, revision, targetGlossary, baseUrl) {
    const writer = new ZipWriter(new BlobWriter(), {level: 0});
    let updatedTerm = false;
    try {
        for (const name of await readdir(directory)) {
            const bytes = await readFile(path.join(directory, name));
            let output = bytes;
            if (name === 'index.json') {
                const index = JSON.parse(bytes.toString('utf8'));
                index.title = dictionaryTitle;
                index.revision = revision;
                index.isUpdatable = true;
                index.indexUrl = `${baseUrl}/dictionary/index.json`;
                index.downloadUrl = `${baseUrl}/dictionary/current.zip`;
                output = Buffer.from(JSON.stringify(index));
            } else if (name === 'term_bank_1.json') {
                const entries = /** @type {unknown[]} */ (JSON.parse(bytes.toString('utf8')));
                const entry = entries.find((item) => Array.isArray(item) && item[0] === expression && item[1] === reading && Array.isArray(item[5]) && item[5].includes(glossary));
                assert.ok(entry, `Fixture archive has no exact ${expression}/${reading} term for update`);
                const row = /** @type {unknown[]} */ (entry);
                row[5] = /** @type {unknown[]} */ (row[5]).map((value) => (value === glossary ? targetGlossary : value));
                updatedTerm = true;
                output = Buffer.from(JSON.stringify(entries));
            }
            await writer.add(name, new Uint8ArrayReader(output));
        }
        assert.equal(updatedTerm, true, 'Updated fixture did not modify the intended glossary');
        return await (await writer.close()).arrayBuffer();
    } catch (error) {
        try { await writer.close(); } catch (cleanupError) {
            if (error instanceof Error) { /** @type {Error & {zipCleanupError?: string}} */ (error).zipCleanupError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError); }
        }
        throw error;
    }
}

/**
 * @param {{evaluate: RuntimeEvaluate, settingsActor: string, searchActor: string, adbDevice: string, stage: (name: string, value: unknown) => number}} options
 * @returns {Promise<void>}
 */
/**
 * @param {{scenarioId: string, actions: import('../e2e/anki-mock-state.js').MockActionLog[], snapshots: unknown[]}} scenario
 * @param {import('../e2e/anki-mock-state.js').MockActionLog} addNote
 * @returns {number}
 */
export function assertMiningDeliveryOracle(scenario, addNote) {
    assert.equal(addNote.action, 'addNote');
    assert.equal(addNote.error, null, `Local Anki addNote returned an error: ${JSON.stringify(addNote)}`);
    assert.ok(typeof addNote.result === 'number' && Number.isSafeInteger(addNote.result) && addNote.result > 0, `Local Anki addNote returned no positive note ID: ${JSON.stringify(addNote)}`);
    assert.equal(scenario.actions.filter(({action}) => action === 'addNote').length, 1, 'Expected exactly one addNote action');
    const latest = scenario.snapshots.at(-1);
    assert.ok(typeof latest === 'object' && latest !== null && !Array.isArray(latest), `No final stored-note snapshot: ${JSON.stringify(scenario.snapshots)}`);
    const snapshot = /** @type {Record<string, unknown>} */ (latest);
    assert.equal(snapshot.reason, 'addNote', 'Latest mock snapshot does not record addNote');
    assert.equal(snapshot.noteCount, 2, 'Expected exactly the seed note plus one created note');
    assert.ok(Array.isArray(snapshot.notes), 'Latest mock snapshot has no stored notes');
    const notes = snapshot.notes;
    assert.equal(notes.length, 2, 'Expected exactly the seed note plus one created note');
    const noteId = /** @type {number} */ (addNote.result);
    const created = notes.find((note) => typeof note === 'object' && note !== null && !Array.isArray(note) && Reflect.get(note, 'noteId') === noteId);
    assert.ok(created, `The returned note ID ${noteId} is absent from the stored-note snapshot`);
    assert.deepEqual(created, {
        noteId,
        cardId: 92_002,
        deckName: 'Android Capability Deck',
        modelName: 'Android Capability Model',
        fields: {Front: expression, Back: `${reading} / ${glossary} revision 2`},
        findable: true,
    }, 'Persisted Anki note does not match the exact delivered note');
    const seed = notes.find((note) => typeof note === 'object' && note !== null && !Array.isArray(note) && Reflect.get(note, 'noteId') === 91_001);
    assert.ok(seed, 'The original seed note is missing from the final snapshot');
    return noteId;
}

/**
 * @param {{evaluate: RuntimeEvaluate, backgroundActor: string, settingsActor: string, searchActor: string, adbDevice: string, stage: (name: string, value: unknown) => number}} options
 * @returns {Promise<void>}
 */
async function qualifyMiningAction({evaluate, backgroundActor, settingsActor, searchActor, adbDevice, stage}) {
    assert.ok(adbDevice, 'Android device identity is missing for local mock Anki routing');
    const mockState = createAnkiMockState();
    const server = await startAnkiMockHttpServer(mockState);
    const port = new URL(server.ankiConnectUrl).port;
    let reverseInstalled = false;
    /** @type {(Error & {cleanupErrors?: string[]})|null} */
    let primaryError = null;
    /** @type {Error|null} */
    let cleanupFailure = null;
    try {
        const reverse = await execFileAsync('adb', ['-s', adbDevice, 'reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`], {timeout: 10_000});
        reverseInstalled = true;
        stage('local-mock-anki-route', {device: adbDevice, hostUrl: server.ankiConnectUrl, reverse: String(reverse.stdout || '').trim(), noExternalEndpoint: true});
        mockState.beginScenario('android-capability-mining', [{noteId: 91_001, cardId: 92_001, deckName: 'Android Capability Deck', modelName: 'Android Capability Model', fields: {Front: 'seed', Back: 'seed'}, tags: [], queue: 0, flags: 0, findable: true}]);
        const configured = await evaluateJSON(evaluate, settingsActor, `new Promise((resolve,reject)=>{const call=(action,params)=>new Promise((done,fail)=>browser.runtime.sendMessage({action,params},response=>{const error=browser.runtime.lastError;if(error)fail(new Error(error.message));else if(response?.error)fail(new Error(JSON.stringify(response.error)));else done(response?.result??response)}));(async()=>{const options=await call('optionsGetFull');for(const profile of options.profiles){const anki=profile.options.anki;anki.server='${server.ankiConnectUrl.replace('127.0.0.1', '127.0.0.1')}';anki.apiKey='';anki.enable=true;if(!Array.isArray(anki.cardFormats))throw new Error('Product options have no Anki card-format list');const format=anki.cardFormats.find(value=>value.type==='term');if(!format)throw new Error('Product has no term card format');format.name='Android Capability Model';format.deck='Android Capability Deck';format.model='Android Capability Model';format.fields.Front={...(format.fields.Front||{}),value:'{expression}'};format.fields.Back={...(format.fields.Back||{}),value:'${androidMiningBackTemplate}'};}await call('setAllSettings',{value:options,source:'firefox-android-capability-mining'});resolve({enabled:true,deck:'Android Capability Deck',model:'Android Capability Model',front:'{expression}',back:'${androidMiningBackTemplate}'});})().catch(reject);})`, 'configure-mock-anki');
        stage('configure-mock-anki', configured);
        const settingsFocus = await evaluateJSON(evaluate, backgroundActor, buildOwnedPageActivationScript('settings.html'), 'activate-settings-before-anki-status');
        stage('activate-settings-before-anki-status', settingsFocus);
        const visibleSettings = await evaluateJSON(evaluate, settingsActor, buildDocumentVisibilityWaitScript('settings.html'), 'wait-settings-visible-before-anki-status');
        stage('settings-visible-before-anki-status', visibleSettings);
        const ready = await evaluateJSON(evaluate, settingsActor, 'new Promise((resolve,reject)=>{const deadline=Date.now()+30000;const inspect=()=>{const message=document.querySelector(\'#anki-error-message\');const text=message instanceof HTMLElement?message.textContent||\'\':\'\';if(text.trim()===\'Connected\'){resolve({message:text});return;}if(Date.now()>deadline){reject(new Error(\'Product Settings Anki connection did not report Connected: \'+text));return;}setTimeout(inspect,250);};inspect();})', 'wait-mock-anki-connected');
        stage('mock-anki-connected', ready);
        const searchFocus = await evaluateJSON(evaluate, backgroundActor, buildOwnedPageActivationScript('search.html', {searchQuery: expression}), 'activate-search-before-mining-click');
        stage('activate-search-before-mining-click', searchFocus);
        const visibleSearch = await evaluateJSON(evaluate, searchActor, buildDocumentVisibilityWaitScript('search.html', {searchQuery: expression}), 'wait-search-visible-before-mining-click');
        stage('search-visible-before-mining-click', visibleSearch);
        const miningClickScript = `new Promise((resolve,reject)=>{const deadline=Date.now()+30000;const visible=node=>{const rect=node?.getBoundingClientRect();const style=node&&getComputedStyle(node);const consentModal=document.querySelector('#firefox-data-transmission-consent-modal');let shown=Boolean(rect&&style&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&!(consentModal instanceof HTMLElement&&!consentModal.hidden));for(let parent=node;shown&&parent instanceof HTMLElement;parent=parent.parentElement){if(parent.hidden||parent.getAttribute('aria-hidden')==='true')shown=false;}return {visible:shown,width:rect?.width||0,height:rect?.height||0,display:style?.display||'',visibility:style?.visibility||'',consentModalVisible:consentModal instanceof HTMLElement&&!consentModal.hidden};};const inspect=()=>{const entry=[...document.querySelectorAll('#dictionary-entries .entry')].find(entry=>[...entry.querySelectorAll('.headword')].some(headword=>{const term=headword.querySelector('.headword-term');const reading=headword.querySelector('.headword-reading');const copy=term?.cloneNode(true);for(const node of copy?.querySelectorAll('rt,rp')||[])node.remove();return String(copy?.textContent||'').replace(/\\s+/g,'').trim()===${JSON.stringify(expression)}&&String(reading?.textContent||'').trim()===${JSON.stringify(reading)};})&&[...entry.querySelectorAll('.definition-item[data-dictionary]')].some(item=>item.dataset.dictionary===${JSON.stringify(dictionaryTitle)}&&[...item.querySelectorAll('.gloss-content')].some(node=>String(node.textContent||'').includes(${JSON.stringify(`${glossary} revision 2`)}))));const button=entry?.querySelector('.note-actions-container .action-button[data-action="save-note"]');const render=button instanceof HTMLButtonElement?visible(button):{visible:false};if(button instanceof HTMLButtonElement&&!button.disabled&&render.visible){button.click();resolve({clicked:true,selector:button.dataset.action,render});return;}if(Date.now()>deadline){reject(new Error('Shipped Search save-note button did not become enabled and rendered: '+JSON.stringify(render)));return;}setTimeout(inspect,250);};inspect();})`;
        const clicked = await evaluateJSON(evaluate, searchActor, miningClickScript, 'click-mining-ui');
        assert.equal(clicked.render?.visible, true, `Mining save-note action was not visibly rendered and unoccluded: ${JSON.stringify(clicked)}`);
        stage('mining-ui-action', clicked);
        const deadline = Date.now() + 30_000;
        /** @type {import('../e2e/anki-mock-state.js').MockActionLog|null} */
        let addNote = null;
        while (Date.now() < deadline) {
            const actions = mockState.getScenarioState().actions.filter(({action}) => action === 'addNote');
            if (actions.length > 1) { throw new Error(`Expected exactly one addNote; observed ${actions.length}`); }
            if (actions.length === 1) {
                addNote = actions[0];
                await new Promise((resolve) => { setTimeout(resolve, 1500); });
                const settledActions = mockState.getScenarioState().actions;
                const writeActions = new Set(['addNote', 'addNotes', 'updateNote', 'updateNoteFields', 'updateNoteTags', 'deleteNote', 'deleteNotes', 'addTags', 'removeTags', 'suspend', 'unsuspend', 'bury', 'unbury', 'setDueDate', 'changeDeck', 'changeModel', 'forgetCards', 'repositionCards']);
                const writes = settledActions.filter(({action}) => writeActions.has(action));
                assert.equal(writes.filter(({action}) => action === 'addNote').length, 1, `Expected exactly one addNote after settling: ${JSON.stringify(writes)}`);
                assert.deepEqual(writes.map(({action}) => action), ['addNote'], `Unexpected Anki write actions after settling: ${JSON.stringify(writes)}`);
                break;
            }
            await new Promise((resolve) => { setTimeout(resolve, 250); });
        }
        assert.ok(addNote, `No addNote reached local mock service; observed=${JSON.stringify(mockState.getScenarioState().actions)}`);
        const note = addNote.params.note;
        assert.ok(typeof note === 'object' && note !== null && !Array.isArray(note), `Mining addNote has no note payload: ${JSON.stringify(addNote)}`);
        const noteRecord = /** @type {Record<string, unknown>} */ (note);
        assert.equal(noteRecord.deckName, 'Android Capability Deck');
        assert.equal(noteRecord.modelName, 'Android Capability Model');
        assert.ok(typeof noteRecord.fields === 'object' && noteRecord.fields !== null && !Array.isArray(noteRecord.fields), `Mining addNote has no fields: ${JSON.stringify(noteRecord)}`);
        const noteFields = /** @type {Record<string, unknown>} */ (noteRecord.fields);
        assert.equal(noteFields.Front, expression);
        assert.equal(noteFields.Back, `${reading} / ${glossary} revision 2`, `Mining payload reading/glossary mismatch: ${JSON.stringify(noteRecord)}`);
        const scenario = mockState.getScenarioState();
        assertMiningDeliveryOracle(scenario, addNote);
        stage('mock-anki-add-note-oracle', {actionLog: addNote, scenarioSnapshots: scenario.snapshots, scenarioActions: scenario.actions, exactlyOneAddNote: true});
    } catch (error) {
        primaryError = error instanceof Error ? /** @type {Error & {cleanupErrors?: string[]}} */ (error) : new Error(String(error));
        throw error;
    } finally {
        /** @type {string[]} */
        const cleanupErrors = [];
        if (reverseInstalled) {
            try {
                await execFileAsync('adb', ['-s', adbDevice, 'reverse', '--remove', `tcp:${port}`], {timeout: 10_000});
            } catch (error) {
                cleanupErrors.push(error instanceof Error ? error.message : String(error));
            }
        }
        try {
            await server.close();
        } catch (error) {
            cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
        if (cleanupErrors.length > 0) {
            if (primaryError) {
                primaryError.cleanupErrors = cleanupErrors;
            } else {
                cleanupFailure = new AggregateError(cleanupErrors.map((message) => new Error(message)), 'Mining fixture cleanup failed');
            }
        }
    }
    if (cleanupFailure) { throw cleanupFailure; }
}
