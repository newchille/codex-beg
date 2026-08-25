#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
CONFIG_DIR="${CODEX_BEG_CONFIG_DIR:-$HOME/.config/codex-beg}"
TUNNEL_ID_FILE="$CONFIG_DIR/tunnel-id"
KEY_DIR="$CONFIG_DIR/secrets"
KEY_FILE="$KEY_DIR/control-plane-api-key"
FORCE=0

usage() {
  cat <<'EOF'
Save Codex BEG tunnel credentials for future runs.

Usage:
  ./scripts/configure-codex-beg.sh [--force]

Options:
  --force       Replace the saved tunnel_id and Runtime API key.
  -h, --help    Show this help.
  --version     Show the script version.

The tunnel_id is saved at ~/.config/codex-beg/tunnel-id.
The Runtime API key is saved at ~/.config/codex-beg/secrets/control-plane-api-key
with mode 600. The API key is never accepted as a command-line value.
EOF
}

info() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

is_valid_tunnel_id() {
  printf '%s\n' "$TUNNEL_ID" | LC_ALL=C grep -Eq '^tunnel_[0-9a-f]{32}$'
}

trap 'exit 130' INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
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
    *)
      die "Unknown option: $1 (use --help)"
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "This configuration script is for macOS only"
[ -t 0 ] && [ -t 1 ] || die "Run this script from an interactive terminal"

if [ "$FORCE" -eq 0 ] && [ -f "$TUNNEL_ID_FILE" ] && [ -f "$KEY_FILE" ]; then
  TUNNEL_ID="$(tr -d '\r\n' < "$TUNNEL_ID_FILE")"
  KEY_MODE="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || true)"
  if is_valid_tunnel_id && [ "$KEY_MODE" = "600" ] && [ -s "$KEY_FILE" ]; then
    info "Saved tunnel configuration already exists"
    info "No credentials were changed; use --force to replace them"
    exit 0
  fi
fi

printf 'Tunnel ID: '
IFS= read -r TUNNEL_ID || die "Tunnel ID input was interrupted"
is_valid_tunnel_id || die "Invalid tunnel ID; expected tunnel_ followed by 32 lowercase hexadecimal characters"

printf 'Runtime API key (input hidden): '
IFS= read -r -s CONTROL_PLANE_API_KEY || die "Runtime API key input was interrupted"
printf '\n'
[ -n "$CONTROL_PLANE_API_KEY" ] || die "Runtime API key cannot be empty"

install -d -m 700 "$CONFIG_DIR" "$KEY_DIR"
umask 077
printf '%s' "$TUNNEL_ID" > "$TUNNEL_ID_FILE"
printf '%s' "$CONTROL_PLANE_API_KEY" > "$KEY_FILE"
unset CONTROL_PLANE_API_KEY
chmod 600 "$TUNNEL_ID_FILE" "$KEY_FILE"

info "Saved tunnel_id: $TUNNEL_ID_FILE"
info "Saved Runtime API key: $KEY_FILE (mode 600)"
info "Next: run ./scripts/run-codex-beg.sh"
