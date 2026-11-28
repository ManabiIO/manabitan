/* SPDX-License-Identifier: GPL-3.0-or-later */

// The qualification branch uses the existing hosted workflow for the isolated
// resource cohort. Manual dispatches and other branches retain the timed run.
if (process.env.GITHUB_REF_NAME === 'codex/qualify-jmdict-hosted-20261128' && process.env.GITHUB_EVENT_NAME === 'push') {
    await import('../hoshidicts-resource/run-resource-hosted.mjs')
} else {
    await import('./run-balanced-timed-hosted.mjs')
}
