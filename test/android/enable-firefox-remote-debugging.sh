#!/usr/bin/env bash
set -euo pipefail

device="${1:?Expected an explicit Android emulator serial}"
package="${2:?Expected Firefox Android package name}"
mode="${3:-configure}"
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

preferences="/data/data/${package}/shared_prefs/fenix_preferences.xml"
verify_preference() {
    local local_dir local_xml
    local_dir="$(mktemp -d "${TMPDIR:-/tmp}/manabitan-fenix-verify.XXXXXX")"
    local_xml="${local_dir}/fenix_preferences.xml"
    adb -s "${device}" pull "${preferences}" "${local_xml}" >/dev/null
    python3 - "${local_xml}" "${preference_key}" <<'PY'
import sys
import xml.etree.ElementTree as ET

file_path, key = sys.argv[1:]
root = ET.parse(file_path).getroot()
entries = [entry for entry in root if entry.attrib.get("name") == key]
if len(entries) != 1 or entries[0].tag != "boolean" or entries[0].attrib.get("value") != "true":
    raise SystemExit(f"Expected exactly one true boolean {key!r}; found {[(e.tag, e.attrib) for e in entries]!r}")
PY
}

if [[ "${mode}" == "--verify-after-launch" ]]; then
    verified=0
    for attempt in $(seq 1 15); do
        if verify_preference 2>/dev/null; then
            verified=1
            break
        fi
        sleep 1
    done
    if [[ "${verified}" != "1" ]]; then
        echo "Fenix did not retain ${preference_key}=true after the Firefox Android install ACK." >&2
        exit 1
    fi
    echo "Verified ${preference_key}=true after Firefox Android launched and acknowledged the temporary add-on."
    exit 0
fi
if [[ "${mode}" != "configure" ]]; then
    echo "Unsupported helper mode: ${mode}" >&2
    exit 1
fi

# Initialize Fenix's private preferences before quiescing the package.
adb -s "${device}" shell monkey -p "${package}" 1 >/dev/null
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

# Record PackageManager's exact enabled state so every failure path can restore it.
package_state="$(adb -s "${device}" shell "dumpsys package ${package}" | sed -n 's/.*User 0:.*enabled=\([0-4]\).*/\1/p' | head -n 1 | tr -d '\r')"
if [[ ! "${package_state}" =~ ^[0-4]$ ]]; then
    echo "Could not determine ${package} enabled state from PackageManager; refusing to edit preferences." >&2
    exit 1
fi
if [[ "${package_state}" != "0" && "${package_state}" != "1" ]]; then
    echo "Refusing to change preferences while ${package} has non-enabled PackageManager state ${package_state}." >&2
    exit 1
fi

package_disabled=0
restore_package_state() {
    if [[ "${package_disabled}" == "1" ]]; then
        adb -s "${device}" shell "pm enable --user 0 ${package}" >/dev/null || true
        if [[ "${package_state}" == "0" ]]; then
            adb -s "${device}" shell "pm default-state --user 0 ${package}" >/dev/null || true
        fi
    fi
}
trap restore_package_state EXIT

adb -s "${device}" shell "am force-stop --user 0 ${package}"
package_disabled=1
adb -s "${device}" shell "pm disable-user --user 0 ${package}" >/dev/null
for attempt in $(seq 1 20); do
    if ! adb -s "${device}" shell "pidof ${package}" 2>/dev/null | tr -d '\r' | grep -q '[0-9]'; then
        break
    fi
    sleep 1
done
if adb -s "${device}" shell "pidof ${package}" 2>/dev/null | tr -d '\r' | grep -q '[0-9]'; then
    echo "Firefox process remained alive after disabling ${package}; refusing to edit cached preferences." >&2
    exit 1
fi

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
write_preference_file() {
    local remote_path="$1"
    local local_path="$2"
    adb -s "${device}" pull "${remote_path}" "${local_path}" >/dev/null
    python3 - "${local_path}" "${preference_key}" <<'PY'
import sys
import xml.etree.ElementTree as ET

file_path, key = sys.argv[1:]
tree = ET.parse(file_path)
root = tree.getroot()
if root.tag != "map":
    raise SystemExit(f"Unexpected Fenix preferences XML root: {root.tag!r}")
for entry in list(root):
    if entry.attrib.get("name") == key:
        root.remove(entry)
ET.SubElement(root, "boolean", {"name": key, "value": "true"})
tree.write(file_path, encoding="utf-8", xml_declaration=True)
PY
    local remote_temp="${remote_path}.manabitan-${$}.tmp"
    adb -s "${device}" push "${local_path}" "${remote_temp}" >/dev/null
    adb -s "${device}" shell "chown ${file_uid}:${file_gid} ${remote_temp}"
    adb -s "${device}" shell "chmod ${file_mode} ${remote_temp}"
    adb -s "${device}" shell "chcon ${file_context} ${remote_temp}"
    adb -s "${device}" shell "mv -f ${remote_temp} ${remote_path}"
}

write_preference_file "${preferences}" "${local_dir}/fenix_preferences.xml"
# Android SharedPreferences restores .bak over XML on load. Update an existing
# backup too, so a stale pending write cannot undo the setting at first launch.
if adb -s "${device}" shell test -f "${preferences}.bak"; then
    backup_metadata="$(adb -s "${device}" shell "toybox stat -c '%u %g %a' ${preferences}.bak" | tr -d '\r')"
    read -r backup_uid backup_gid backup_mode <<<"${backup_metadata}"
    if [[ "${backup_uid}" != "${app_uid}" || -z "${backup_gid}" || -z "${backup_mode}" ]]; then
        echo "Unexpected ownership or mode for ${preferences}.bak: ${backup_metadata}; refusing to edit preferences." >&2
        exit 1
    fi
    backup_context="$(adb -s "${device}" shell "ls -Z ${preferences}.bak" | awk '{print $1}' | tr -d '\r')"
    if [[ -z "${backup_context}" ]]; then
        echo "Could not capture SELinux context for ${preferences}.bak." >&2
        exit 1
    fi
    # Use the backup's original metadata/context while applying the same value.
    saved_uid="${file_uid}"; saved_gid="${file_gid}"; saved_mode="${file_mode}"; saved_context="${file_context}"
    file_uid="${backup_uid}"; file_gid="${backup_gid}"; file_mode="${backup_mode}"; file_context="${backup_context}"
    write_preference_file "${preferences}.bak" "${local_dir}/fenix_preferences.xml.bak"
    file_uid="${saved_uid}"; file_gid="${saved_gid}"; file_mode="${saved_mode}"; file_context="${saved_context}"
fi

# Confirm the staged value while the package is still unable to restore a stale cache.
verify_preference
restore_package_state
package_disabled=0
echo "Configured Fenix remote debugging in disposable emulator profile ${device}; web-ext will launch Firefox and post-ACK verification will confirm persistence."
