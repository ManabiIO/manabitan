from pathlib import Path


def replace_once(path, old, new):
    file_path = Path(path)
    text = file_path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}')
    file_path.write_text(text.replace(old, new, 1))


offscreen = 'ext/js/background/offscreen-proxy.js'
replace_once(
    offscreen,
    '''    async prepare() {
        await this._ensureOffscreenDocument();
        await this._ensureOffscreenPort();
    }
''',
    '''    async prepare() {
        await this._ensureOffscreenPort();
    }
''',
)
replace_once(
    offscreen,
    '''    async _ensureOffscreenPort() {
        if (this._currentOffscreenPort !== null) {
            return;
        }
        if (this._registeringOffscreenPort !== null) {
            await this._registeringOffscreenPort;
            return;
        }
        this._registeringOffscreenPort = (async () => {
            await this.sendMessagePromise({action: 'createAndRegisterPortOffscreen'});
            await Promise.race([
                this._offscreenPortReadyPromise,
                new Promise((resolve, reject) => {
                    setTimeout(() => reject(new Error('Timed out waiting for offscreen control port registration')), 5000);
                }),
            ]);
        })();
        try {
            await this._registeringOffscreenPort;
        } finally {
            this._registeringOffscreenPort = null;
        }
    }
''',
    '''    async _ensureOffscreenPort() {
        if (this._currentOffscreenPort !== null) {
            return;
        }
        if (this._registeringOffscreenPort !== null) {
            await this._registeringOffscreenPort;
            return;
        }
        this._registeringOffscreenPort = (async () => {
            await this._ensureOffscreenDocument();
            if (this._currentOffscreenPort !== null) { return; }
            const response = await this._webExtension.sendMessagePromise({action: 'createAndRegisterPortOffscreen'});
            this._getMessageResponseResult(/** @type {import('core').Response<void>} */ (response));
            await Promise.race([
                this._offscreenPortReadyPromise,
                new Promise((resolve, reject) => {
                    setTimeout(() => reject(new Error('Timed out waiting for offscreen control port registration')), 5000);
                }),
            ]);
        })();
        try {
            await this._registeringOffscreenPort;
        } finally {
            this._registeringOffscreenPort = null;
        }
    }
''',
)

controller = 'ext/js/pages/settings/dictionary-controller.js'
replace_once(
    controller,
    '''    async _updateDictionary(dictionaryTitle, downloadUrl) {
        if (this._checkingIntegrity || this._checkingUpdates || this._dictionaries === null) { return; }

        const dictionaryInfo = this._dictionaries.find((entry) => entry.title === dictionaryTitle);
        if (typeof dictionaryInfo === 'undefined') { throw new Error('Dictionary not found'); }
        downloadUrl = downloadUrl ?? dictionaryInfo.downloadUrl;
''',
    '''    async _updateDictionary(dictionaryTitle, downloadUrl) {
        if (this._checkingIntegrity || this._checkingUpdates) { return; }

        const dictionaryInfo = await this._getDictionaryInfoForTask(dictionaryTitle);
        dictionaryTitle = dictionaryInfo.title;
        downloadUrl = downloadUrl ?? dictionaryInfo.downloadUrl;
''',
)
replace_once(
    controller,
    '''    /**
     * @returns {number}
     */
    _getMutationCallbackTimeoutMs() {
''',
    '''    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<import('dictionary-importer').Summary>}
     */
    async _getDictionaryInfoForTask(dictionaryTitle) {
        const dictionaries = this._dictionaries ?? await this._settingsController.getDictionaryInfo();
        const exactMatch = dictionaries.find((entry) => entry.title === dictionaryTitle);
        if (typeof exactMatch !== 'undefined') { return exactMatch; }

        const normalizedTaskTitle = this._getDictionaryTaskMatchTitle(dictionaryTitle);
        const matches = dictionaries.filter((entry) => {
            const normalizedInstalledTitle = this._getDictionaryTaskMatchTitle(entry.title);
            return (
                normalizedInstalledTitle === normalizedTaskTitle ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle} `) ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle}.`) ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle}[`)
            );
        });
        if (matches.length === 1) { return matches[0]; }
        if (matches.length > 1) {
            throw new Error(`Dictionary update task title is ambiguous: ${dictionaryTitle}`);
        }
        throw new Error(`Dictionary not found: ${dictionaryTitle}`);
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
            .toLowerCase();
    }

    /**
     * @returns {number}
     */
    _getMutationCallbackTimeoutMs() {
''',
)
replace_once(
    controller,
    '''            /** @type {import('settings').DictionaryOptions[]} */
            const profileMatches = [];
''',
    '''            /** @type {import('settings-controller.js').ProfileDictionarySettings[]} */
            const profileMatches = [];
''',
)
