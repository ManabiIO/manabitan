from pathlib import Path


def replace_once(path, old, new):
    file_path = Path(path)
    text = file_path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}')
    file_path.write_text(text.replace(old, new, 1))


def replace_async_method(path, name, replacement):
    file_path = Path(path)
    text = file_path.read_text()
    marker = f'    async {name}('
    if text.count(marker) != 1:
        raise SystemExit(f'{path}: expected one async method {name}')
    start = text.index(marker)
    end = text.index('\n    }\n', start) + len('\n    }\n')
    file_path.write_text(text[:start] + replacement + text[end:])


backend = 'ext/js/background/backend.js'
replace_async_method(backend, '_runDictionaryMutation', '''    async _runDictionaryMutation(task) {
        const previousPromise = this._dictionaryMutationPromise
        // Publish the tail before any caller-provided task can re-enter this queue.
        const mutationPromise = Promise.resolve().then(async () => {
            if (previousPromise !== null) {
                try {
                    await previousPromise
                } catch (_) {
                    // A prior failed mutation must not poison later queued mutations.
                }
            }
            await task()
        })
        this._dictionaryMutationPromise = mutationPromise
        try {
            await mutationPromise
        } finally {
            if (this._dictionaryMutationPromise === mutationPromise) {
                this._dictionaryMutationPromise = null
            }
        }
    }
''')

offscreen = 'ext/js/background/offscreen-proxy.js'
replace_once(offscreen, '''    async prepare() {
        await this._ensureOffscreenDocument();
        await this._ensureOffscreenPort();
    }
''', '''    async prepare() {
        await this._ensureOffscreenPort()
    }
''')
replace_async_method(offscreen, '_ensureOffscreenDocument', '''    async _ensureOffscreenDocument() {
        if (this._creatingOffscreen !== null) {
            await this._creatingOffscreen
            return
        }
        // Share the existence probe too: a delayed negative probe must not recreate
        // a document which another caller has just finished creating.
        const creatingPromise = (async () => {
            if (await this._hasOffscreenDocument()) { return }
            const port = this._currentOffscreenPort
            if (port) { this._clearCurrentOffscreenPort(port) }
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: [/** @type {chrome.offscreen.Reason} */ ('CLIPBOARD')],
                justification: 'Access to the clipboard',
            })
        })()
        this._creatingOffscreen = creatingPromise
        try {
            await creatingPromise
        } finally {
            if (this._creatingOffscreen === creatingPromise) {
                this._creatingOffscreen = null
            }
        }
    }
''')
replace_async_method(offscreen, '_ensureOffscreenPort', '''    async _ensureOffscreenPort() {
        if (this._registeringOffscreenPort !== null) {
            await this._registeringOffscreenPort
            return
        }
        const registeringPromise = (async () => {
            // A closed document can leave a non-null port which silently drops sends.
            await this._ensureOffscreenDocument()
            if (this._currentOffscreenPort !== null) { return }
            // Bootstrap directly; never re-enter a public lifecycle-recovering send.
            const response = await this._webExtension.sendMessagePromise({action: 'createAndRegisterPortOffscreen'})
            this._getMessageResponseResult(/** @type {import('core').Response<void>} */ (response))
            /** @type {ReturnType<typeof setTimeout>|undefined} */
            let timeout
            try {
                await Promise.race([
                    this._offscreenPortReadyPromise,
                    new Promise((resolve, reject) => {
                        timeout = setTimeout(() => reject(new Error('Timed out waiting for offscreen control port registration')), 5000)
                    }),
                ])
            } finally {
                clearTimeout(timeout)
            }
        })()
        this._registeringOffscreenPort = registeringPromise
        try {
            await registeringPromise
        } finally {
            if (this._registeringOffscreenPort === registeringPromise) {
                this._registeringOffscreenPort = null
            }
        }
    }
''')

controller = 'ext/js/pages/settings/dictionary-controller.js'
replace_once(controller, '''    async _updateDictionary(dictionaryTitle, downloadUrl) {
        if (this._checkingIntegrity || this._checkingUpdates || this._dictionaries === null) { return; }

        const dictionaryInfo = this._dictionaries.find((entry) => entry.title === dictionaryTitle);
        if (typeof dictionaryInfo === 'undefined') { throw new Error('Dictionary not found'); }
        downloadUrl = downloadUrl ?? dictionaryInfo.downloadUrl;
''', '''    async _updateDictionary(dictionaryTitle, downloadUrl) {
        if (this._checkingIntegrity || this._checkingUpdates) { return }

        const dictionaryInfo = await this._getDictionaryInfoForTask(dictionaryTitle)
        dictionaryTitle = dictionaryInfo.title
        downloadUrl = downloadUrl ?? dictionaryInfo.downloadUrl
''')
replace_once(controller, '''    /**
     * @returns {number}
     */
    _getMutationCallbackTimeoutMs() {
''', '''    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<import('dictionary-importer').Summary>}
     */
    async _getDictionaryInfoForTask(dictionaryTitle) {
        const dictionaries = this._dictionaries ?? await this._settingsController.getDictionaryInfo()
        const exactMatch = dictionaries.find((entry) => entry.title === dictionaryTitle)
        if (typeof exactMatch !== 'undefined') { return exactMatch }

        const normalizedTaskTitle = this._getDictionaryTaskMatchTitle(dictionaryTitle)
        if (normalizedTaskTitle.length === 0) { throw new Error('Dictionary update task title is empty') }
        const matches = dictionaries.filter((entry) => {
            const normalizedInstalledTitle = this._getDictionaryTaskMatchTitle(entry.title)
            return (
                normalizedInstalledTitle === normalizedTaskTitle ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle} `) ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle}.`) ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle}[`)
            )
        })
        if (matches.length === 1) { return matches[0] }
        if (matches.length > 1) {
            throw new Error(`Dictionary update task title is ambiguous: ${dictionaryTitle}`)
        }
        throw new Error(`Dictionary not found: ${dictionaryTitle}`)
    }

    /**
     * @param {unknown} title
     * @returns {string}
     */
    _getDictionaryTaskMatchTitle(title) {
        return (typeof title === 'string' ? title : '')
            .replace(TRANSIENT_UPDATE_TITLE_PATTERN, '')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase()
    }

    /**
     * @returns {number}
     */
    _getMutationCallbackTimeoutMs() {
''')
replace_once(controller, '''            /** @type {import('settings').DictionaryOptions[]} */
            const profileMatches = [];
''', '''            /** @type {import('settings-controller').ProfileDictionarySettings[]} */
            const profileMatches = [];
''')

fixture = 'test/dictionary-import-controller-update-profile.test.js'
replace_once(fixture, 'finalizeImportSession: boolean, onProgress:', 'finalizeImportSession: boolean, importRunGeneration: number, onProgress:')
replace_once(fixture, '''        const controller = createControllerForInternalTests();
''', '''        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_activeImportRunGeneration', 1)
''')
replace_once(fixture, '''            false,
            false,
            vi.fn(),
''', '''            false,
            false,
            1,
            vi.fn(),
''')
replace_once(fixture, 'expect(result.errors).toHaveLength(0);', 'expect(result.errors).toEqual([])')

replace_once('test/runtime-reliability-lifecycle.test.js', '''    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = () => { resolvePromise(undefined) }
        reject = rejectPromise
    })
''', '''    const promise = /** @type {Promise<void>} */ (new Promise((resolvePromise, rejectPromise) => {
        resolve = () => { resolvePromise(undefined) }
        reject = rejectPromise
    }))
''')
