/* SPDX-License-Identifier: GPL-3.0-or-later */

// The qualification branch uses the existing hosted workflow for a develop
// import-phase diagnostic. Manual dispatches and other branches retain timing.
if (process.env.GITHUB_REF_NAME === 'codex/qualify-jmdict-hosted-20261128' && process.env.GITHUB_EVENT_NAME === 'push') {
    await import('../hoshidicts-resource/run-develop-phase-hosted.mjs')
} else {
    await import('./run-balanced-timed-hosted.mjs')
}
