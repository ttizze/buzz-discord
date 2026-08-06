#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uploader="$repo_root/scripts/mobile-testflight-upload.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mock_bin="$tmp/bin"
archive="$tmp/Buzzcord.xcarchive"
key_path="$tmp/AuthKey_TESTKEY.p8"
mkdir -p "$mock_bin" "$archive"
: > "$archive/Info.plist"
: > "$key_path"

cat > "$mock_bin/uname" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' Darwin
MOCK

cat > "$mock_bin/plutil" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$PLUTIL_LOG"
printf '\n' >> "$PLUTIL_LOG"
case " $* " in
  *" ApplicationProperties.CFBundleIdentifier "*) printf '%s\n' com.ttizze.buzzDiscord ;;
  *" ApplicationProperties.CFBundleShortVersionString "*) printf '%s\n' 1.0.0 ;;
  *" ApplicationProperties.CFBundleVersion "*) printf '%s\n' 42 ;;
  *" -create xml "*) : > "${@: -1}" ;;
esac
MOCK

cat > "$mock_bin/xcodebuild" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" > "$XCODEBUILD_LOG"
printf '\n' >> "$XCODEBUILD_LOG"
MOCK

chmod +x "$mock_bin/uname" "$mock_bin/plutil" "$mock_bin/xcodebuild"

export PATH="$mock_bin:/usr/bin:/bin"
export PLUTIL_LOG="$tmp/plutil.log"
export XCODEBUILD_LOG="$tmp/xcodebuild.log"
export BUZZ_TESTFLIGHT_ENV_FILE="$tmp/missing-config"
export ASC_KEY_ID=TESTKEY
export ASC_ISSUER_ID=00000000-1111-2222-3333-444444444444
export ASC_KEY_PATH="$key_path"
export ASC_TEAM_ID=TEAM123

"$uploader" "$archive" > "$tmp/output.log"

grep -Fq -- '-exportArchive' "$XCODEBUILD_LOG"
grep -Fq -- "-archivePath $archive" "$XCODEBUILD_LOG"
grep -Fq -- "-authenticationKeyPath $key_path" "$XCODEBUILD_LOG"
grep -Fq -- '-authenticationKeyID TESTKEY' "$XCODEBUILD_LOG"
grep -Fq -- '-authenticationKeyIssuerID 00000000-1111-2222-3333-444444444444' "$XCODEBUILD_LOG"
grep -Fq -- '-allowProvisioningUpdates' "$XCODEBUILD_LOG"
grep -Fq -- '-insert method -string app-store-connect' "$PLUTIL_LOG"
grep -Fq -- '-insert destination -string upload' "$PLUTIL_LOG"
grep -Fq -- '-insert teamID -string TEAM123' "$PLUTIL_LOG"
grep -Fq -- 'com.ttizze.buzzDiscord 1.0.0 (42)' "$tmp/output.log"

export ASC_KEY_PATH="$tmp/does-not-exist.p8"
if "$uploader" "$archive" > "$tmp/missing-key.out" 2> "$tmp/missing-key.err"; then
  echo "expected missing API key to fail" >&2
  exit 1
fi
grep -Fq 'App Store Connect API key is missing' "$tmp/missing-key.err"

printf '%s\n' 'mobile TestFlight API-key upload contract passed'
