#!/usr/bin/env python3
"""Compile test-only exports from two exact C sources and compare composite parsing.

This is correctness instrumentation, never an import timing benchmark. Unsupported
source signatures fail explicitly rather than guessing an ABI or reporting a pass.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess

NODE = r'''
import fs from 'node:fs'
import crypto from 'node:crypto'

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2)
const report = {status: 'running', cases: 0, validCases: 0, differentialCases: 0, mismatches: [], seed: 0x6d616e61}
const digest = crypto.createHash('sha256')
let seed = report.seed
function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
}
const encoder = new TextEncoder()
const modules = []
for (const path of [baselinePath, candidatePath]) {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(path), {})
    const api = instance.exports
    const pointer = api.proof_input_pointer()
    const output = api.proof_output_pointer()
    modules.push({api, bytes: new Uint8Array(api.memory.buffer, pointer, 1048640), words: new Uint32Array(api.memory.buffer, output, 3)})
}
function invoke(module, bytes, start, poison, initialFlags) {
    module.bytes.set(bytes)
    module.bytes.fill(poison, bytes.length, bytes.length + 64)
    const accepted = module.api.proof_parse(bytes.length, start, initialFlags)
    if (module.words[2] !== 0xfacedead) { throw new Error('Output guard overwritten') }
    return {accepted, end: module.words[0], flags: module.words[1]}
}
function check(payload, start = 0, mustAccept = false, initialFlags = 0) {
    if (payload.length > 1048576) { throw new Error('Proof input exceeds the test capacity') }
    const poison = report.cases % 2 ? 0x7d : 0x22
    const a = invoke(modules[0], payload, start, poison, initialFlags)
    const b = invoke(modules[1], payload, start, poison, initialFlags)
    const same = a.accepted === b.accepted && (a.accepted === 0 || (a.end === b.end && a.flags === b.flags))
    if (!same || (mustAccept && (a.accepted !== 1 || a.end !== payload.length))) {
        const failure = {case: report.cases, baseline: a, candidate: b, mustAccept, start, initialFlags,
            bytesBase64: Buffer.from(payload).toString('base64')}
        report.mismatches.push(failure)
        throw new Error('Composite parsing mismatch or valid-input rejection: ' + JSON.stringify(failure))
    }
    const summary = Buffer.alloc(16)
    summary.writeUInt32LE(report.cases >>> 0, 0)
    summary.writeInt32LE(a.accepted, 4)
    summary.writeUInt32LE(a.accepted ? a.end : 0, 8)
    summary.writeUInt32LE(a.accepted ? a.flags : 0, 12)
    digest.update(summary)
    report.cases++
    if (mustAccept) { report.validCases++ } else { report.differentialCases++ }
}
const strings = ['', 'a', '漢字とひらがな', '😀𝄞', 'quote"slash\\', '\n\t\r\u0000', 'image', 'path', 'structured-content', 'text', 'a'.repeat(31), '漢'.repeat(17)]
function value(depth) {
    const kind = random() % (depth > 0 ? 8 : 5)
    if (kind === 0) { return null }
    if (kind === 1) { return Boolean(random() & 1) }
    if (kind === 2) { return (random() % 1000000 - 500000) / 8 }
    if (kind < 5) { return strings[random() % strings.length] }
    const count = random() % 5
    if (kind === 5) { return Array.from({length: count}, () => value(depth - 1)) }
    const result = {}
    for (let i = 0; i < count; i++) { result[strings[random() % strings.length] + i] = value(depth - 1) }
    return result
}
try {
    const explicit = [
        '[]', '{}', '[[],{},[],{}]', '{"a":[],"b":{},"c":[{"d":[]},{}]}',
        '[null,true,false,-0,0.5,1e2,-2E-3]', '{"a":1,"a":2}',
        '[{"type":"image","path":"a.png"},{"type":"structured-content","content":{"tag":"span","content":"字"}}]',
        '{" ": [ "\\u0000", "\\uD83D\\uDE00", "a\\\\b", "a\\\"b" ] }',
    ]
    for (const text of explicit) {
        const payload = encoder.encode(text)
        for (let alignment = 0; alignment < 64; alignment++) {
            const bytes = new Uint8Array(alignment + payload.length)
            bytes.fill(0x20, 0, alignment)
            bytes.set(payload, alignment)
            check(bytes, alignment, true)
            for (let end = alignment; end < bytes.length; end++) { check(bytes.subarray(0, end), alignment) }
        }
    }
    for (let i = 0; i < 12000; i++) {
        const object = i % 2 ? [value(5), value(3), strings[i % strings.length]] : {a: value(5), b: value(3)}
        const payload = encoder.encode(JSON.stringify(object))
        const prefix = random() % 64
        const bytes = new Uint8Array(prefix + payload.length)
        bytes.fill(0x20, 0, prefix)
        bytes.set(payload, prefix)
        check(bytes, prefix, true)
        for (let mutation = 0; mutation < 5; mutation++) {
            const changed = bytes.slice()
            const at = prefix + random() % payload.length
            const tokens = [0, 0x09, 0x20, 0x22, 0x2c, 0x3a, 0x5b, 0x5c, 0x5d, 0x7b, 0x7d, 0xff]
            changed[at] = tokens[random() % tokens.length]
            check(changed, prefix)
            const end = prefix + random() % (payload.length + 1)
            check(bytes.subarray(0, end), prefix)
        }
    }
    for (const depth of [1, 2, 3, 15, 16, 31, 32, 63, 64, 127, 128, 254, 255, 256, 257, 258]) {
        for (let pattern = 0; pattern < 64; pattern++) {
            let text = '0'
            for (let i = 0; i < depth; i++) {
                text = (pattern >>> (i % 6)) & 1 ? '{"x":' + text + ',"y":[]}' : '[' + text + ',{}]'
            }
            const bytes = encoder.encode(text)
            // Depth accounting belongs to the production parser; compare both
            // sources rather than assuming a different root-depth convention.
            check(bytes)
            for (const end of [0, 1, 2, Math.floor(bytes.length / 2), bytes.length - 1]) { check(bytes.subarray(0, end)) }
        }
    }
    for (const text of ['[', '{', '[1,]', '{"a":1,}', '{"a" 1}', '{1:2}', '[true false]', '[01]', '[1.]', '[+1]', '[NaN]', '[Infinity]', '{"a":[1}]}']) {
        check(encoder.encode(text))
    }
    report.status = 'passed'
    report.outputSha256 = digest.digest('hex')
} catch (error) {
    report.status = 'failed'
    report.error = String(error?.stack || error)
    process.exitCode = 1
} finally {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({status: report.status, cases: report.cases, validCases: report.validCases,
        differentialCases: report.differentialCases, mismatchCount: report.mismatches.length}))
}
'''


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def binding(source):
    pattern = r'\b(?:int|int32_t)\s+(\w*composite\w*)\s*\(([^)]*)\)\s*\{'
    choices = []
    for match in re.finditer(pattern, source):
        args = [re.sub(r'\s+', ' ', part.strip()).replace(' *', '*').replace('* ', '*')
                for part in match.group(2).split(',')]
        if len(args) not in (4, 5):
            continue
        expected = [r'const uint8_t\*\w+', r'uint32_t (?:len|length)', r'uint32_t (?:start|offset)', r'uint32_t\*\w+']
        if not all(re.fullmatch(rule, arg) for rule, arg in zip(expected, args)):
            continue
        if len(args) == 5 and not re.fullmatch(r'uint32_t\*\w+', args[4]):
            continue
        choices.append((match.group(1), len(args)))
    if len(choices) != 1:
        raise RuntimeError('Unsupported or ambiguous composite ABI; no guessed calls are permitted: ' + repr(choices))
    return choices[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', required=True, type=pathlib.Path)
    parser.add_argument('--candidate', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--node', default='node')
    parser.add_argument('--clang', default='clang')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sources = {'baseline': args.baseline.resolve(), 'candidate': args.candidate.resolve()}
    interfaces = {name: binding(path.read_text()) for name, path in sources.items()}
    if interfaces['baseline'] != interfaces['candidate']:
        raise RuntimeError('Baseline/candidate composite ABIs do not match')
    function, count = interfaces['baseline']
    manifest = {'scope': 'Direct composite-span correctness only; not timing, full row encoding, or UTF-8 conformance',
                'binding': function, 'arguments': count, 'sourceSha256': {k: sha(v) for k, v in sources.items()},
                'compiler': subprocess.check_output([args.clang, '--version'], text=True),
                'node': subprocess.check_output([args.node, '--version'], text=True).strip()}
    for name, source in sources.items():
        arguments = 'proof_input, length, start, &proof_output[0]'
        if count == 5:
            arguments += ', &proof_output[1]'
        wrapper = '#include ' + json.dumps(str(source)) + '\n' + f'''
static uint8_t proof_input[1048640u];
static uint32_t proof_output[3];
__attribute__((visibility("default")))
uint32_t proof_input_pointer(void) {{ return (uint32_t)(uintptr_t)proof_input; }}
__attribute__((visibility("default")))
uint32_t proof_output_pointer(void) {{ return (uint32_t)(uintptr_t)proof_output; }}
__attribute__((visibility("default")))
int32_t proof_parse(uint32_t length, uint32_t start, uint32_t flags) {{
    if (length > 1048576u || start > length) {{ return -99; }}
    proof_output[0] = 0xccccccccu;
    proof_output[1] = flags;
    proof_output[2] = 0xfacedeadu;
    return {function}({arguments});
}}
'''
        c_path = args.output / (name + '-proof.c')
        wasm_path = args.output / (name + '-proof.wasm')
        c_path.write_text(wrapper)
        command = [args.clang, '--target=wasm32-freestanding', '-O3', '-matomics', '-mbulk-memory', '-msimd128',
                   '-nostdlib', '-Wl,--no-entry', '-Wl,--shared-memory', '-Wl,--max-memory=4294967296',
                   '-Wl,--export-memory', '-Wl,--export=proof_input_pointer', '-Wl,--export=proof_output_pointer',
                   '-Wl,--export=proof_parse', '-Wl,--strip-all', '-o', str(wasm_path), str(c_path)]
        subprocess.run(command, check=True)
        manifest[name + 'WasmSha256'] = sha(wasm_path)
    driver = args.output / 'differential.mjs'
    driver.write_text(NODE)
    manifest['driverSha256'] = sha(driver)
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    subprocess.run([args.node, str(driver), str(args.output / 'baseline-proof.wasm'),
                    str(args.output / 'candidate-proof.wasm'), str(args.output / 'results.json')], check=True)


if __name__ == '__main__':
    main()
