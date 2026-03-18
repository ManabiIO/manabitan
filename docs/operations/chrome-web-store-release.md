# Chrome Web Store Release Checklist

Use this checklist when preparing a Manabitan Chrome Web Store submission or update.

## Dashboard URLs

- Privacy policy URL:
  `https://github.com/ManabiIO/manabitan/blob/main/docs/privacy-policy.md`
- Support URL:
  `https://github.com/ManabiIO/manabitan/issues`
- Website URL:
  `https://github.com/ManabiIO/manabitan`

## Expected Release Artifact

- Stable Chrome package:
  `builds/manabitan-chrome.zip`
- Development Chrome package:
  `builds/manabitan-chrome-dev.zip`

## Recommended Store Metadata

- Store name:
  `Manabitan Popup Dictionary`
- Short summary:
  `Fast popup dictionary for language learning with offline dictionaries, customizable audio, and optional Anki integration.`
- Category:
  Education or Productivity. Pick the category that best matches the current listing strategy and keep it consistent across updates.

## Detailed Description Draft

Manabitan is a fast popup dictionary extension for language learning. It helps you look up words directly on the pages you read, then keeps your dictionaries and settings stored locally in the browser.

Manabitan is a fork of Yomitan focused on faster dictionary imports, smaller storage use, and faster lookups while keeping the familiar popup-dictionary workflow language learners rely on.

Key features:

- Interactive popup definitions directly on webpages
- Fast local dictionary import and lookup performance
- Search page for manual lookups
- Support for many languages and multiple dictionary formats
- Optional pronunciation audio from built-in and custom sources
- Optional Anki integration through a local AnkiConnect server
- Works offline for core dictionary lookups after dictionaries are installed

Permission disclosure:

- Manabitan needs page access so it can read text on pages where the extension is enabled, show popup definitions, and perform related user-facing actions such as audio lookup or Anki export.
- Optional clipboard and native-messaging permissions are only used if the user enables clipboard-monitoring or local companion integrations.

## Privacy / Data Use Notes

Make sure the dashboard disclosures match the current behavior in [Privacy Policy](../privacy-policy.md).

The current codebase behavior to describe prominently is:

- Dictionaries and settings are stored locally.
- Core popup lookups work locally after dictionaries are installed.
- Online requests happen for optional or user-triggered features such as pronunciation audio.
- Local integrations are optional and include AnkiConnect, MeCab parsing, clipboard monitoring, and the Manabitan API companion.
- No analytics, ads, or remote-code loading are part of the extension.

## Reviewer Test Instructions

Add the following reviewer instructions in the Chrome Web Store dashboard if helpful:

1. Open the extension and complete the welcome flow.
2. Import at least one recommended dictionary from the built-in dictionary installer.
3. Visit a page with supported-language text.
4. Hold `Shift` and move the cursor over text to trigger popup scanning.
5. Open the search page to test manual lookups without page scanning.
6. Audio playback, Anki integration, clipboard monitoring, and native-messaging features are optional and can be left disabled during review.

## Final Checks

- Build with `npm run license-report:html` if dependency licensing output changed.
- Build the release package with `npm run-script build -- --all --version <version>`.
- Confirm the Chrome upload workflow uses `manabitan-chrome.zip`.
- Confirm the manifest name, description, homepage URL, and permissions match the listing copy and privacy policy.
- Make sure the store listing clearly describes site access, optional integrations, and user-triggered network activity.
