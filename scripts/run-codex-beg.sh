#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="${CODEX_BEG_HEALTH_URL:-http://127.0.0.1:43123/healthz}"
OPEN_APP=1

usage() {
  cat <<'EOF'
Run an already-installed Codex BEG app and connect its tunnel.

Usage:
  ./scripts/run-codex-beg.sh [options from run-tunnel-client.sh]

Options:
  --no-open            Do not launch Codex BEG; require it to already be running.
  -h, --help           Show this help.
  --version            Show the script version.

This script never installs Homebrew, Node.js, pnpm, Codex BEG, or
tunnel-client. Run ./scripts/bootstrap-macos.sh for installation/update.
Other options are passed to run-tunnel-client.sh, including --tunnel-id,
--api-key-file, --alias, --mcp-url, and --health-url.
EOF
}

info() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

sanitize_tunnel_id_environment() {
  if [ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ] \
    && ! printf '%s\n' "$CONTROL_PLANE_TUNNEL_ID" | LC_ALL=C grep -Eq '^tunnel_[0-9a-f]{32}$'; then
    printf 'Warning: ignoring invalid CONTROL_PLANE_TUNNEL_ID; the launcher will ask for tunnel_id.\n' >&2
    unset CONTROL_PLANE_TUNNEL_ID
  fi
}

trap 'exit 130' INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-open)
      OPEN_APP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --version)
      printf '%s\n' "$SCRIPT_VERSION"
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "This run script is for macOS only"
command -v curl >/dev/null 2>&1 || die "curl is required"
sanitize_tunnel_id_environment

if [ "$OPEN_APP" -eq 1 ]; then
  command -v open >/dev/null 2>&1 || die "macOS open command is required"
  info "Opening Codex BEG"
  open -a "Codex BEG" >/dev/null 2>&1 \
    || die "Codex BEG is not installed; run ./scripts/bootstrap-macos.sh"

  info "Waiting for Codex BEG Agent Host"
  ATTEMPT=1
  while [ "$ATTEMPT" -le 30 ]; do
    if curl --fail --silent --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      break
    fi
    if [ "$ATTEMPT" -eq 30 ]; then
      die "Codex BEG did not become healthy; run Doctor → Run checks"
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
fi

"$SCRIPT_DIR/run-tunnel-client.sh" "$@"
