/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {test} from 'vitest'
import * as api from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {registerCompactionAliasCases} from './util/term-record-compaction-alias-cases.js'

registerCompactionAliasCases(test, api)
