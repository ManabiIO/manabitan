/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {Application} from '../application.js';
import {HotkeyHandler} from '../input/hotkey-handler.js';
import {Frontend} from './frontend.js';
import {PopupFactory} from './popup-factory.js';

const {documentElement} = document;
if (documentElement !== null) {
    documentElement.dataset.manabitanContentScriptLoaded = 'true';
}

await Application.main(false, async (application) => {
    const hotkeyHandler = new HotkeyHandler();
    hotkeyHandler.prepare(application.crossFrame);

    const popupFactory = new PopupFactory(application);
    popupFactory.prepare();

    const frontend = new Frontend({
        application,
        popupFactory,
        depth: 0,
        parentPopupId: null,
        parentFrameId: null,
        useProxyPopup: false,
        pageType: 'web',
        canUseWindowPopup: true,
        allowRootFramePopupProxy: true,
        childrenSupported: true,
        hotkeyHandler,
    });
    await frontend.prepare();
    if (documentElement !== null) {
        documentElement.dataset.manabitanContentScriptPrepared = 'true';
    }

    // A reader click can open the existing recommended-dictionary UI with one
    // fixed dictionary selected. Keep this bridge narrow: no page-supplied URL,
    // dictionary name, or extension command is accepted.
    if (window === window.top && (
        window.location.origin === 'https://reader.manabi.io' ||
        window.location.origin === 'https://manabi.io'
    )) {
        document.addEventListener('click', (event) => {
            if (!event.isTrusted || !(event.target instanceof Element)) { return; }
            if (event.target.closest('[data-manabitan-install-jitendex="true"]') === null) { return; }
            void application.api.commandExec('openReaderJitendexSetup');
        }, true);
        const markReaderBridge = () => {
            const root = document.documentElement;
            if (root === null) { return false; }
            root.dataset.manabitanReaderJitendexBridge = 'true';
            return true;
        };
        if (!markReaderBridge()) {
            const observer = new MutationObserver(() => {
                if (markReaderBridge()) { observer.disconnect(); }
            });
            observer.observe(document, {childList: true});
        }
    }
});
