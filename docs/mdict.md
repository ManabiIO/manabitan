# MDict dictionaries

Manabitan has experimental import support for MDict `.mdx` definitions and matching `.mdd` resources. This is a Manabitan feature; upstream Yomitan documentation does not describe every supported import path.

The offline **MDict import guide** is available from **Quick Start Guide > Installing Dictionaries**. Its source is [`ext/mdict.html`](../ext/mdict.html); keep the shipped guide and this summary consistent.

## Import a complete set

Open **Settings > Dictionaries > Configure installed and enabled dictionaries > Import**. Choose or drop the MDX and all matching MDD volumes together:

```text
Dictionary.mdx
Dictionary.mdd
Dictionary.1.mdd
Dictionary.2.mdd
```

Only include volumes supplied with that dictionary. Local selections import immediately, whereas URLs added through the Advanced URL interface wait for **Import**. Local conversion does not upload files to a conversion server; URL imports download files, and external links in definitions can open websites.

MDD files cannot be installed alone or attached later. To add omitted resources, remove only the affected dictionary and reimport the complete set. Keep the publisher's filenames and do not rename unrelated files to make them match. Import sets individually when names are ambiguous. A ZIP containing loose MDX/MDD files must be extracted first; the ZIP import path expects a Yomitan-format dictionary.

## Check installation, not only conversion

Wait until the dictionary appears as installed and is enabled for the active profile. Then search for a known headword, an alias, and an entry containing media or a table. Repeat a lookup from a fresh Search page. Conversion reaching 100% is not proof that storage and profile setup succeeded.

Imported dictionaries use Manabitan's regular dictionary storage and lookup path. Installed lookups do not reopen the original MDX file. Keep the original set for reimport and compatibility reports.

## Limits and recovery

- **Dictionary audio is disabled in the current settings import flow.** An audio MDD does not enable it. Separate pronunciation-audio settings are unchanged.
- Some compression, encryption, and format variants are unsupported. Scripts and interactive widgets are not preserved, and layout or styling can differ. A successful import does not certify complete conversion.
- Missing images and incomplete definitions are different problems. Check the original resource set and report specific known entries, exact filenames, and the full error message.
- Truncation or integrity failures warrant a fresh copy of the original set. Renaming does not repair bytes. Do not use **Delete All** as troubleshooting.
- The conversion client has a three-minute deadline covering file reads and worker conversion. Large sets may require a compatible external converter producing a Yomitan ZIP. This deadline is not a performance guarantee.

Contributor notes: [MDict client lifecycle](development/mdict-client.md).

## File matching and conversion notes

A dictionary name ending in a number is not automatically a resource volume:
`Book.2024.mdx` pairs with `Book.2024.mdd`, followed by `Book.2024.1.mdd` and
`Book.2024.2.mdd`. Exact MDX stems take precedence over split-volume suffixes.
File basenames match without regard to case, while distinct relative directories
(including their case) remain separate. The unnumbered MDD is searched before
numbered volumes in numeric order, so a later volume cannot silently replace an
earlier resource with the same archive path. Conflicting duplicate MDX or MDD
paths exclude that dictionary group instead of choosing arbitrary bytes.

URL directory discovery considers HTTP(S) links in the same origin and directory
as the listing. Identical links are deduplicated; distinct URLs for the same MDD
filename are treated as ambiguous. Cross-folder/CDN layouts should be downloaded
locally and selected as a complete set. A generic server download name does not
replace the validated MDX/MDD filename.

Conversion notes distinguish skipped definition records, unresolved aliases,
missing referenced resources, and failed resource reads. Missing-resource counts
are distinct referenced archive keys, not missing volumes or missing definitions;
read-failure and missing-resource counts can overlap. Notes do not prove that
installation committed, and are not installation errors. They clear when the next
import batch starts. Definitions with no resource references need no MDD warning.
