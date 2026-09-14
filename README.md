![Manabitan icon](ext/images/icon128.png)

# Manabitan

[Install Manabitan](https://manabi.io/manabitan/getting-started/) · [Documentation](https://manabi.io/manabitan/) · [Releases](https://github.com/ManabiIO/manabitan/releases) · [Manabi Discord](https://discord.gg/gvxzS93C3w)

Manabitan is a Yomitan fork that keeps the same basic reading/mining workflow while replacing the dictionary storage and query engines and adding quality-of-life improvements around dictionary management and Anki setup.

**[Why use Manabitan instead of Yomitan?](https://manabi.io/manabitan/why-manabitan/)** · **[Why is it a fork?](https://manabi.io/manabitan/about-manabitan/)**

Yomitan's primary maintainers have supported releasing this work as a separate fork, offered guidance, and reviewed our release preparations. Manabitan is maintained and released independently.

## Why use Manabitan instead of Yomitan?

The short version: **less waiting, less dictionary maintenance, and less Anki setup without replacing the workflow that makes Yomitan useful.**

### Faster imports and lookups

Manabitan rewrites dictionary storage and much of the query path. Dictionary imports and normal lookups are heavily optimized, with the biggest practical difference on large collections, older hardware, and e-ink devices.

Installed dictionaries can remain available while new data is prepared. A first-time install still has to finish before that dictionary can be used. Performance varies by build, browser, dictionary collection, and device; we benchmark it, but a single chart is not a universal speed ratio or battery-life guarantee.

### Automatic and scheduled dictionary updates

For dictionaries that provide a usable web update source, Manabitan can check for updates automatically. Current controls include hourly, daily, weekly, and monthly schedules plus bulk update actions.

That is useful because manual dictionary updates are easy to neglect, and they are especially annoying when an update makes the extension unavailable while it runs. The storage rewrite makes routine background updates practical instead of something you have to plan around.

### Better dictionary management

Manabitan also adds MDX support, bulk recommended-dictionary installation, supported metadata editing, and bulk update controls. It continues to support the Yomitan dictionary ecosystem rather than replacing it with a proprietary format.

### Automatic Anki field mapping

If **Kiku**, **Lapis**, **Senren / Senren 洗練**, or **Crop Theft Vocab** already exists in Anki, selecting that note type in Manabitan automatically fills the expected Manabitan/Yomitan field markers instead of making you wire every field by hand.

The presets cover the fields those note types actually use: expressions/readings, audio, definitions, sentence/cloze context, pitch, frequency, source information, and related fields. Kiku/Lapis/Senren can also pick an available dictionary-specific `single-glossary-*` marker for the primary-definition field.

Other note types get best-effort mapping based on familiar field names and aliases such as `Word`, `Term`, `Phrase`, `Definition`, `Meaning`, `Sound`, `Audio`, sentence, pitch, and frequency fields. For unrecognized models, an existing same-named mapping is preserved when possible.

**This does not install the note type into Anki.** Install/import the note type in Anki first, select it in Manabitan, then review the generated field mapping before normal mining. See the [Anki guide](https://manabi.io/manabitan/anki/#automatic-field-mapping) and [mapping implementation](ext/js/data/anki-note-type-field-util.js).

### Reading quality of life

Built-in popup themes and frequency-based recall blur add options around the existing workflow. MeCab, custom audio/Forvo, AnkiConnect, custom templates, CSS, and other upstream/community integrations remain useful where their integration requirements are satisfied.

The goal is not to make a different product for the sake of being different. It is to keep what works in Yomitan and improve the parts that cost time or setup effort.

## Why is Manabitan a separate fork?

The storage and query changes work together. Splitting the transition into upstream pull requests is substantial implementation and review work, and intermediate steps can add complexity before delivering much immediate value on their own. Contributors have tried bringing foundational pieces upstream, but there has not been enough sustained capacity to carry the entire transition through that process.

A separate installation also avoids putting Yomitan's existing users through a major data migration before we are ready to take responsibility for it. That may be worth revisiting later. For now, Manabitan lets us build and prove the architecture with people who deliberately choose it, while useful independent improvements can still flow back upstream under the existing licenses.

The longer version is in [Why Manabitan is a fork](https://manabi.io/manabitan/about-manabitan/).

## Installation and migration

Read the [installation guide](https://manabi.io/manabitan/getting-started/) and the notes for the release you choose. Packages come from this repository's [Releases](https://github.com/ManabiIO/manabitan/releases); an upstream Yomitan store listing is not a Manabitan download. A browser-variant filename does not establish that a release is stable or that a Firefox ZIP is signed.

Keep backups and follow [Moving from Yomitan](https://manabi.io/manabitan/yomitan-migration/) or [Moving from Yomichan](https://manabi.io/manabitan/yomichan-migration/). Individual dictionary packages, settings JSON, and whole-database backups are different formats. Do not assume SQLite collection backups are interchangeable with Yomitan's JSON exports, or that every storage layout can be restored across every build.

## Development and contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment and test commands. Discuss substantial proposals in the [Manabi Discord](https://discord.gg/gvxzS93C3w). While Issues are disabled, use that community for Manabitan-specific questions and reproducible reports rather than sending them to Yomitan's tracker.

The [wiki repository](https://github.com/ManabiIO/manabitan-wiki) owns user documentation. Developer references include [dictionary formats](docs/making-yomitan-dictionaries.md), [Anki templates](docs/templates.md), [language features](docs/development/language-features.md), and [browser bugs](docs/browser-bugs.md). Real project names, compatibility identifiers, and upstream authorship are not renamed indiscriminately.

### Building from source

Use Node.js 22 or newer, then install the exact dependency lock:

```sh
npm ci
npm run build:source-release -- --version <version>
```

The source release command builds libraries, generates license information, and builds the browser variants. Output is written to `builds/`, including `manabitan-chrome.zip`, `manabitan-firefox.zip`, `manabitan-firefox-dev.zip`, and `manabitan-edge.zip`. A local build is not automatically store-signed.

To reproduce a particular release, check out its exact tag or commit before installing dependencies. See [Contributing](CONTRIBUTING.md#setup) for additional setup requirements and the supported test environment. Run unit, static, build, and browser tests appropriate to the change; this README does not equate a configured test suite with release qualification.

### Release tagging

Use `./tag.sh` from the repository root. The default release branch is `main`, and tags use the existing four-part CalVer format. Set `MANABITAN_RELEASE_BRANCH` only when intentionally releasing from another branch. Verify the actual packages, installation persistence, and update channel before announcing support.

## Credits, licensing, and privacy

Manabitan is based on [Yomitan](https://github.com/yomidevs/yomitan), which continues [Yomichan](https://github.com/FooSoft/yomichan) and its contributors' work. The project retains its GPL-3.0-or-later licensing and existing notices. Third-party components retain their respective licenses. See [LICENSE](LICENSE), generated extension license information, and the wiki's [Credits](https://manabi.io/manabitan/credits/).

MDX import support includes work from [PyGlossary](https://github.com/ilius/pyglossary), licensed under GNU GPLv3. `fallback-bloop.mp3` is provided by [UNIVERSFIELD](https://pixabay.com/sound-effects/error-8-206492/) under the [Pixabay Content License](https://pixabay.com/service/license-summary/).

Read the [privacy policy](PRIVACY-POLICY.md) and [permissions guide](https://manabi.io/manabitan/privacy/) before enabling optional network, clipboard, or external integrations.
