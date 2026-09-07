#!/usr/bin/env node
/*
 * Copyright (C) 2026  Manabitan authors
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

// The legacy isolated A/B runner defaults to a single pair and enables verbose
// bulk-add diagnostics. Those defaults are useful for its original diagnostic
// role but are too noisy for performance decisions. Keep the existing runner
// reusable while making the performance entrypoint production-like by default.
process.env.MANABITAN_AB_PAIR_ITERATIONS ??= '5';
process.env.MANABITAN_AB_BULKADD_BYTES_METRICS ??= '0';

export {};

await import('../../test/chromium/import-flags-ab-benchmark.js');
