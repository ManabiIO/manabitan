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

import assert from 'assert';
import childProcess from 'child_process';
import fs from 'fs';
import JSZip from 'jszip';
import {fileURLToPath} from 'node:url';
import path from 'path';
import readline from 'readline';
import {parseArgs} from 'util';
import {buildLibs} from '../build-libs.js';
import {ManifestUtil} from '../manifest-util.js';
import {getAllFiles} from '../util.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generated libraries may live in a task-owned external cache. Archive their
 * files rather than omitting the directory link or storing a symbolic link.
 * Other links remain excluded by the ordinary source traversal.
 * @param {string} directory
 * @returns {boolean}
 */
function hasLinkedLibraries(directory) {
    const libraryDirectory = path.join(directory, 'lib');
    return fs.existsSync(libraryDirectory) && fs.lstatSync(libraryDirectory).isSymbolicLink();
}

/**
 * @param {string} directory
 * @param {string[]} excludeFiles
 * @returns {string[]}
 */
function getPackageFiles(directory, excludeFiles) {
    const files = getAllFiles(directory);
    if (hasLinkedLibraries(directory)) {
        const libraryDirectory = fs.realpathSync(path.join(directory, 'lib'));
        for (const fileName of getAllFiles(libraryDirectory)) {
            files.push(path.join('lib', fileName));
        }
    }
    removeItemsFromArray(files, excludeFiles);
    return files;
}

/**
 * Keep the previous output intact until the replacement has been built.
 * @param {string} outputFileName
 * @param {boolean} isDirectory
 * @param {(stagedPath: string) => void|Promise<void>} write
 * @returns {Promise<void>}
 */
async function writePackageOutput(outputFileName, isDirectory, write) {
    outputFileName = path.resolve(outputFileName);
    const previous = fs.lstatSync(outputFileName, {throwIfNoEntry: false});
    if (typeof previous !== 'undefined' && (previous.isSymbolicLink() ||
    (isDirectory ? !previous.isDirectory() : !previous.isFile()))) {
        throw new Error(`Unexpected build output type: ${outputFileName}`);
    }
    const stagingDirectory = fs.mkdtempSync(path.join(path.dirname(outputFileName), `.${path.basename(outputFileName)}-`));
    const stagedPath = path.join(stagingDirectory, 'new', path.basename(outputFileName));
    const previousPath = path.join(stagingDirectory, 'previous');
    let preserveStaging = false;
    try {
        fs.mkdirSync(path.dirname(stagedPath));
        await write(stagedPath);
        if (!isDirectory) {
            fs.renameSync(stagedPath, outputFileName);
            return;
        }
        if (typeof previous !== 'undefined') { fs.renameSync(outputFileName, previousPath); }
        try {
            fs.renameSync(stagedPath, outputFileName);
        } catch (error) {
            if (typeof previous !== 'undefined') {
                try {
                    fs.renameSync(previousPath, outputFileName);
                } catch (rollbackError) {
                    preserveStaging = true;
                    throw new AggregateError([error, rollbackError], `Build output rollback failed; previous output retained at ${previousPath}`);
                }
            }
            throw error;
        }
    } finally {
        if (!preserveStaging) { fs.rmSync(stagingDirectory, {recursive: true, force: true}); }
    }
}

/**
 * @param {string} directory
 * @param {string[]} excludeFiles
 * @param {string} outputDirectory
 * @param {boolean} dryRun
 * @returns {Promise<void>}
 */
export async function createDirectory(directory, excludeFiles, outputDirectory, dryRun) {
    if (dryRun) { return; }
    const files = getPackageFiles(directory, excludeFiles);
    await writePackageOutput(outputDirectory, true, (stagedPath) => {
        fs.mkdirSync(stagedPath);
        for (const name of files) {
            const destination = path.join(stagedPath, name);
            fs.mkdirSync(path.dirname(destination), {recursive: true});
            fs.copyFileSync(path.join(directory, name), destination);
        }
    });
}

/**
 * @param {string} directory
 * @param {string[]} excludeFiles
 * @param {string} outputFileName
 * @param {string[]} sevenZipExes
 * @param {?import('jszip').OnUpdateCallback} onUpdate
 * @param {boolean} dryRun
 */
export async function createZip(directory, excludeFiles, outputFileName, sevenZipExes, onUpdate, dryRun) {
    if (dryRun) {
        await createJSZip(directory, excludeFiles, outputFileName, onUpdate, true);
        return;
    }
    await writePackageOutput(outputFileName, false, async (stagedPath) => {
        if (!hasLinkedLibraries(directory)) {
            for (const exe of sevenZipExes) {
                try {
                    const excludeArguments = excludeFiles.map((excludeFilePath) => `-x!${excludeFilePath}`);
                    childProcess.execFileSync(
                        exe,
                        [
                            'a',
                            stagedPath,
                            '.',
                            ...excludeArguments,
                        ],
                        {
                            cwd: directory,
                        },
                    );
                    return;
                } catch (e) {
                    // NOP
                }
            }
        }
        await createJSZip(directory, excludeFiles, stagedPath, onUpdate, false);
    });
}

/**
 * @param {string} directory
 * @param {string[]} excludeFiles
 * @param {string} outputFileName
 * @param {?import('jszip').OnUpdateCallback} onUpdate
 * @param {boolean} dryRun
 */
async function createJSZip(directory, excludeFiles, outputFileName, onUpdate, dryRun) {
    const files = getPackageFiles(directory, excludeFiles);
    const zip = new JSZip();
    for (const fileName of files) {
        zip.file(
            fileName.replace(/\\/g, '/'),
            fs.readFileSync(path.join(directory, fileName), {encoding: null, flag: 'r'}),
            {},
        );
    }

    if (typeof onUpdate !== 'function') {
        onUpdate = () => {}; // NOP
    }

    const data = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: {level: 9},
    }, onUpdate);
    process.stdout.write('\n');

    if (!dryRun) {
        fs.writeFileSync(outputFileName, data, {encoding: null, flag: 'w'});
    }
}

/**
 * @param {string[]} array
 * @param {string[]} removeItems
 */
function removeItemsFromArray(array, removeItems) {
    for (const item of removeItems) {
        const index = getIndexOfFilePath(array, item);
        if (index >= 0) {
            array.splice(index, 1);
        }
    }
}

/**
 * @param {string[]} array
 * @param {string} item
 * @returns {number}
 */
function getIndexOfFilePath(array, item) {
    const pattern = /\\/g;
    const separator = '/';
    item = item.replace(pattern, separator);
    for (let i = 0, ii = array.length; i < ii; ++i) {
        if (array[i].replace(pattern, separator) === item) {
            return i;
        }
    }
    return -1;
}

/**
 * @param {import('dev/manifest').ManifestVariant} variant
 * @returns {boolean}
 */
function isBuildableVariant(variant) {
    return variant.buildable !== false && typeof variant.fileName === 'string' && variant.fileName.length > 0;
}

/**
 * Validate the complete request before any target can change an existing output.
 * @param {ManifestUtil} manifestUtil
 * @param {string[]} names
 * @returns {import('dev/manifest').ManifestVariant[]}
 * @throws {Error}
 */
function getBuildVariants(manifestUtil, names) {
    if (names.length === 0) { throw new Error('No build targets selected'); }
    return names.map((name) => {
        const variant = manifestUtil.getVariant(name);
        if (typeof variant === 'undefined') { throw new Error(`Unknown build target: ${name}`); }
        if (variant.buildable === false) { throw new Error(`Build target is not buildable: ${name}`); }
        if (!isBuildableVariant(variant)) { throw new Error(`Build target has no package output: ${name}`); }
        return variant;
    });
}

/**
 * @param {string} buildDir
 * @param {string} extDir
 * @param {ManifestUtil} manifestUtil
 * @param {string[]} variantNames
 * @param {string} manifestPath
 * @param {boolean} dryRun
 * @param {boolean} dryRunBuildZip
 * @param {string} yomitanVersion
 */
export async function build(buildDir, extDir, manifestUtil, variantNames, manifestPath, dryRun, dryRunBuildZip, yomitanVersion) {
    const variants = getBuildVariants(manifestUtil, variantNames);
    const sevenZipExes = ['7za', '7z'];

    // Create build directory
    if (!fs.existsSync(buildDir) && !dryRun) {
        fs.mkdirSync(buildDir, {recursive: true});
    }

    const dontLogOnUpdate = !process.stdout.isTTY;
    /** @type {import('jszip').OnUpdateCallback} */
    const onUpdate = (metadata) => {
        if (dontLogOnUpdate) { return; }

        let message = `Progress: ${metadata.percent.toFixed(2)}%`;
        if (metadata.currentFile) {
            message += ` (${metadata.currentFile})`;
        }

        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(message);
    };

    process.stdout.write(`Version: ${yomitanVersion}...\n`);

    for (const variant of variants) {
        const {name, fileName, fileCopies} = variant;
        const excludeFiles = manifestUtil.getVariantFileExclusions(name);

        process.stdout.write(`Building ${name}...\n`);

        const modifiedManifest = manifestUtil.getManifest(variant.name);

        ensureFilesExist(extDir, excludeFiles);

        if (typeof fileName === 'string') {
            const fileNameSafe = path.basename(fileName);
            const fullFileName = path.join(buildDir, fileNameSafe);
            if (!dryRun) {
                fs.writeFileSync(manifestPath, ManifestUtil.createManifestString(modifiedManifest).replace('$YOMITAN_VERSION', yomitanVersion));
            }

            if (fileName.endsWith('.zip')) {
                if (!dryRun || dryRunBuildZip) {
                    await createZip(extDir, excludeFiles, fullFileName, sevenZipExes, onUpdate, dryRun);
                }

                if (!dryRun && Array.isArray(fileCopies)) {
                    for (const fileName2 of fileCopies) {
                        const fileName2Safe = path.basename(fileName2);
                        fs.copyFileSync(fullFileName, path.join(buildDir, fileName2Safe));
                    }
                }
            } else {
                await createDirectory(extDir, excludeFiles, fullFileName, dryRun);
            }
        }

        process.stdout.write('\n');
    }
}

/**
 * @param {string} directory
 * @param {string[]} files
 */
function ensureFilesExist(directory, files) {
    for (const file of files) {
        assert.ok(fs.existsSync(path.join(directory, file)));
    }
}

/**
 * @param {string[]} argv
 * @param {ManifestUtil} manifestUtil
 * @returns {{variantNames: string[], manifestName: ?string, dryRun: boolean, dryRunBuildZip: boolean, yomitanVersion: string}}
 * @throws {Error} A selected variant cannot be built or restored.
 */
export function getBuildPlan(argv, manifestUtil) {
    /** @type {import('util').ParseArgsConfig['options']} */
    const parseArgsConfigOptions = {
        all: {
            type: 'boolean',
            default: false,
        },
        default: {
            type: 'boolean',
            default: false,
        },
        manifest: {
            type: 'string',
        },
        dryRun: {
            type: 'boolean',
            default: false,
        },
        dryRunBuildZip: {
            type: 'boolean',
            default: false,
        },
        version: {
            type: 'string',
            default: '0.0.0.0',
        },
        target: {
            type: 'string',
        },
    };

    const {values: args, positionals: targets} = parseArgs({args: argv, options: parseArgsConfigOptions, allowPositionals: true});

    const dryRun = /** @type {boolean} */ (args.dryRun);
    const dryRunBuildZip = /** @type {boolean} */ (args.dryRunBuildZip);
    const yomitanVersion = /** @type {string} */ (args.version);

    const manifestOnly = args.all !== true && typeof args.target !== 'string' && targets.length === 0 &&
    (args.default === true || typeof args.manifest === 'string');
    const variantNames = (
        typeof args.target === 'string' ?
        [args.target] :
        (args.all === true || (targets.length === 0 && !manifestOnly) ?
        manifestUtil.getVariants().filter(isBuildableVariant).map(({name}) => name) :
        targets)
    );
    const manifestName = /** @type {?string} */ ((!args.default && typeof args.manifest !== 'undefined') ? args.manifest : null);
    if (manifestName !== null && typeof manifestUtil.getVariant(manifestName) === 'undefined') {
        throw new Error(`Unknown manifest variant: ${manifestName}`);
    }
    if (!manifestOnly) { getBuildVariants(manifestUtil, variantNames); }
    return {variantNames, manifestName, dryRun, dryRunBuildZip, yomitanVersion};
}

/**
 * @param {string[]} [argv]
 */
export async function main(argv = process.argv.slice(2)) {
    const manifestUtil = new ManifestUtil();
    const {variantNames, manifestName, dryRun, dryRunBuildZip, yomitanVersion} = getBuildPlan(argv, manifestUtil);
    const rootDir = path.join(dirname, '..', '..');
    const extDir = path.join(rootDir, 'ext');
    const buildDir = path.join(rootDir, 'builds');
    const manifestPath = path.join(extDir, 'manifest.json');

    try {
        await buildLibs();
        if (variantNames.length > 0) {
            await build(buildDir, extDir, manifestUtil, variantNames, manifestPath, dryRun, dryRunBuildZip, yomitanVersion);
        }
    } finally {
        // Restore manifest
        const restoreManifest = manifestUtil.getManifest(manifestName);
        process.stdout.write('Restoring manifest...\n');
        if (!dryRun) {
            fs.writeFileSync(manifestPath, ManifestUtil.createManifestString(restoreManifest).replace('$YOMITAN_VERSION', yomitanVersion));
        }
    }
}

// Node 22.22 supports this entry-point flag; the Node type declarations predate it.
if (/** @type {ImportMeta & {main?: boolean}} */ (import.meta).main) { await main(); }
