import {readFileSync} from 'node:fs'
import {test} from 'vitest'
import {parseJson} from '../ext/js/core/json.js'
import * as hash from '../ext/js/dictionary/term-entry-content-hash.js'
import {registerContentHashCompatibilityCases} from './util/content-hash-compatibility-cases.js'

const fixture = /** @type {{vectors: {length: number, salt: number, pair: number[]}[]}} */ (parseJson(readFileSync(new URL('./data/content-hash-native-vectors.json', import.meta.url), 'utf8')))
registerContentHashCompatibilityCases(test, hash, fixture)
