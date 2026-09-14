![Manabitan icon](ext/images/icon128.png)

# Manabitan

[Download for Chrome, Firefox, Edge](https://github.com/ManabiIO/manabitan/releases)

[![CI](https://img.shields.io/github/actions/workflow/status/ManabiIO/manabitan/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/ManabiIO/manabitan/actions/workflows/ci.yml)
[![GitHub Downloads](https://img.shields.io/github/downloads/ManabiIO/manabitan/total?style=for-the-badge&label=Downloads)](https://github.com/ManabiIO/manabitan/releases)
[![Test Coverage](https://img.shields.io/badge/test%20coverage-100%25-brightgreen?style=for-the-badge)](https://github.com/ManabiIO/manabitan/blob/main/docs/development/npm-scripts.md#testcoverage)
[![Manabi Discord](https://dcbadge.limes.pink/api/server/gvxzS93C3w?style=for-the-badge)](https://discord.gg/gvxzS93C3w)

Manabitan is a fast Yomitan fork. It keeps Yomitan's workflow and feature set while replacing the dictionary storage and query engines underneath it.

This isn't a hostile fork. Yomitan's primary maintainers have provided guidance and support around developing and releasing Manabitan separately. A fork gives us somewhere practical to finish and prove a change this large without making Yomitan's existing users take on a major data migration before we're ready to be responsible for it.

**[Read why Manabitan exists, why it is a fork, and how work can flow back to Yomitan.](https://manabi.io/manabitan/about-manabitan/)**

## Why speed matters

Waiting for dictionaries to import is not language learning.

Yomitan is worth waiting for, but importing large dictionaries can take a long time, especially on older hardware and e-ink devices. Manabitan makes imports substantially faster and changes the storage architecture so existing dictionaries can stay usable while new data is being prepared.

That makes automatic dictionary updates practical for dictionaries with web-accessible update sources. It also makes normal lookups faster, which is noticeable on constrained devices and means less CPU, I/O, and battery use everywhere.

![manabitan_vs_yomitan_chart](https://github.com/user-attachments/assets/1351b902-c918-43a6-b4ac-c64c333fa68d)

## Differences from Yomitan

- MDX dictionary support
- Much faster dictionary imports and lookups
- Dictionary imports that do not have to block normal use of the extension
- Automatic and scheduled dictionary updates for supported sources
- Install or update recommended dictionaries in bulk
- Edit dictionary metadata after importing
- Built-in popup themes
- Frequency-based recall blur
- Automatic setup for several popular Anki note types
- Storage compression and deduplication work aimed at large dictionary collections and constrained devices

We benchmark dictionary importing, word lookups, and adding cards to Anki. Performance is a product feature here, not an implementation detail.

## Why a fork instead of an upstream rewrite?

The storage work is too large to land usefully one piece at a time. It replaces foundational database machinery and brings migration, compatibility, compression, caching, update, and query changes with it.

There have been attempts to contribute foundational pieces upstream. The practical problem is that a change this large has to be split into incremental pull requests, while many intermediate pieces create substantial review and maintenance work without delivering much immediate value to Yomitan users on their own. Manabitan would not exist if every step had to be accepted upstream before the next step could be built.

A fork lets us finish the architecture and take responsibility for users who deliberately choose it. It also avoids asking Yomitan's much larger installed base to migrate years of dictionaries and settings to new internal structures before those structures have been proven in the wild.

Maybe that changes later. Manabitan uses the same open-source licensing lineage as Yomitan, and anyone is welcome to take useful work from here and bring it back upstream. We also continue contributing changes to Yomitan when they make sense independently of Manabitan's larger architecture.

Yomitan itself continues the work started by Yomichan. Manabitan is another branch of that open-source lineage, not an attempt to replace or erase it.

For the longer version, see **[Why Manabitan exists](https://manabi.io/manabitan/about-manabitan/)**.

## Documentation

**[Manabitan Wiki](https://manabi.io/manabitan/)**

- [Getting started](https://manabi.io/manabitan/getting-started/)
- [Dictionaries](https://manabi.io/manabitan/dictionaries/)
- [Anki integration](https://manabi.io/manabitan/anki/)
- [Advanced features](https://manabi.io/manabitan/advanced/)
- [Why Manabitan exists](https://manabi.io/manabitan/about-manabitan/)

### Developer documentation

- [Making Manabitan dictionaries](./docs/making-yomitan-dictionaries.md)
- [Anki Handlebars templates](./docs/templates.md)
- [Language features](./docs/development/language-features.md)
- [Known browser bugs](./docs/browser-bugs.md)

## Installation

Install the browser package you need from the [GitHub releases](https://github.com/ManabiIO/manabitan/releases) page. See the [Getting Started guide](https://manabi.io/manabitan/getting-started/) for browser-specific instructions.

## Roadmap

### Priority

- [ ] E-reader performance
- [ ] Improve onboarding for easier default installation
- [ ] Change Manabitan import/export to a smaller optimized format, with explicit Yomitan import/export paths

### Backlog

- [ ] Full-text search option per dictionary for searching glosses
- [ ] Voice input for search
- [ ] Default TTS

## Contributing

Contributions are welcome. Browse the [issue tracker](https://github.com/ManabiIO/manabitan/issues) and read [CONTRIBUTING.md](./CONTRIBUTING.md) before starting a substantial change so we can coordinate early.

Useful contributions include tests, type coverage, documentation, language support, performance work, and reproducible bug reports. Manabitan also remains close enough to Yomitan that improvements can often benefit both projects.

Join the [Manabi Discord](https://discord.gg/gvxzS93C3w) or the [Yomitan Discord](https://discord.gg/YkQrXW6TXF).

## Building Manabitan

1. Install Node.js 22+ and npm.
2. Run `npm ci`.
3. Run `npm run license-report:html`.
4. Run `npm run build` for a local testing build, or `npm run-script build -- --all --version {version}` for release builds.
5. Browser packages are written to `builds/`.

For more information, see [CONTRIBUTING.md](./CONTRIBUTING.md#setup).

## Reproducible source build

Clone and check out the exact revision you want to reproduce, then run:

```bash
npm ci
npm run build:source-release -- --version <version>
```

This runs the library build, license report, and all-browser release build. Outputs include:

- `manabitan-chrome.zip`
- `manabitan-firefox.zip`
- `manabitan-firefox-dev.zip`
- `manabitan-edge.zip`

## Release tagging

Tag releases with `./tag.sh` from the repository root. By default it requires `main` and creates a CalVer-style four-part tag (`YY.M.D.N`). Set `MANABITAN_RELEASE_BRANCH=<branch>` to tag another branch.

## Third-party libraries and attribution

Manabitan uses third-party libraries under their respective licenses. Run `npm run license-report:markdown` or inspect the generated license report for the current dependency inventory.

MDX import support uses [PyGlossary](https://github.com/ilius/pyglossary), licensed under GPLv3. `fallback-bloop.mp3` is provided by [UNIVERSFIELD](https://pixabay.com/sound-effects/error-8-206492/) under the Pixabay Content License.

Manabitan is based on [Yomitan](https://github.com/yomidevs/yomitan), which continues the work started by [Yomichan](https://github.com/FooSoft/yomichan).
