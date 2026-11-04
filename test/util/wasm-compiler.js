/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {execFileSync} from 'node:child_process'
import {existsSync, readdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'

/**
 * @param {string} outputDirectoryPath
 * @returns {{command: string, args: string[]}}
 */
export function findCompiler(outputDirectoryPath) {
    const candidates = [
        process.env.MANABITAN_CLANG,
        process.env.CLANG,
        'clang',
        'clang-18',
        'clang-17',
        'zig',
        '/opt/homebrew/opt/llvm/bin/clang',
        '/usr/bin/clang',
        ...(process.platform === 'win32' && process.env.LOCALAPPDATA ?
            (() => {
                const packagesDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
                if (!existsSync(packagesDir)) { return [] }
                return readdirSync(packagesDir, {withFileTypes: true})
                    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith('zig.zig'))
                    .flatMap((entry) => readdirSync(path.join(packagesDir, entry.name), {withFileTypes: true})
                        .filter((version) => version.isDirectory())
                        .map((version) => path.join(packagesDir, entry.name, version.name, 'zig.exe')))
            })() :
[]),
    ].filter((value) => typeof value === 'string' && value.length > 0).map((value) => /** @type {string} */ (value))
    for (const command of candidates) {
        const args = /(^|[\\/])zig(?:\.exe)?$/i.test(command) ? ['cc'] : []
        try {
            execFileSync(command, [...args, '--version'], {stdio: 'ignore'})
            const probeSource = path.join(outputDirectoryPath, 'wasm-compiler-probe.c')
            const probeOutput = path.join(outputDirectoryPath, 'wasm-compiler-probe.wasm')
            writeFileSync(probeSource, 'void probe(void) {}\n', 'utf8')
            execFileSync(command, [...args, '--target=wasm32-freestanding', '-matomics', '-mbulk-memory', '-nostdlib', '-Wl,--no-entry', '-Wl,--shared-memory', '-Wl,--max-memory=4294967296', '-Wl,--export=probe', '-Wl,--strip-all', '-o', probeOutput, probeSource], {stdio: 'ignore'})
            return {command, args}
        } catch { /* Try the next repository-supported compiler. */ }
    }
    throw new Error('No supported wasm compiler found; set MANABITAN_CLANG or CLANG')
}
