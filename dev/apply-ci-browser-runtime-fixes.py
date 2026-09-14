from pathlib import Path


def replace_exact(path, old, new, expected_count=1):
    file_path = Path(path)
    text = file_path.read_text()
    count = text.count(old)
    if count != expected_count:
        raise SystemExit(f'{path}: expected {expected_count} matches, got {count}')
    file_path.write_text(text.replace(old, new))


ci = '.github/workflows/ci.yml'
old_enforce = '''          const opfsReady = runtime !== null && (
            runtime.hasStorageGetDirectory === true &&
            runtime.hasCreateSyncAccessHandle === true &&
            runtime.hasOpfsSahpoolVfs === true &&
            runtime.openStorageMode === 'opfs-sahpool'
          );
'''
new_enforce = '''          const openStorageDiagnostics = runtime && typeof runtime.openStorageDiagnostics === 'object' && runtime.openStorageDiagnostics !== null ?
            runtime.openStorageDiagnostics :
            null;
          const workerRuntimeContext = openStorageDiagnostics && typeof openStorageDiagnostics.runtimeContext === 'object' && openStorageDiagnostics.runtimeContext !== null ?
            openStorageDiagnostics.runtimeContext :
            null;
          const opfsReady = runtime !== null && (
            (runtime.hasStorageGetDirectory === true || workerRuntimeContext?.hasStorageGetDirectory === true) &&
            (runtime.hasCreateSyncAccessHandle === true || workerRuntimeContext?.hasCreateSyncAccessHandle === true) &&
            runtime.hasOpfsSahpoolVfs === true &&
            runtime.openStorageMode === 'opfs-sahpool'
          );
'''
replace_exact(ci, old_enforce, new_enforce, expected_count=2)

old_summary = '''          const opfsReady = runtime ? (
            runtime.hasStorageGetDirectory === true &&
            runtime.hasCreateSyncAccessHandle === true &&
            runtime.hasOpfsSahpoolVfs === true &&
            runtime.openStorageMode === 'opfs-sahpool'
          ) : null;
'''
new_summary = '''          const openStorageDiagnostics = runtime && typeof runtime.openStorageDiagnostics === 'object' && runtime.openStorageDiagnostics !== null ?
            runtime.openStorageDiagnostics :
            null;
          const workerRuntimeContext = openStorageDiagnostics && typeof openStorageDiagnostics.runtimeContext === 'object' && openStorageDiagnostics.runtimeContext !== null ?
            openStorageDiagnostics.runtimeContext :
            null;
          const opfsReady = runtime ? (
            (runtime.hasStorageGetDirectory === true || workerRuntimeContext?.hasStorageGetDirectory === true) &&
            (runtime.hasCreateSyncAccessHandle === true || workerRuntimeContext?.hasCreateSyncAccessHandle === true) &&
            runtime.hasOpfsSahpoolVfs === true &&
            runtime.openStorageMode === 'opfs-sahpool'
          ) : null;
'''
replace_exact(ci, old_summary, new_summary, expected_count=2)

firefox = 'test/firefox/extension-two-dictionary-import.e2e.js'
old_jsdoc = '''/**
 * @param {import('selenium-webdriver').ThenableWebDriver} driver
 * @returns {Promise<string>}
 * @throws {Error}
 */
'''
new_jsdoc = '''/**
 * @param {import('selenium-webdriver').ThenableWebDriver} _driver
 * @param {string} [installedAddonId]
 * @returns {Promise<string>}
 */
'''
old_firefox = r'''async function waitForExtensionBaseUrl(driver, installedAddonId = '') {
    const normalizedAddonId = String(installedAddonId || '').trim();
    const expectedBaseUrl = normalizedAddonId.length > 0 ? `moz-extension://${normalizedAddonId}` : '';
    const deadline = Date.now() + 30_000;
    let fallbackBaseUrl = '';
    while (Date.now() < deadline) {
        const handlesUnknown = /** @type {unknown} */ (await driver.getAllWindowHandles());
        const handles = Array.isArray(handlesUnknown) ? handlesUnknown.map(String) : [];
        for (const handle of handles) {
            await driver.switchTo().window(handle);
            const url = String(await driver.getCurrentUrl());
            const match = /^(moz-extension:\/\/[^/]+)(?:\/|$)/.exec(url);
            if (match !== null) {
                fallbackBaseUrl = match[1];
                if (expectedBaseUrl.length === 0 || expectedBaseUrl === match[1]) {
                    return match[1];
                }
            }
        }
        await driver.sleep(500);
    }
    if (fallbackBaseUrl.length > 0) {
        return fallbackBaseUrl;
    }
    if (expectedBaseUrl.length > 0) {
        return expectedBaseUrl;
    }
    fail('Failed to discover moz-extension base URL from open tabs.');
}
'''
new_firefox = '''async function waitForExtensionBaseUrl(_driver, installedAddonId = '') {
    const normalizedAddonId = String(installedAddonId || '').trim();
    if (
        normalizedAddonId.length > 0 &&
        normalizedAddonId !== firefoxDevGeckoId &&
        normalizedAddonId !== firefoxDevExtensionUuid
    ) {
        console.warn(`[firefox-e2e] installed add-on id differs from configured development id: ${normalizedAddonId}`);
    }
    // The test profile explicitly pins the add-on ID to firefoxDevExtensionUuid
    // through extensions.webextensions.uuids. Enumerating windows immediately
    // after install can issue an unsupported WebDriver command while Firefox is
    // still in privileged scope, so use the deterministic UUID we configured.
    return `moz-extension://${firefoxDevExtensionUuid}`;
}
'''

file_text = Path(firefox).read_text()
function_offset = file_text.index("async function waitForExtensionBaseUrl(driver, installedAddonId = '')")
jsdoc_offset = file_text.rfind('/**', 0, function_offset)
jsdoc_end = file_text.index(' */\n', jsdoc_offset) + len(' */\n')
if file_text[jsdoc_offset:jsdoc_end] != old_jsdoc:
    raise SystemExit('Firefox waitForExtensionBaseUrl JSDoc did not match expected baseline')
file_text = file_text[:jsdoc_offset] + new_jsdoc + file_text[jsdoc_end:]
if file_text.count(old_firefox) != 1:
    raise SystemExit(f'Firefox waitForExtensionBaseUrl body expected once, got {file_text.count(old_firefox)}')
Path(firefox).write_text(file_text.replace(old_firefox, new_firefox, 1))
