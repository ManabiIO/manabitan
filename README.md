![Manabitan icon](ext/images/icon128.png)

# Manabitan

[Install Manabitan](https://manabi.io/manabitan/getting-started/) · [Documentation](https://manabi.io/manabitan/) · [Releases](https://github.com/ManabiIO/manabitan/releases) · [Manabi Discord](https://discord.gg/gvxzS93C3w)

Manabitan is a Yomitan fork with rewritten dictionary storage and query engines, built for faster imports, background updates, and quicker lookups. Yomitan's primary maintainers have supported releasing this work as a separate fork, offered guidance, and reviewed our release preparations. We maintain and release Manabitan independently, so we can prove the new internals without making Yomitan's existing users take on a major data migration.

[Why Manabitan exists](https://manabi.io/manabitan/about-manabitan/) explains the engineering tradeoffs, upstream relationship, and migration responsibility.

## Less waiting, the same reason to use a dictionary extension

Look up a word where you're reading, choose the dictionaries you need, hear available pronunciation audio, and make an Anki note. Manabitan keeps that workflow while changing the internals that make imports and queries expensive.

The work includes optimized dictionary imports and lookups, MDX support, dictionary metadata editing, built-in themes, frequency-based recall blur, bulk recommended-dictionary installation, and Anki note-type setup. See the [dictionary guide](https://manabi.io/manabitan/dictionaries/), [advanced features](https://manabi.io/manabitan/advanced/), and [Anki guide](https://manabi.io/manabitan/anki/) for the details and build-specific limits.

Installed dictionaries can remain available while new data is imported. A first-time install must still finish before that dictionary can be used. For dictionaries with a usable web update source, scheduled updates can reduce the need to start updates manually. Device suspension, network access, and source availability can delay them.

Speed matters during onboarding and with large dictionaries, especially on slower devices and e-readers. It matters during reading too: waiting for a definition interrupts the flow. Reduced CPU and storage work should help power consumption, but we have not established a measured battery-life improvement. Performance comparisons need the build, dictionaries, device, and test conditions; a badge or a single chart is not a universal guarantee.

## Why a separate fork?

The storage and query changes work together. Splitting the transition into upstream pull requests is substantial implementation and review work, and intermediate steps may add complexity before delivering a useful improvement. Contributors have tried bringing foundational pieces upstream, but there has not been enough sustained capacity to complete the whole transition that way.

A separate installation also avoids putting Yomitan's existing users through a major data migration before we are ready to take responsibility for it. That may be worth revisiting later. For now, we can build and test the architecture together and release it to people who choose it. Useful independent improvements can still go back upstream under the existing licenses.

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
