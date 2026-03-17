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

import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {describe, expect, test} from 'vitest';
import {
    cleanupCaseTempDir,
    cleanupTempRoot,
    DEFAULT_FREEMDICT_DAV_URL,
    discoverDirectoryWorkItems,
    parseCliArgs,
    parseDavMultistatus,
} from './chromium/freemdict-import-soak-util.js';

describe('freemdict import soak util', () => {
    test('parseDavMultistatus parses DAV file and directory entries', () => {
        const requestUrl = `${DEFAULT_FREEMDICT_DAV_URL}JAPANESE/`;
        const xml = `<?xml version="1.0"?>
            <d:multistatus xmlns:d="DAV:">
                <d:response>
                    <d:href>/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/</d:href>
                    <d:propstat>
                        <d:prop>
                            <d:resourcetype><d:collection/></d:resourcetype>
                        </d:prop>
                    </d:propstat>
                </d:response>
                <d:response>
                    <d:href>/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/</d:href>
                    <d:propstat>
                        <d:prop>
                            <d:resourcetype><d:collection/></d:resourcetype>
                            <d:getlastmodified>Tue, 17 Mar 2026 08:22:11 GMT</d:getlastmodified>
                        </d:prop>
                    </d:propstat>
                </d:response>
                <d:response>
                    <d:href>/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Readme.md</d:href>
                    <d:propstat>
                        <d:prop>
                            <d:resourcetype/>
                            <d:getcontentlength>2362</d:getcontentlength>
                            <d:getcontenttype>text/markdown</d:getcontenttype>
                        </d:prop>
                    </d:propstat>
                </d:response>
            </d:multistatus>`;

        const entries = parseDavMultistatus(xml, requestUrl, DEFAULT_FREEMDICT_DAV_URL);

        expect(entries).toHaveLength(3);
        expect(entries[0]).toMatchObject({
            relativePath: 'JAPANESE',
            isDirectory: true,
            size: null,
        });
        expect(entries[1]).toMatchObject({
            relativePath: 'JAPANESE/Jpn-Eng',
            isDirectory: true,
            lastModified: 'Tue, 17 Mar 2026 08:22:11 GMT',
        });
        expect(entries[2]).toMatchObject({
            relativePath: 'JAPANESE/Readme.md',
            isDirectory: false,
            size: 2362,
            contentType: 'text/markdown',
        });
    });

    test('discoverDirectoryWorkItems groups supported imports and emits skips', () => {
        const directoryUrl = `${DEFAULT_FREEMDICT_DAV_URL}JAPANESE/Jpn-Eng/`;
        const entries = [
            {
                url: directoryUrl,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/',
                relativePath: 'JAPANESE/Jpn-Eng',
                isDirectory: true,
                size: null,
                contentType: null,
                lastModified: null,
            },
            {
                url: `${directoryUrl}Nested/`,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/Nested/',
                relativePath: 'JAPANESE/Jpn-Eng/Nested',
                isDirectory: true,
                size: null,
                contentType: null,
                lastModified: null,
            },
            {
                url: `${directoryUrl}supported-dict.zip`,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/supported-dict.zip',
                relativePath: 'JAPANESE/Jpn-Eng/supported-dict.zip',
                isDirectory: false,
                size: 100,
                contentType: 'application/zip',
                lastModified: null,
            },
            {
                url: `${directoryUrl}pack.mdx`,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/pack.mdx',
                relativePath: 'JAPANESE/Jpn-Eng/pack.mdx',
                isDirectory: false,
                size: 200,
                contentType: 'application/octet-stream',
                lastModified: null,
            },
            {
                url: `${directoryUrl}pack.mdd`,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/pack.mdd',
                relativePath: 'JAPANESE/Jpn-Eng/pack.mdd',
                isDirectory: false,
                size: 300,
                contentType: 'application/octet-stream',
                lastModified: null,
            },
            {
                url: `${directoryUrl}orphan.mdd`,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/orphan.mdd',
                relativePath: 'JAPANESE/Jpn-Eng/orphan.mdd',
                isDirectory: false,
                size: 400,
                contentType: 'application/octet-stream',
                lastModified: null,
            },
            {
                url: `${directoryUrl}unsupported.7z`,
                href: '/public.php/dav/files/pgKcDcbSDTCzXCs/JAPANESE/Jpn-Eng/unsupported.7z',
                relativePath: 'JAPANESE/Jpn-Eng/unsupported.7z',
                isDirectory: false,
                size: 500,
                contentType: 'application/x-7z-compressed',
                lastModified: null,
            },
        ];

        const workItems = discoverDirectoryWorkItems(DEFAULT_FREEMDICT_DAV_URL, directoryUrl, entries);
        const caseItems = workItems.filter((item) => item.type === 'case');
        const skipItems = workItems.filter((item) => item.type === 'skip');
        const directoryItems = workItems.filter((item) => item.type === 'directory');

        expect(caseItems).toHaveLength(2);
        expect(caseItems[0]).toMatchObject({
            caseType: 'mdx',
            relativePath: 'JAPANESE/Jpn-Eng/pack.mdx',
        });
        expect(caseItems[0].files.map(({relativePath}) => relativePath)).toStrictEqual([
            'JAPANESE/Jpn-Eng/pack.mdx',
            'JAPANESE/Jpn-Eng/pack.mdd',
        ]);
        expect(caseItems[1]).toMatchObject({
            caseType: 'zip',
            relativePath: 'JAPANESE/Jpn-Eng/supported-dict.zip',
        });

        expect(skipItems).toHaveLength(2);
        expect(skipItems.map(({reason}) => reason).sort()).toStrictEqual([
            'orphan-mdd-without-mdx',
            'unsupported-file-format',
        ]);
        expect(directoryItems).toHaveLength(1);
        expect(directoryItems[0]).toMatchObject({
            relativePath: 'JAPANESE/Jpn-Eng/Nested',
        });
    });

    test('parseCliArgs parses supported flags', () => {
        const parsed = parseCliArgs([
            '--resume',
            '--limit',
            '3',
            '--match=jitendex',
            '--state-file',
            'state.json',
            '--report-file=report.json',
            '--temp-dir',
            'tmp-dir',
            '--keep-failed',
        ], {
            stateFile: 'default-state.json',
            reportFile: 'default-report.json',
            tempDir: 'default-temp',
        });

        expect(parsed).toMatchObject({
            resume: true,
            limit: 3,
            match: 'jitendex',
            stateFile: 'state.json',
            reportFile: 'report.json',
            tempDir: 'tmp-dir',
            keepFailed: true,
        });
    });

    test('cleanup helpers remove temp artifacts unless preserved', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'freemdict-soak-'));
        const removableCaseDir = path.join(tempRoot, 'case-a');
        const preservedCaseDir = path.join(tempRoot, 'case-b');
        const nonEmptyDir = path.join(tempRoot, 'non-empty');
        const emptyDir = path.join(tempRoot, 'empty');
        await mkdir(removableCaseDir, {recursive: true});
        await mkdir(preservedCaseDir, {recursive: true});
        await mkdir(nonEmptyDir, {recursive: true});
        await mkdir(emptyDir, {recursive: true});
        await writeFile(path.join(removableCaseDir, 'file.txt'), 'remove me', 'utf8');
        await writeFile(path.join(preservedCaseDir, 'file.txt'), 'keep me', 'utf8');
        await writeFile(path.join(nonEmptyDir, 'file.txt'), 'still here', 'utf8');

        try {
            await cleanupCaseTempDir(removableCaseDir, {preserve: false});
            await cleanupCaseTempDir(preservedCaseDir, {preserve: true});
            await cleanupTempRoot(tempRoot, {removeAll: false});

            const rootEntries = await readdir(tempRoot);
            expect(rootEntries).not.toContain('case-a');
            expect(rootEntries).not.toContain('empty');
            expect(rootEntries).toContain('case-b');
            expect(rootEntries).toContain('non-empty');
        } finally {
            await rm(tempRoot, {recursive: true, force: true});
        }
    });
});
