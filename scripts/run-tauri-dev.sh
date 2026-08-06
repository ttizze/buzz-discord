#!/usr/bin/env bash
# Stable-sign the macOS development binary before Tauri launches it.
#
# macOS legacy Keychain ACLs identify trusted applications by their code
# signing requirement. Rust's linker gives each debug build an ad-hoc
# signature whose code hash changes on every rebuild, so Keychain's "Always
# Allow" decision cannot survive hot reloads. A local Apple Development
# identity gives the binary a stable, team-anchored designated requirement.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "run-tauri-dev: expected the application binary as the first argument" >&2
    exit 2
fi

app_binary="$1"
shift

if [[ "$(uname -s)" == "Darwin" ]]; then
    signing_identity="${BUZZ_DEV_CODESIGN_IDENTITY:-}"

    if [[ -z "$signing_identity" ]]; then
        signing_identity="$({
            security find-identity -v -p codesigning 2>/dev/null || true
        } | awk '/"Apple Development:/{ print $2; exit }')"
    fi

    if [[ -n "$signing_identity" ]]; then
        codesign --force --sign "$signing_identity" --timestamp=none "$app_binary"
    else
        echo "Warning: no Apple Development signing identity was found." >&2
        echo "The unsigned Buzz dev build may repeatedly request Keychain access." >&2
        echo "Set BUZZ_DEV_CODESIGN_IDENTITY to a local code-signing identity to fix it." >&2
    fi
fi

exec "$app_binary" "$@"
