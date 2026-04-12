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

import {describe, expect, test, vi} from 'vitest';
import {BackupController} from '../ext/js/pages/settings/backup-controller.js';

function createControllerForInternalTests() {
    return /** @type {BackupController} */ (Object.create(BackupController.prototype));
}

describe('BackupController settings export', () => {
    test('clears the export token when settings export data generation fails', async () => {
        const controller = createControllerForInternalTests();
        const getSettingsExportData = vi.fn().mockRejectedValue(new Error('export failed'));
        Reflect.set(controller, '_settingsExportRevoke', null);
        Reflect.set(controller, '_settingsExportToken', null);
        Reflect.set(controller, '_getSettingsExportData', getSettingsExportData);
        Reflect.set(controller, '_getSettingsExportDateString', vi.fn(() => '2026-04-10-010203'));
        Reflect.set(controller, '_saveBlob', vi.fn());

        await expect(controller._onSettingsExportClick()).rejects.toThrow('export failed');

        expect(getSettingsExportData).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_settingsExportToken')).toBeNull();
        expect(Reflect.get(controller, '_saveBlob')).not.toHaveBeenCalled();
    });
});
