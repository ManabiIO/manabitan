![Manabitan icon](ext/images/icon128.png)

# Manabitan

[Download for Chrome, Firefox, Edge](https://github.com/ManabiIO/manabitan/releases/latest)
[Firefox Dev Builds](https://github.com/ManabiIO/manabitan/releases/latest)

[![CI](https://img.shields.io/github/actions/workflow/status/ManabiIO/manabitan/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/ManabiIO/manabitan/actions/workflows/ci.yml)
[![GitHub Downloads](https://img.shields.io/github/downloads/ManabiIO/manabitan/total?style=for-the-badge&label=Downloads)](https://github.com/ManabiIO/manabitan/releases)
[![Test Coverage](https://img.shields.io/badge/test%20coverage-100%25-brightgreen?style=for-the-badge)](https://github.com/ManabiIO/manabitan/blob/main/docs/development/npm-scripts.md#testcoverage)
[![Manabi Discord](https://dcbadge.limes.pink/api/server/gvxzS93C3w?style=for-the-badge)](https://discord.gg/gvxzS93C3w)
[![Discord](https://dcbadge.limes.pink/api/server/YkQrXW6TXF?style=for-the-badge)](https://discord.gg/YkQrXW6TXF)

# Differences from Yomitan

## Speed

![manabitan_vs_yomitan_chart](https://github.com/user-attachments/assets/1351b902-c918-43a6-b4ac-c64c333fa68d)

## Features

- MDX dictionary support (now supports 20,000 more dicts than Yomitan)
- Auto-updating dictionaries, never manually update a dictionary again.
- Schedule when a specific dictionary updates (hourly, daily, weekly, monthly) ((Imports are so fast you won't even notice it's updating))
- Blur when word is under a certain frequency to force you to recall it.
- Edit dictionary metadata (name etc) after importing.
- Install all reccomended dicts with one button
- Update all dicts with one button
- Custom themes built in. Glass, Autumn, Tokyo, Dark etc

## Nerdy

- 100% test coverage with extensive end to end tests
- Significantly less RAM usage
- Auto import Kiku/Lapis/Senren/Crop-Theft Anki Note types.
- No scan length. Before you had to say "only scan 10 characters", now you don't have to do that. We will show you the longest possible word in the dict (plus a few more characters for grammar etc)

We have benchmarks for these 3 things:

1. Importing dictionaries
2. Looking up words
3. Adding to Anki

We regularly benchmark these 3 things and if if it becomes slower than normal we will work to fix it.

If a new feature or bug makes one of these 3 things slower, we will exterminate it ruthlessly to ensure we are the best dictionary app on the market.

Manabitan is a dictionary app that lets you mine to Anki. If this is not fast, then what is the point of this software?

## Why not contribute to Yomitan directly?

A lot of this stuff is experimental and may break.

When you use this software you are aware it may break, but you also want a significantly beefed up and improved version of Yomitan.

I am also [actively](https://github.com/yomidevs/yomitan/issues?q=is%3Apr%20author%3Abee-san) pushing PRs to Yomitan to improve it based on this work.

Using this fork and telling me what works and doesn't will allow me to contribute back to Yomitan easier.

# Visit [yomitan.wiki](https://yomitan.wiki) to learn more!

> Documentation currently lives on the legacy Yomitan wiki. Manabitan is feature-compatible, so the Yomitan wiki guides still apply.

:wave: **Manabitan is a fast Yomitan.** It forks Yomitan to provide the same functionality with much faster imports and lookups. It also deduplicates and compresses Yomitan entries to reduce storage use.

## Why the name change Manabitan?

Manabitan changes core Yomitan database technology to deliver major performance gains. Because of that, merging this directly upstream and migrating every existing Yomitan setup at once would be risky. This project prioritizes shipping and stabilizing the new technology first, then addressing broad migration paths. It is built by the developer of [Manabi Reader](https://reader.manabi.io/), who previously pioneered similar Yomitan performance optimizations now prototyped for the upcoming Manabi Reader update.

📢 **New contributors [welcome](#contributing)!**

📢 **Interested in adding a new language to Manabitan? See [here](./docs/development/language-features.md) for thorough documentation!**

## Features

Manabitan turns your web browser into a tool for building language literacy by helping you **read** texts that would otherwise be too difficult to tackle in [a variety of supported languages](https://yomitan.wiki/supported-languages/).

Manabitan provides powerful features not available in other browser-based dictionaries:

- 💬 Interactive popup definition window for displaying search results.
- 🔊 Built-in native pronunciation audio with the ability to add your own [custom audio sources](https://yomitan.wiki/advanced/#default-audio-sources).
- ✍️ Kanji stroke order diagrams are just a click away.
- 📝 [Automatic flashcard creation](https://yomitan.wiki/anki/) for the [Anki](https://apps.ankiweb.net/) flashcard program via the [AnkiConnect](https://foosoft.net/projects/anki-connect) plugin.
- 🔍 Custom search page for easily executing custom search queries.
- 📖 Support for multiple dictionary formats including [EPWING](https://ja.wikipedia.org/wiki/EPWING) via the [Yomitan Import](https://github.com/yomidevs/yomitan-import) tool.
- ✨ Clean, modern code makes it easy for developers to [contribute](#contributing) new features and languages.

[![Term definitions](docs/images/ss-terms-thumb.png)](docs/images/ss-terms.png)
[![Kanji information](docs/images/ss-kanji-thumb.png)](docs/images/ss-kanji.png)
[![Dictionary options](docs/images/ss-dictionaries-thumb.png)](docs/images/ss-dictionaries.png)
[![Anki options](docs/images/ss-anki-thumb.png)](docs/images/ss-anki.png)

## Documentation/How To

**Please visit the [Yomitan Wiki](https://yomitan.wiki) for the most up-to-date usage documentation (legacy docs, feature-compatible with Manabitan).**

### Developer Documentation

- Dictionaries
  - 🛠️ [Making Manabitan Dictionaries](./docs/making-yomitan-dictionaries.md)
- Anki Integration
  - 🔧 [Anki handlebar templates](./docs/templates.md)
- Advanced Features
- Troubleshooting
  - 🕷️ [Known browser bugs](./docs/browser-bugs.md)

## Installation

Install from the latest GitHub release page:

### [Download for Chrome, Firefox, Edge](https://github.com/ManabiIO/manabitan/releases/latest)

## Roadmap

### Priority (unsorted)

- [ ] Auto-update
- [ ] Ereader performance
- [ ] Improve onboarding for easier default installation
- [ ] Change Manabitan import/export to a smaller, optimized format, and provide separate Yomitan import/export paths

### Backlog

- [ ] Full-text search option per dictionary for searching glosses
- [ ] Voice input for search
- [ ] Default TTS

### Optimization TODO

- [ ] Import
- [ ] Export
- [ ] Yomitan import
- [ ] Yomitan export
- [ ] Deletion
- [ ] Lookups
- [ ] 64KB chunking of glossaries for compression
- [ ] Add the ManabiDictionaries custom zstd dictionaries

## Contributing

🚀 **Dip your toes into contributing by looking at issues with the label [good first issue](https://github.com/ManabiIO/manabitan/issues?q=is%3Aissue+is%3Aopen+label%3A%22gоοd+fіrst+іssսe%22).**

Since this is a distributed effort, we **highly welcome new contributors**! Feel free to browse the [issue tracker](https://github.com/ManabiIO/manabitan/issues), and read our [contributing guidelines](./CONTRIBUTING.md).

Here are some ways anyone can help:

- Try using the Manabitan dev build. Not only do you get cutting edge features, but you can help uncover bugs and give feedback to developers early on.
- Document any UI/UX friction in GitHub Issues. We're looking to make Manabitan more accessible to non-technical users.
- All the issues in `area/bug` older than 2 months need help reproducing. If anything interests you, please try to reproduce it and report your results. We can't easily tell if these issues are one-off, have since been resolved, or are no longer relevant.

> The current active maintainers of Manabitan spend a lot of their time debugging and triaging issues. When someone files a bug report, we need to assess the frequency and severity of the bug. It is extremely helpful if we get multiple reports of people who experience a bug or people who can contribute additional detail to an existing bug report.

If you're looking to code, please let us know what you plan on working on before submitting a Pull Request. This gives the core maintainers an opportunity to provide feedback early on before you dive too deep. You can do this by opening a GitHub Issue with the proposal.

Some contributions we always appreciate:

- Well-written tests covering different functionalities. This includes [playwright tests](https://github.com/yomidevs/yomitan/tree/master/test/playwright), [benchmark tests](https://github.com/yomidevs/yomitan/tree/master/benches), and unit tests.
- Increasing our type coverage.
- More and better documentation!

Information on how to setup and build the codebase can be found [here](./CONTRIBUTING.md#setup).

If you want to add or improve support for a language, read the documentation on [language features](./docs/development/language-features.md).

Feel free to join us on the [Manabi Discord](https://discord.gg/gvxzS93C3w) or the [Yomitan Discord](https://discord.gg/YkQrXW6TXF).

## Building Manabitan

1. Install [Node.js](https://nodejs.org/) and [npm](https://docs.npmjs.com/).

2. Run `npm ci` to set up the environment.

3. Run `npm run license-report:html` to generate any missing or changed license information.

4. Run `npm run build` for a plain testing build or `npm run-script build -- --all --version {version}` for a release build (replacing `{version}` with a version number).

5. The builds for each browser and release branch can be found in the `builds` directory.

For more information, see [Contributing](./CONTRIBUTING.md#setup).

## Reproducible Source Build

This section documents how to build an exact copy of the distributed extension packages from source.

### Environment requirements

- Operating system: Linux or macOS (CI uses Ubuntu).
- Node.js: `>=22.0.0` (from `package.json` `engines.node`).
- npm: bundled with your Node.js installation.

### Tool installation

1. Install Node.js 22+ from [nodejs.org](https://nodejs.org/).
2. Verify tool versions:
   - `node --version`
   - `npm --version`

### Exact rebuild steps

1. Clone and checkout the exact source revision you want to reproduce:

   ```bash
   git clone https://github.com/ManabiIO/manabitan.git
   cd manabitan
   git checkout <tag-or-commit>
   ```

2. Install dependencies exactly as locked:

   ```bash
   npm ci
   ```

3. Run the full release source build script (all required technical steps):

   ```bash
   npm run build:source-release -- --version <version>
   ```

This executes:

- `npm run build:libs`
- `npm run license-report:html`
- `npm run-script build -- --all --version <version>`

### Build outputs

The generated browser packages are written to the `builds/` directory, including:

- `manabitan-chrome.zip`
- `manabitan-firefox.zip`
- `manabitan-firefox-dev.zip`
- `manabitan-edge.zip`

### Release Tagging

- Tag releases with `./tag.sh` from the repository root.
- By default, the script requires you to be on `main` and creates a CalVer-style 4-part tag (`YY.M.D.N`).
- To tag from a different branch, set `MANABITAN_RELEASE_BRANCH=<branch>` when running the script.

## Third-Party Libraries

Manabitan uses several third-party libraries to function.

<!-- The following table is generated using the command `npm run license-report:markdown`. -->

| Name                | License type | Link                                                                   |
| :------------------ | :----------- | :--------------------------------------------------------------------- |
| @resvg/resvg-wasm   | MPL-2.0      | git+ssh://git@github.com/yisibl/resvg-js.git                           |
| @zip.js/zip.js      | BSD-3-Clause | git+https://github.com/gildas-lormeau/zip.js.git                       |
| dexie               | Apache-2.0   | git+https://github.com/dexie/Dexie.js.git                              |
| dexie-export-import | Apache-2.0   | git+https://github.com/dexie/Dexie.js.git                              |
| hangul-js           | MIT          | git://github.com/e-/Hangul.js.git                                      |
| kanji-processor     | n/a          | https://registry.npmjs.org/kanji-processor/-/kanji-processor-1.0.2.tgz |
| parse5              | MIT          | git://github.com/inikulin/parse5.git                                   |
| yomitan-handlebars  | MIT          | n/a                                                                    |
| linkedom            | ISC          | git+https://github.com/WebReflection/linkedom.git                      |

## Attribution

MDX import support uses [PyGlossary](https://github.com/ilius/pyglossary), licensed under the [GNU GPLv3](https://raw.githubusercontent.com/ilius/pyglossary/master/LICENSE).
`fallback-bloop.mp3` is provided by [UNIVERSFIELD](https://pixabay.com/sound-effects/error-8-206492/) and licensed under the [Pixabay Content License](https://pixabay.com/service/license-summary/).
