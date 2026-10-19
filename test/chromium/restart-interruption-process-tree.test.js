/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, it} from 'vitest';
import {parseProcessRows, selectOwnedProcessTree} from './restart-interruption-process-tree.js';

describe('restart interruption process ownership', () => {
    it('captures descendants that do not repeat the profile marker and excludes unrelated processes', () => {
        const rows = [
            {pid: 100, ppid: 1, startedAt: 'Mon Oct 19 10:00:00 2026', command: '/opt/chromium --user-data-dir=/evidence/profile'},
            {pid: 101, ppid: 100, startedAt: 'Mon Oct 19 10:00:01 2026', command: '/opt/chromium --type=renderer'},
            {pid: 102, ppid: 101, startedAt: 'Mon Oct 19 10:00:02 2026', command: '/opt/helper --type=utility'},
            {pid: 200, ppid: 1, startedAt: 'Mon Oct 19 10:00:03 2026', command: '/opt/other --user-data-dir=/other/profile'},
        ];

        expect(selectOwnedProcessTree(rows, '/evidence/profile', '/opt/chromium').map(({pid}) => pid)).toEqual([100, 101, 102]);
    });

    it('rejects ambiguous profile roots and an unexpected executable', () => {
        const root = {pid: 100, ppid: 1, startedAt: 'Mon Oct 19 10:00:00 2026', command: '/opt/chromium --user-data-dir=/evidence/profile'};
        expect(() => selectOwnedProcessTree([root, {...root, pid: 101}], '/evidence/profile', '/opt/chromium')).toThrow(/one Chromium root/u);
        expect(() => selectOwnedProcessTree([root], '/evidence/profile', '/opt/trusted-chromium')).toThrow(/one Chromium root/u);
        expect(() => selectOwnedProcessTree([
            {...root, command: '/opt/chromium-evil --user-data-dir=/evidence/profile'},
        ], '/evidence/profile', '/opt/chromium')).toThrow(/one Chromium root/u);
        expect(() => selectOwnedProcessTree([
            {...root, command: '/opt/chromium --user-data-dir=/evidence/profile-extra'},
        ], '/evidence/profile', '/opt/chromium')).toThrow(/one Chromium root/u);
    });

    it('parses start identity and complete command from ps rows', () => {
        const rows = parseProcessRows(' 100 1 Mon Oct 19 10:00:00 2026 /opt/chromium --user-data-dir=/evidence/profile');
        expect(rows).toEqual([{
            pid: 100,
            ppid: 1,
            startedAt: 'Mon Oct 19 10:00:00 2026',
            command: '/opt/chromium --user-data-dir=/evidence/profile',
        }]);
    });

    it('accepts the macOS code-sign clone executable suffix only when explicitly enabled', () => {
        const clone = {pid: 100, ppid: 1, startedAt: 'Mon Oct 19 10:00:00 2026', command: '/opt/chromium (ABC123) --user-data-dir=/evidence/profile'};
        expect(() => selectOwnedProcessTree([clone], '/evidence/profile', '/opt/chromium')).toThrow(/one Chromium root/u);
        expect(selectOwnedProcessTree([clone], '/evidence/profile', '/opt/chromium', true).map(({pid}) => pid)).toEqual([100]);
    });

    it('accepts exact macOS executable and profile paths containing spaces', () => {
        const executable = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
        const profile = '/tmp/restart campaign/profile';
        const process = {
            pid: 100,
            ppid: 1,
            startedAt: 'Mon Oct 19 10:00:00 2026',
            command: `${executable} --user-data-dir=${profile} --no-first-run`,
        };
        expect(selectOwnedProcessTree([process], profile, executable).map(({pid}) => pid)).toEqual([100]);
        expect(() => selectOwnedProcessTree([
            {...process, command: `${executable}-evil --user-data-dir=${profile} --no-first-run`},
        ], profile, executable)).toThrow(/one Chromium root/u);
        expect(() => selectOwnedProcessTree([
            {...process, command: `${executable} --user-data-dir=${profile}-other --no-first-run`},
        ], profile, executable)).toThrow(/one Chromium root/u);
    });
});
