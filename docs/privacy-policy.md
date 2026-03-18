# Manabitan Privacy Policy

Last updated: March 18, 2026

Manabitan is a browser extension for looking up language content directly in the pages you read. This policy describes what data Manabitan handles, how that data is used, and when it may leave your device.

## Summary

- Manabitan stores dictionaries, settings, and related extension data locally in your browser.
- Manabitan does not run analytics, does not sell user data, and does not use user data for advertising.
- Core popup dictionary lookups work locally after dictionaries are installed.
- Some optional or user-triggered features can send limited data to third-party services or local applications so the feature can work.

## Data Manabitan Handles

Manabitan may handle the following categories of data:

- Website text and page context needed to scan text, show popup definitions, and create user-requested exports.
- Dictionary data, settings, and other extension state stored locally in browser storage.
- Clipboard contents, but only if you explicitly enable clipboard-monitoring features or use an Anki template that inserts clipboard data.
- Local integration data for optional tools such as AnkiConnect, the Manabitan API companion, or MeCab native messaging helpers.
- Limited lookup data such as a term, reading, or language when you explicitly use an online audio source.

## How Manabitan Uses Data

Manabitan uses handled data only to provide the extension features you enable, including:

- scanning text on pages and showing popup dictionary results;
- importing, storing, searching, and exporting dictionaries locally;
- playing pronunciation audio from built-in or custom audio sources;
- creating Anki cards through a user-configured local AnkiConnect server;
- parsing text through optional local native-messaging integrations; and
- reading clipboard contents for optional clipboard-monitoring or template features.

## When Data Leaves Your Device

By default, Manabitan keeps dictionaries and settings on your device. Data can leave your device only in the following situations:

- Audio playback or audio download:
  Manabitan may send the looked-up term, reading, and language to the selected audio source when you click or otherwise trigger audio playback.
- Anki integration:
  If you enable Anki integration, Manabitan may send dictionary entry data and any media you explicitly include to the AnkiConnect server you configured. The default AnkiConnect address is local to your device (`http://127.0.0.1:8765`).
- Native messaging integrations:
  If you enable MeCab parsing or the Manabitan API companion, Manabitan may send the relevant query text or settings to the corresponding native application on your device.
- Custom user-configured endpoints:
  If you configure custom audio or companion endpoints, Manabitan may send the data needed to fulfill those requests to the URLs you specify.

Manabitan does not transfer handled data for advertising, profiling, or unrelated analytics purposes.

## Permissions

Manabitan requests permissions only for its language-learning features:

- `<all_urls>` / page access:
  Required to scan text on pages where the extension is enabled, show popup definitions, and perform related user-facing actions.
- `storage` and `unlimitedStorage`:
  Used to keep dictionaries and settings on the device.
- `declarativeNetRequest`:
  Used to make certain fetch requests safer by stripping cookies and adjusting request headers for user-requested resource downloads.
- `scripting`, `offscreen`, and `contextMenus`:
  Used to inject the popup UI, support auxiliary browser-extension pages, and provide context-menu lookups.
- `clipboardWrite`:
  Used for copy-related extension actions.
- `clipboardRead` (optional):
  Used only if you enable clipboard-monitoring features or related templates.
- `nativeMessaging` (optional):
  Used only if you enable local integrations such as MeCab parsing or the Manabitan API companion.

## Sharing, Retention, and Security

- Manabitan does not sell user data.
- Manabitan does not use or transfer user data for purposes unrelated to the extension's single purpose.
- Manabitan does not use or transfer user data to determine creditworthiness or for lending purposes.
- Data stored by Manabitan remains on your device until you remove it, clear browser storage, or uninstall the extension.
- When Manabitan sends data to remote services selected by the extension or by you, it does so only to provide the user-facing feature you invoked.

## Limited Use Disclosure

Manabitan uses website content, browsing context, clipboard contents, and local-integration data only to provide or improve the user-facing language-learning features you enable. Manabitan does not sell this data, does not use it for advertising, and does not transfer it for purposes unrelated to those features.

## Contact

If you have questions about this policy, contact: themoeway@googlegroups.com
