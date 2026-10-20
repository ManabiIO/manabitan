/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {ExtensionError} from '../../core/extension-error.js';
import {parseJson} from '../../core/json.js';
import {log} from '../../core/log.js';
import {convertElementValueToNumber} from '../../dom/document-util.js';
import {DOMDataBinder} from '../../dom/dom-data-binder.js';
import {getDictionaryRowOwnership} from './dictionary-row-ownership.js';

export class GenericSettingController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('settings-modifications').OptionsScopeType} */
        this._defaultScope = 'profile';
        const optionsContext = settingsController.getOptionsContext();
        /** @type {import('settings').OptionsContext2} */
        this._readyOptionsContext = {...optionsContext, profileId: optionsContext.profileId ?? null};
        /** @type {number} */
        this._viewGeneration = 0;
        /** @type {DOMDataBinder<import('generic-setting-controller').ElementMetadata>} */
        this._dataBinder = this._createDataBinder(false);
        /** @type {DOMDataBinder<import('generic-setting-controller').ElementMetadata>} */
        this._globalDataBinder = this._createDataBinder(true);
        /** @type {Map<import('generic-setting-controller').TransformType, import('generic-setting-controller').TransformFunction>} */
        this._transforms = new Map(/** @type {[key: import('generic-setting-controller').TransformType, value: import('generic-setting-controller').TransformFunction][]} */ ([
            ['setAttribute', this._setAttribute.bind(this)],
            ['setVisibility', this._setVisibility.bind(this)],
            ['splitTags', this._splitTags.bind(this)],
            ['joinTags', this._joinTags.bind(this)],
            ['toNumber', this._toNumber.bind(this)],
            ['toBoolean', this._toBoolean.bind(this)],
            ['toString', this._toString.bind(this)],
            ['conditionalConvert', this._conditionalConvert.bind(this)],
        ]));
    }

    /** */
    async prepare() {
        this._dataBinder.observe(document.body);
        this._globalDataBinder.observe(document.body);
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
    }

    /** */
    async refresh() {
        await Promise.all([this._dataBinder.refresh(), this._globalDataBinder.refresh()]);
    }

    // Private

    /**
     * @param {import('settings-controller').Events['optionsChanged']} event
     */
    _onOptionsChanged({optionsContext}) {
        const readyOptionsContext = /** @type {import('settings').OptionsContext2} */ (optionsContext);
        const previousProfileId = this._readyOptionsContext.profileId;
        this._readyOptionsContext = {...readyOptionsContext, profileId: readyOptionsContext.profileId ?? null};
        void this._globalDataBinder.refresh().catch((error) => { log.error(error); });
        if (previousProfileId !== this._readyOptionsContext.profileId) {
            ++this._viewGeneration;
            this._dataBinder.disconnect();
            this._dataBinder = this._createDataBinder(false);
            this._dataBinder.observe(document.body);
            return;
        }
        void this._dataBinder.refresh().catch((error) => {
            log.error(error);
        });
    }

    /**
     * @param {boolean} globalScope
     * @returns {DOMDataBinder<import('generic-setting-controller').ElementMetadata>}
     */
    _createDataBinder(globalScope) {
        const scope = globalScope ? '[data-scope="global"]' : ':not([data-scope="global"])';
        return new DOMDataBinder(
            [`[data-setting]${scope}`, `[data-permissions-setting]${scope}`],
            this._createElementMetadata.bind(this),
            this._compareElementMetadata.bind(this),
            this._getValues.bind(this),
            this._setValues.bind(this),
        );
    }

    /**
     * @param {Element} element
     * @returns {import('generic-setting-controller').ElementMetadata|undefined}
     */
    _createElementMetadata(element) {
        if (!(element instanceof HTMLElement)) { return void 0; }
        const {scope, transform: transformRaw} = element.dataset;
        const path = element.dataset.setting ?? element.dataset.permissionsSetting;
        if (typeof path !== 'string') { return void 0; }
        const scope2 = this._normalizeScope(scope);
        const dictionaryRowOwnership = getDictionaryRowOwnership(element);
        const effectiveScope = scope2 !== null ? scope2 : this._defaultScope;
        const profileOwnership = (
            effectiveScope === 'profile' ?
                {profileId: this._readyOptionsContext.profileId ?? null, viewGeneration: this._viewGeneration, optionsContext: {...this._readyOptionsContext}} :
                void 0
        );
        return {
            path,
            scope: effectiveScope,
            transforms: this._getTransformDataArray(transformRaw),
            transformRaw,
            dictionaryRowOwnership,
            profileOwnership,
        };
    }

    /**
     * @param {import('generic-setting-controller').ElementMetadata} metadata1
     * @param {import('generic-setting-controller').ElementMetadata} metadata2
     * @returns {boolean}
     */
    _compareElementMetadata(metadata1, metadata2) {
        return (
            metadata1.path === metadata2.path &&
            metadata1.scope === metadata2.scope &&
            metadata1.transformRaw === metadata2.transformRaw &&
            metadata1.dictionaryRowOwnership?.id === metadata2.dictionaryRowOwnership?.id &&
            metadata1.dictionaryRowOwnership?.profileId === metadata2.dictionaryRowOwnership?.profileId &&
            metadata1.profileOwnership?.profileId === metadata2.profileOwnership?.profileId &&
            metadata1.profileOwnership?.viewGeneration === metadata2.profileOwnership?.viewGeneration
        );
    }

    /**
     * @param {import('dom-data-binder').GetValuesDetails<import('generic-setting-controller').ElementMetadata>[]} targets
     * @returns {Promise<import('dom-data-binder').TaskResult[]>}
     */
    async _getValues(targets) {
        const defaultScope = this._defaultScope;
        /** @type {import('settings-modifications').ScopedRead[]} */
        const settingsTargets = [];
        const responseIndexes = [];
        /** @type {(import('dom-data-binder').TaskResult | null)[]} */
        const localValues = [];
        for (let i = 0; i < targets.length; ++i) {
            const {metadata: {path, scope, dictionaryRowOwnership, profileOwnership}} = targets[i];
            const dictionaryMatch = /^dictionaries\[(\d+)\]\.([A-Za-z]+)$/u.exec(path);
            if (dictionaryMatch !== null && dictionaryRowOwnership === void 0) {
                responseIndexes.push(-1);
                localValues.push({error: new ExtensionError('Missing dictionary row ownership snapshot')});
                continue;
            }
            if (dictionaryRowOwnership !== void 0) {
                if (
                    dictionaryMatch === null ||
                    Number.parseInt(dictionaryMatch[1], 10) !== dictionaryRowOwnership.index ||
                    !Object.hasOwn(dictionaryRowOwnership.expectedEntry, dictionaryMatch[2])
                ) {
                    responseIndexes.push(-1);
                    localValues.push({error: new ExtensionError('Invalid dictionary row ownership snapshot')});
                    continue;
                }
                if (this._settingsController.getOptionsContext().profileId !== dictionaryRowOwnership.profileId) {
                    responseIndexes.push(-1);
                    localValues.push({error: new ExtensionError('Profile changed; reload the dictionary settings row')});
                    continue;
                }
                responseIndexes.push(-1);
                localValues.push({result: dictionaryRowOwnership.expectedEntry[dictionaryMatch[2]]});
                continue;
            }
            /** @type {import('settings-modifications').ScopedRead} */
            const target = {
                path,
                scope: typeof scope === 'string' ? scope : defaultScope,
                optionsContext: profileOwnership?.optionsContext ?? null,
                ...(scope === 'profile' ? {profileId: profileOwnership?.profileId ?? ''} : {}),
            };
            settingsTargets.push(target);
            responseIndexes.push(settingsTargets.length - 1);
            localValues.push(null);
        }
        const values = await this._settingsController.getSettings(settingsTargets);
        for (let i = 0; i < targets.length; ++i) {
            const ownership = targets[i].metadata.profileOwnership;
            const responseIndex = responseIndexes[i];
            if (!this._isProfileOwnershipCurrent(ownership) && responseIndex >= 0) {
                localValues[i] = {error: new ExtensionError('Profile changed; discard stale setting read')};
                responseIndexes[i] = -1;
            }
        }
        for (const {metadata: {dictionaryRowOwnership}} of targets) {
            if (dictionaryRowOwnership !== void 0 && this._settingsController.getOptionsContext().profileId !== dictionaryRowOwnership.profileId) {
                return targets.map(() => ({error: new ExtensionError('Profile changed; reload the dictionary settings row')}));
            }
        }
        const results = /** @type {import('settings-controller').ModifyResult[]} */ (responseIndexes.map((index, i) => (index < 0 ? localValues[i] : values[index])));
        return this._transformResults(results, targets);
    }

    /**
     * @param {import('dom-data-binder').SetValuesDetails<import('generic-setting-controller').ElementMetadata>[]} targets
     * @returns {Promise<import('dom-data-binder').TaskResult[]>}
     */
    async _setValues(targets) {
        const defaultScope = this._defaultScope;
        /** @type {import('settings-modifications').ScopedModification[]} */
        const settingsTargets = [];
        for (const {metadata: {path, scope, transforms, profileOwnership}, value, element} of targets) {
            const transformedValue = this._applyTransforms(value, transforms, 'pre', element, this._isProfileOwnershipCurrent(profileOwnership));
            /** @type {import('settings-modifications').ScopedModification} */
            let target;
            const dictionaryMatch = /^dictionaries\[(\d+)\]\.([A-Za-z]+)$/u.exec(path);
            const targetDetails = targets[settingsTargets.length];
            const ownership = targetDetails?.metadata.dictionaryRowOwnership;
            if (dictionaryMatch !== null && ownership !== void 0 && Number.parseInt(dictionaryMatch[1], 10) === ownership.index) {
                target = {
                    action: 'setDictionaryField',
                    scope: typeof scope === 'string' ? scope : defaultScope,
                    optionsContext: null,
                    profileId: ownership.profileId,
                    index: ownership.index,
                    expectedEntry: structuredClone(ownership.expectedEntry),
                    field: /** @type {import('settings-modifications').ModificationSetDictionaryField['field']} */ (dictionaryMatch[2]),
                    value: transformedValue,
                };
            } else if (dictionaryMatch !== null) {
                // An indexed dictionary field without a captured row owner is
                // unsafe to apply. Fail closed instead of falling back to `set`.
                target = {
                    action: 'setDictionaryField',
                    scope: typeof scope === 'string' ? scope : defaultScope,
                    optionsContext: null,
                    profileId: '',
                    index: Number.parseInt(dictionaryMatch[1], 10),
                    expectedEntry: {},
                    field: /** @type {import('settings-modifications').ModificationSetDictionaryField['field']} */ (dictionaryMatch[2]),
                    value: transformedValue,
                };
            } else {
                target = {
                    path,
                    scope: typeof scope === 'string' ? scope : defaultScope,
                    action: 'set',
                    value: transformedValue,
                    optionsContext: profileOwnership?.optionsContext ?? null,
                    ...(scope === 'profile' ? {profileId: profileOwnership?.profileId ?? ''} : {}),
                };
            }
            settingsTargets.push(target);
        }
        const results = await this._settingsController.modifySettings(settingsTargets);
        let refreshNeeded = false;
        for (let i = 0; i < results.length; ++i) {
            const result = results[i];
            if (result.error) {
                if (
                    targets[i].metadata.dictionaryRowOwnership !== void 0 ||
                    /^dictionaries\[\d+\]\.[A-Za-z]+$/u.test(targets[i].metadata.path)
                ) { refreshNeeded = true; }
                continue;
            }
            const ownership = targets[i].metadata.dictionaryRowOwnership;
            if (ownership === void 0) { continue; }
            const value = result.result;
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                const rowResult = /** @type {{dictionaryEntry?: unknown, value?: unknown, stale?: unknown}} */ (value);
                if (rowResult.stale === true) {
                    refreshNeeded = true;
                } else if (rowResult.dictionaryEntry !== null && typeof rowResult.dictionaryEntry === 'object' && !Array.isArray(rowResult.dictionaryEntry)) {
                    // SettingsController has published the final committed row snapshot.
                    results[i] = {...result, result: rowResult.value};
                }
            }
        }
        if (refreshNeeded) {
            void this._settingsController.refresh().catch((error) => {
                log.error(error);
            });
        }
        return results.map((result, i) => {
            const ownership = targets[i].metadata.profileOwnership;
            if (!this._isProfileOwnershipCurrent(ownership)) {
                return {error: new ExtensionError('Profile changed; discard stale setting write response')};
            }
            return this._transformResults([result], [targets[i]])[0];
        });
    }

    /**
     * @param {import('generic-setting-controller').ElementMetadata['profileOwnership']} ownership
     * @returns {boolean}
     */
    _isProfileOwnershipCurrent(ownership) {
        return typeof ownership === 'undefined' || (
            ownership.viewGeneration === this._viewGeneration &&
            ownership.profileId === this._settingsController.getOptionsContext().profileId
        );
    }

    /**
     * @param {import('settings-controller').ModifyResult[]} values
     * @param {import('dom-data-binder').GetValuesDetails<import('generic-setting-controller').ElementMetadata>[]|import('dom-data-binder').SetValuesDetails<import('generic-setting-controller').ElementMetadata>[]} targets
     * @returns {import('dom-data-binder').TaskResult[]}
     */
    _transformResults(values, targets) {
        return values.map((value, i) => {
            const error = value.error;
            if (error) { return {error: ExtensionError.deserialize(error)}; }
            const {metadata: {transforms}, element} = targets[i];
            const result = this._applyTransforms(value.result, transforms, 'post', element);
            return {result};
        });
    }

    /**
     * @param {unknown} value
     * @param {import('generic-setting-controller').TransformData[]} transforms
     * @param {import('generic-setting-controller').TransformStep} step
     * @param {Element} element
     * @param {boolean} [allowDomMutation]
     * @returns {unknown}
     */
    _applyTransforms(value, transforms, step, element, allowDomMutation = true) {
        for (const transform of transforms) {
            if (!allowDomMutation && (transform.type === 'setAttribute' || transform.type === 'setVisibility')) { continue; }
            const transformStep = transform.step;
            if (typeof transformStep !== 'undefined' && transformStep !== step) { continue; }

            const transformFunction = this._transforms.get(transform.type);
            if (typeof transformFunction === 'undefined') { continue; }

            value = transformFunction(value, transform, element);
        }
        return value;
    }

    /**
     * @param {?Node} node
     * @param {number} ancestorDistance
     * @returns {?Node}
     */
    _getAncestor(node, ancestorDistance) {
        if (ancestorDistance < 0) {
            return document.documentElement;
        }
        for (let i = 0; i < ancestorDistance && node !== null; ++i) {
            node = node.parentNode;
        }
        return node;
    }

    /**
     * @param {?Node} node
     * @param {number|undefined} ancestorDistance
     * @param {string|undefined} selector
     * @returns {?Node}
     */
    _getRelativeElement(node, ancestorDistance, selector) {
        const selectorRoot = (
            typeof ancestorDistance === 'number' ?
            this._getAncestor(node, ancestorDistance) :
            document
        );
        if (selectorRoot === null) { return null; }

        return (
            typeof selector === 'string' && (selectorRoot instanceof Element || selectorRoot instanceof Document) ?
            selectorRoot.querySelector(selector) :
            (selectorRoot === document ? document.documentElement : selectorRoot)
        );
    }

    /**
     * @param {import('generic-setting-controller').OperationData} operationData
     * @param {unknown} lhs
     * @returns {unknown}
     */
    _evaluateSimpleOperation(operationData, lhs) {
        const {op: operation, value: rhs} = operationData;
        switch (operation) {
            case '!': return !lhs;
            case '!!': return !!lhs;
            case '===': return lhs === rhs;
            case '!==': return lhs !== rhs;
            case '>=': return /** @type {number} */ (lhs) >= /** @type {number} */ (rhs);
            case '<=': return /** @type {number} */ (lhs) <= /** @type {number} */ (rhs);
            case '>': return /** @type {number} */ (lhs) > /** @type {number} */ (rhs);
            case '<': return /** @type {number} */ (lhs) < /** @type {number} */ (rhs);
            case '&&':
                for (const operationData2 of /** @type {import('generic-setting-controller').OperationData[]} */ (rhs)) {
                    const result = this._evaluateSimpleOperation(operationData2, lhs);
                    if (!result) { return result; }
                }
                return true;
            case '||':
                for (const operationData2 of /** @type {import('generic-setting-controller').OperationData[]} */ (rhs)) {
                    const result = this._evaluateSimpleOperation(operationData2, lhs);
                    if (result) { return result; }
                }
                return false;
            default:
                return false;
        }
    }

    /**
     * @param {string|undefined} value
     * @returns {?import('settings-modifications').OptionsScopeType}
     */
    _normalizeScope(value) {
        switch (value) {
            case 'profile':
            case 'global':
                return value;
            default:
                return null;
        }
    }

    /**
     * @param {string|undefined} transformRaw
     * @returns {import('generic-setting-controller').TransformData[]}
     */
    _getTransformDataArray(transformRaw) {
        if (typeof transformRaw === 'string') {
            const transforms = parseJson(transformRaw);
            return Array.isArray(transforms) ? transforms : [transforms];
        }
        return [];
    }

    // Transforms

    /**
     * @param {unknown} value
     * @param {import('generic-setting-controller').SetAttributeTransformData} data
     * @param {Element} element
     * @returns {unknown}
     */
    _setAttribute(value, data, element) {
        const {ancestorDistance, selector, attribute} = data;
        const relativeElement = this._getRelativeElement(element, ancestorDistance, selector);
        if (relativeElement !== null && relativeElement instanceof Element) {
            relativeElement.setAttribute(attribute, `${value}`);
        }
        return value;
    }

    /**
     * @param {unknown} value
     * @param {import('generic-setting-controller').SetVisibilityTransformData} data
     * @param {Element} element
     * @returns {unknown}
     */
    _setVisibility(value, data, element) {
        const {ancestorDistance, selector, condition} = data;
        const relativeElement = this._getRelativeElement(element, ancestorDistance, selector);
        if (relativeElement !== null && relativeElement instanceof HTMLElement) {
            relativeElement.hidden = !this._evaluateSimpleOperation(condition, value);
        }
        return value;
    }

    /**
     * @param {unknown} value
     * @returns {string[]}
     */
    _splitTags(value) {
        return `${value}`.split(/[,; ]+/).filter((v) => !!v);
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    _joinTags(value) {
        return Array.isArray(value) ? value.join(' ') : '';
    }

    /**
     * @param {unknown} value
     * @param {import('generic-setting-controller').ToNumberConstraintsTransformData} data
     * @returns {number}
     */
    _toNumber(value, data) {
        /** @type {import('document-util').ToNumberConstraints} */
        const constraints = typeof data.constraints === 'object' && data.constraints !== null ? data.constraints : {};
        return typeof value === 'string' ? convertElementValueToNumber(value, constraints) : 0;
    }

    /**
     * @param {string} value
     * @returns {boolean}
     */
    _toBoolean(value) {
        return (value === 'true');
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    _toString(value) {
        return `${value}`;
    }

    /**
     * @param {unknown} value
     * @param {import('generic-setting-controller').ConditionalConvertTransformData} data
     * @returns {unknown}
     */
    _conditionalConvert(value, data) {
        const {cases} = data;
        if (Array.isArray(cases)) {
            for (const caseData of cases) {
                if (caseData.default === true) {
                    value = caseData.result;
                } else if (this._evaluateSimpleOperation(caseData, value)) {
                    value = caseData.result;
                    break;
                }
            }
        }
        return value;
    }
}
