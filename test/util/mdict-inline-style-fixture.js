/*
 * Copyright (C) 2026  Yomitan Authors
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

import {makeMdictFixture} from './mdict-binary-fixture.js';

export const INLINE_STYLE_SCOPE_TITLE = 'MDict inline style scope fixture';

/**
 * One pair of homographs, rendered together, exposes lost root selectors,
 * specificity changes, pseudo-element regressions and cross-entry styling.
 * @returns {ReturnType<typeof makeMdictFixture>}
 */
export function makeInlineStyleScopeFixture() {
    return makeMdictFixture([
        {
            key: '猫',
            value: [
                '<style>',
                ':is(:root) > .functional { color: rgb(11, 22, 33); }',
                ':where(html, body) > .where-root { color: rgb(22, 33, 44); }',
                ':root .cascade { color: rgb(33, 44, 55); }',
                '.cascade { color: rgb(199, 188, 177); }',
                '.shared { border-top: 3px solid rgb(44, 55, 66); }',
                '.shared::before { content: "scoped"; color: rgb(55, 66, 77); }',
                '.shared:after { content: "legacy"; }',
                ':root + * { background-color: rgb(201, 202, 203); }',
                '@media screen { .nested { font-weight: 700; } }',
                '</style>',
                '<div class="functional">functional root</div>',
                '<div class="where-root">where root</div>',
                '<div class="cascade">cascade</div>',
                '<div class="shared">scoped entry</div>',
                '<div class="nested">nested rule</div>',
            ].join(''),
        },
        {key: '猫', value: '<div class="shared outside">unscoped entry</div>'},
    ], {title: INLINE_STYLE_SCOPE_TITLE, keysPerBlock: 1, recordBlockSize: 7});
}
