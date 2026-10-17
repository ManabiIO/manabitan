#!/usr/bin/env bash
set -euo pipefail

device="${1:?Expected an explicit Android emulator serial}"
package="${2:?Expected Firefox Android package name}"
preference_key="pref_key_remote_debugging"

if [[ "${MANABITAN_ANDROID_ENABLE_FIREFOX_REMOTE_DEBUGGING:-}" != "1" ]]; then
    echo "Firefox Android remote debugging setup requires MANABITAN_ANDROID_ENABLE_FIREFOX_REMOTE_DEBUGGING=1." >&2
    exit 1
fi
if [[ "${device}" != emulator-* ]]; then
    echo "Refusing to modify Firefox preferences on non-emulator device: ${device}" >&2
    exit 1
fi
if [[ "${package}" != "org.mozilla.firefox" ]]; then
    echo "Unsupported Firefox package for Fenix preference setup: ${package}" >&2
    exit 1
fi

adb -s "${device}" wait-for-device
adb -s "${device}" root
adb -s "${device}" wait-for-device
root_uid="$(adb -s "${device}" shell id -u | tr -d '\r')"
if [[ "${root_uid}" != "0" ]]; then
    echo "Android emulator did not grant adb root; cannot safely enable Firefox remote debugging." >&2
    exit 1
fi

# Fenix creates its private preferences file after first launch. Wait for that
# specific file, then stop it before changing the disposable emulator profile.
adb -s "${device}" shell monkey -p "${package}" 1 >/dev/null
preferences="/data/data/${package}/shared_prefs/fenix_preferences.xml"
app_uid="$(adb -s "${device}" shell "cmd package list packages -U ${package}" | tr -d '\r' | sed -n 's/.*uid:\([0-9][0-9]*\).*/\1/p' | head -n 1)"
if [[ -z "${app_uid}" ]]; then
    echo "Could not determine Android UID for ${package}; refusing to edit its private preferences." >&2
    exit 1
fi

ready=0
for attempt in $(seq 1 30); do
    if adb -s "${device}" shell test -f "${preferences}"; then
        ready=1
        break
    fi
    sleep 1
done
if [[ "${ready}" != "1" ]]; then
    echo "Fenix did not create ${preferences} within 30 seconds after launch." >&2
    exit 1
fi
adb -s "${device}" shell am force-stop "${package}"

metadata="$(adb -s "${device}" shell "toybox stat -c '%u %g %a' ${preferences}" | tr -d '\r')"
read -r file_uid file_gid file_mode <<<"${metadata}"
if [[ "${file_uid}" != "${app_uid}" || -z "${file_gid}" || -z "${file_mode}" ]]; then
    echo "Unexpected ownership or mode for ${preferences}: ${metadata}; expected app UID ${app_uid}." >&2
    exit 1
fi
file_context="$(adb -s "${device}" shell "ls -Z ${preferences}" | awk '{print $1}' | tr -d '\r')"
if [[ -z "${file_context}" ]]; then
    echo "Could not capture SELinux context for ${preferences}." >&2
    exit 1
fi

local_dir="$(mktemp -d "${TMPDIR:-/tmp}/manabitan-fenix-prefs.XXXXXX")"
local_xml="${local_dir}/fenix_preferences.xml"
adb -s "${device}" pull "${preferences}" "${local_xml}" >/dev/null
python3 - "${local_xml}" "${preference_key}" <<'PY'
import sys
import xml.etree.ElementTree as ET

file_path, key = sys.argv[1:]
tree = ET.parse(file_path)
root = tree.getroot()
if root.tag != "map":
    raise SystemExit(f"Unexpected Fenix preferences XML root: {root.tag!r}")

entries = [entry for entry in root if entry.attrib.get("name") == key]
for entry in entries:
    root.remove(entry)
ET.SubElement(root, "boolean", {"name": key, "value": "true"})
tree.write(file_path, encoding="utf-8", xml_declaration=True)
PY

remote_xml="/data/local/tmp/manabitan-fenix-preferences-${$}.xml"
adb -s "${device}" push "${local_xml}" "${remote_xml}" >/dev/null
adb -s "${device}" shell "cat ${remote_xml} > ${preferences}"
adb -s "${device}" shell "chown ${file_uid}:${file_gid} ${preferences}"
adb -s "${device}" shell "chmod ${file_mode} ${preferences}"
if adb -s "${device}" shell command -v restorecon >/dev/null 2>&1; then
    adb -s "${device}" shell "restorecon ${preferences}"
else
    adb -s "${device}" shell "chcon ${file_context} ${preferences}"
fi

adb -s "${device}" pull "${preferences}" "${local_dir}/readback.xml" >/dev/null
python3 - "${local_dir}/readback.xml" "${preference_key}" <<'PY'
import sys
import xml.etree.ElementTree as ET

file_path, key = sys.argv[1:]
root = ET.parse(file_path).getroot()
entries = [entry for entry in root if entry.attrib.get("name") == key]
if len(entries) != 1 or entries[0].tag != "boolean" or entries[0].attrib.get("value") != "true":
    raise SystemExit(f"Expected exactly one true boolean {key!r}; found {[(e.tag, e.attrib) for e in entries]!r}")
PY

echo "Enabled and verified Fenix remote debugging in disposable emulator profile ${device}; working XML: ${local_xml}"
adb -s "${device}" shell monkey -p "${package}" 1 >/dev/null
