#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat >&2 <<'USAGE'
usage: scripts/mobile-testflight-upload.sh <archive.xcarchive> [export-directory]

Uploads an existing iOS archive to TestFlight with an App Store Connect API
key. The script reads .env.testflight.local when present, then uses:

  ASC_KEY_ID       App Store Connect API key ID
  ASC_ISSUER_ID    App Store Connect API issuer ID
  ASC_KEY_PATH     Optional .p8 path; defaults to
                   ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
  ASC_TEAM_ID      Optional Apple Developer team ID for export options
USAGE
  exit 2
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

[[ "$#" -ge 1 && "$#" -le 2 ]] || usage

config_file="${BUZZ_TESTFLIGHT_ENV_FILE:-$repo_root/.env.testflight.local}"
if [[ -f "$config_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$config_file"
  set +a
fi

[[ "$(uname -s)" == "Darwin" ]] || fail "TestFlight upload requires macOS"
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild is required"
command -v plutil >/dev/null 2>&1 || fail "plutil is required"

: "${ASC_KEY_ID:?ASC_KEY_ID is required (set it in .env.testflight.local)}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required (set it in .env.testflight.local)}"

if [[ -z "${ASC_KEY_PATH:-}" ]]; then
  ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
fi

archive_path="$1"
[[ -d "$archive_path" ]] || fail "archive does not exist: $archive_path"
[[ -f "$archive_path/Info.plist" ]] || fail "archive Info.plist is missing: $archive_path/Info.plist"
[[ -f "$ASC_KEY_PATH" ]] || fail "App Store Connect API key is missing: $ASC_KEY_PATH"

bundle_id="$(plutil -extract ApplicationProperties.CFBundleIdentifier raw -o - "$archive_path/Info.plist")" || \
  fail "could not read bundle identifier from archive"
version="$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw -o - "$archive_path/Info.plist")" || \
  fail "could not read version from archive"
build="$(plutil -extract ApplicationProperties.CFBundleVersion raw -o - "$archive_path/Info.plist")" || \
  fail "could not read build number from archive"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/buzz-testflight-upload.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

export_options="$tmp_dir/ExportOptions.plist"
plutil -create xml "$export_options"
plutil -insert method -string app-store-connect "$export_options"
plutil -insert destination -string upload "$export_options"
plutil -insert signingStyle -string automatic "$export_options"
plutil -insert manageAppVersionAndBuildNumber -bool false "$export_options"
if [[ -n "${ASC_TEAM_ID:-}" ]]; then
  plutil -insert teamID -string "$ASC_TEAM_ID" "$export_options"
fi

if [[ "$#" -eq 2 ]]; then
  export_path="$2"
  mkdir -p "$export_path"
else
  export_path="$tmp_dir/export"
  mkdir -p "$export_path"
fi

printf 'Uploading %s %s (%s) from %s with App Store Connect API key %s.\n' \
  "$bundle_id" "$version" "$build" "$archive_path" "$ASC_KEY_ID"

xcodebuild -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options" \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  -allowProvisioningUpdates

printf 'TestFlight upload submitted for %s %s (%s).\n' "$bundle_id" "$version" "$build"
