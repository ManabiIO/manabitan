from pathlib import Path
p = Path('ext/js/dictionary/term-bank-wasm-parser.js')
s = p.read_text()
assert s.count('textDecoder.decode(') == 3
s = s.replace('textDecoder.decode(', 'decodeParserText(')
old = '/**\n * @param {Uint8Array} source\n * @param {number} start\n * @param {number} length\n * @returns {string}\n */\nfunction decodeJsonStringToken'
new = '''/**
 * TextDecoder does not accept SharedArrayBuffer-backed views in browsers.
 * Parser memory stays stable during these synchronous projections. Copy only
 * the requested token, never the entire shared heap or source bank.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeParserText(bytes) {
    return textDecoder.decode(bytes.buffer instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes));
}

''' + old
assert s.count(old) == 1
p.write_text(s.replace(old, new))
