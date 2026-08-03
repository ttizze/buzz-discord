#!/usr/bin/env bash
# Launch Tauri dev with a post-build runner that stable-signs macOS binaries.

set -euo pipefail

reap_process() {
    local pid="$1"

    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
        if ! kill -0 "$pid" 2>/dev/null; then
            return
        fi
        sleep 0.2
    done

    # AppKit can leave the dev binary alive after its Tauri parent exits, and
    # that orphan ignores SIGTERM while continuing to hold the single-instance
    # lock. It is safe to force-stop here because the executable path below is
    # scoped to this checkout's debug build.
    kill -KILL "$pid" 2>/dev/null || true
}

reap_stale_instance() {
    local app_binary="$PWD/src-tauri/target/debug/buzz-desktop"
    local pid

    if command -v lsof >/dev/null 2>&1 && [[ -f "$app_binary" ]]; then
        while IFS= read -r pid; do
            [[ -n "$pid" ]] || continue
            echo "Stopping stale Buzz dev app (PID $pid)"
            reap_process "$pid"
        done < <(lsof -t "$app_binary" 2>/dev/null | sort -u)
    fi

    if command -v lsof >/dev/null 2>&1 && [[ -n "${BUZZ_VITE_PORT:-}" ]]; then
        while IFS= read -r pid; do
            [[ -n "$pid" ]] || continue
            local process_cwd
            process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
            if [[ "$process_cwd" != "$PWD" ]]; then
                echo "Error: Vite port $BUZZ_VITE_PORT is owned by PID $pid from another directory: ${process_cwd:-unknown}" >&2
                exit 1
            fi
            echo "Stopping stale Vite dev server (PID $pid)"
            reap_process "$pid"
        done < <(lsof -nP -t -iTCP:"$BUZZ_VITE_PORT" -sTCP:LISTEN 2>/dev/null | sort -u)
    fi
}

reap_stale_instance

if [[ "$(uname -s)" == "Darwin" ]]; then
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    target="$(rustc -vV | sed -n 's/^host: //p')"
    target_env="$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')"
    runner_var="CARGO_TARGET_${target_env}_RUNNER"
    export "$runner_var=$script_dir/run-tauri-dev.sh"
fi

exec pnpm exec tauri dev "$@"
