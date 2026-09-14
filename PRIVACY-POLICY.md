# Privacy policy for Manabitan

Manabitan is a separately maintained fork of Yomitan. It stores dictionaries and settings locally in the browser's extension storage; normal dictionary lookup uses installed data. Local storage is not a backup, and removing an extension or browser profile can remove that data.

## Dictionary downloads and updates

Installing dictionaries contacts their configured publishers or download hosts. Enabled automatic updates can make update checks and downloads without a new click for each request. Those destinations receive the requested URL and normal network metadata, including an IP address. A custom URL can contain account-specific information. Dictionaries without a usable update source are not automatically updated merely because they can be imported.

## Audio

Audio lookup can send a term, reading, and language to configured sources. These can include JapanesePod101/LanguagePod101, Jisho, Lingua Libre or Wiktionary through Wikimedia services, and user-configured custom sources. Autoplay can trigger requests without pressing the speaker for each entry. Availability and handling by a third-party source are governed by that service.

Browser text-to-speech depends on the browser, operating system, and selected voice. A voice may use an external provider; this policy does not promise that every voice is processed locally.

## Anki

When enabled, Manabitan communicates with the configured AnkiConnect endpoint. Depending on the configured fields and actions, data can include dictionary entries, sentence text, the current page URL/title, screenshots, clipboard contents, and settings needed to create or check notes. Only enable fields and actions you intend to use.

The usual endpoint is local. A user-configured remote endpoint changes where that information goes. Anki's own collection synchronization is a separate service and is not controlled by the extension's local connection setting.

## External API and native helpers

The optional external API allows other applications to request data when enabled. Optional native messaging, including MeCab integration, can send text to a separately installed helper. Enable these only for integrations you intend to use. The behavior of that helper or downstream application is separate from Manabitan.

## Clipboard, diagnostics, and backups

Clipboard permissions support explicitly enabled search, copying, or note-field features. Settings and diagnostic exports may contain URLs, dictionary names, custom templates, error text, and local paths. Review and redact exports before sharing them; do not post credentials, private page content, or proprietary dictionary data in a public report.

Keep backups somewhere you control. Settings exports, original dictionary packages, and whole-database backups are not interchangeable. See the [backup guide](https://manabi.io/manabitan/dictionaries/#backups-and-settings).

## Permissions and documentation website

See [Privacy and permissions](https://manabi.io/manabitan/privacy/) for the purpose of the browser permissions, including storage, scheduled alarms, website access, Chromium offscreen documents, and optional integrations. The exact permissions are defined by the distributed browser package.

The Manabitan documentation website is separate from the extension. Its server and any configured delivery proxy receive normal website requests. Following a third-party link or visiting a community, store, or service is subject to that destination's practices.
