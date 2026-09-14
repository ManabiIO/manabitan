from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}')
    p.write_text(text.replace(old, new, 1))


backend = 'ext/js/background/backend.js'
replace_once(
    backend,
    '''        /** @type {?Promise<void>} */
        this._preparePromise = null;
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const {promise, resolve, reject} = deferPromise();
''',
    '''        /** @type {?Promise<void>} */
        this._preparePromise = null;
        /** @type {boolean} */
        this._prepareInternalSyncComplete = false;
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const {promise, resolve, reject} = deferPromise();
''',
)
replace_once(
    backend,
    '''    prepare() {
        if (this._preparePromise === null) {
            const promise = this._prepareInternal();
            promise.then(
                () => {
                    this._isPrepared = true;
                    this._prepareCompleteResolve();
                },
                (error) => {
                    this._prepareError = true;
                    this._prepareCompleteReject(error);
                },
            );
            void promise.finally(() => this._updateBadge());
            this._preparePromise = promise;
        }
        return this._prepareCompletePromise;
    }
''',
    '''    prepare() {
        if (this._preparePromise === null) {
            if (this._prepareError) {
                const deferred = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
                this._prepareCompletePromise = deferred.promise;
                this._prepareCompleteResolve = deferred.resolve;
                this._prepareCompleteReject = deferred.reject;
                this._prepareError = false;
            }
            const promise = this._prepareInternal();
            this._preparePromise = promise;
            void promise.then(
                () => {
                    this._isPrepared = true;
                    this._prepareCompleteResolve();
                    this._updateBadge();
                },
                (error) => {
                    if (this._preparePromise === promise) {
                        this._preparePromise = null;
                    }
                    this._prepareError = true;
                    this._prepareCompleteReject(error);
                    this._updateBadge();
                },
            );
        }
        return this._prepareCompletePromise;
    }
''',
)
replace_once(
    backend,
    '''            {
                const startedAt = safePerformance.now();
                this._prepareInternalSync();
                recordPhase('_prepareInternalSync', startedAt);
            }
''',
    '''            if (!this._prepareInternalSyncComplete) {
                const startedAt = safePerformance.now();
                this._prepareInternalSync();
                this._prepareInternalSyncComplete = true;
                recordPhase('_prepareInternalSync', startedAt);
            }
''',
)
replace_once(
    backend,
    '''    _getOrCreateSearchPopupWrapper() {
        if (this._searchPopupTabCreatePromise === null) {
            const promise = this._getOrCreateSearchPopup();
            this._searchPopupTabCreatePromise = promise;
            void promise.then(() => { this._searchPopupTabCreatePromise = null; });
        }
        return this._searchPopupTabCreatePromise;
    }
''',
    '''    _getOrCreateSearchPopupWrapper() {
        if (this._searchPopupTabCreatePromise === null) {
            const promise = this._getOrCreateSearchPopup();
            this._searchPopupTabCreatePromise = promise;
            const clearPromise = () => {
                if (this._searchPopupTabCreatePromise === promise) {
                    this._searchPopupTabCreatePromise = null;
                }
            };
            void promise.then(clearPromise, clearPromise);
        }
        return this._searchPopupTabCreatePromise;
    }
''',
)
replace_once(
    backend,
    '''    async _runDictionaryMutation(task) {
        await this._awaitDictionaryMutationSettled();
        this._dictionaryMutationPromise = (async () => {
            await task();
        })();
        try {
            await this._dictionaryMutationPromise;
        } finally {
            this._dictionaryMutationPromise = null;
        }
    }
''',
    '''    async _runDictionaryMutation(task) {
        const previousPromise = this._dictionaryMutationPromise;
        const mutationPromise = (async () => {
            if (previousPromise !== null) {
                try {
                    await previousPromise;
                } catch (_) {
                    // A prior failed mutation must not poison later queued mutations.
                }
            }
            await task();
        })();
        this._dictionaryMutationPromise = mutationPromise;
        try {
            await mutationPromise;
        } finally {
            if (this._dictionaryMutationPromise === mutationPromise) {
                this._dictionaryMutationPromise = null;
            }
        }
    }
''',
)

offscreen = 'ext/js/background/offscreen-proxy.js'
replace_once(
    offscreen,
    '''    async prepare() {
        if (await this._hasOffscreenDocument()) {
            await this._ensureOffscreenPort();
            return;
        }
        if (this._creatingOffscreen) {
            await this._creatingOffscreen;
            return;
        }
        this._creatingOffscreen = (async () => {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: [
                    /** @type {chrome.offscreen.Reason} */ ('CLIPBOARD'),
                ],
                justification: 'Access to the clipboard',
            });
            await this._ensureOffscreenPort();
        })();
        try {
            await this._creatingOffscreen;
        } finally {
            this._creatingOffscreen = null;
        }
    }
''',
    '''    async prepare() {
        await this._ensureOffscreenDocument();
        await this._ensureOffscreenPort();
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureOffscreenDocument() {
        if (await this._hasOffscreenDocument()) { return; }
        if (this._creatingOffscreen !== null) {
            await this._creatingOffscreen;
            return;
        }
        this._creatingOffscreen = (async () => {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: [
                    /** @type {chrome.offscreen.Reason} */ ('CLIPBOARD'),
                ],
                justification: 'Access to the clipboard',
            });
        })();
        try {
            await this._creatingOffscreen;
        } finally {
            this._creatingOffscreen = null;
        }
    }
''',
)
replace_once(
    offscreen,
    '''    async sendMessagePromise(message) {
        const response = await this._webExtension.sendMessagePromise(message);
        return this._getMessageResponseResult(/** @type {import('core').Response<import('offscreen').ApiReturn<TMessageType>>} */ (response));
    }
''',
    '''    async sendMessagePromise(message) {
        await this._ensureOffscreenDocument();
        const response = await this._webExtension.sendMessagePromise(message);
        return this._getMessageResponseResult(/** @type {import('core').Response<import('offscreen').ApiReturn<TMessageType>>} */ (response));
    }
''',
)
