#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
KEY_FILE="${CONTROL_PLANE_API_KEY_FILE:-}"
CONFIG_DIR="${CODEX_BEG_CONFIG_DIR:-$HOME/.config/codex-beg}"
TUNNEL_ID_FILE="$CONFIG_DIR/tunnel-id"
DEFAULT_KEY_FILE="$CONFIG_DIR/secrets/control-plane-api-key"
ALIAS="${TUNNEL_CLIENT_ALIAS:-codex-beg}"
MCP_SERVER_URL="${MCP_SERVER_URL:-http://127.0.0.1:43123/mcp}"
HEALTH_URL="${CODEX_BEG_HEALTH_URL:-http://127.0.0.1:43123/healthz}"
TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-tunnel-client}"
PROMPTED_TUNNEL_ID=0
IGNORED_INVALID_TUNNEL_ENV=0

usage() {
  cat <<'EOF'
Connect the local Codex BEG Agent Host to an existing OpenAI tunnel.

Usage:
  ./scripts/run-tunnel-client.sh [options]

Configuration (or interactive prompt):
  CONTROL_PLANE_TUNNEL_ID       tunnel_ followed by 32 lowercase hex characters
  CONTROL_PLANE_API_KEY_FILE    user-only file containing the Runtime API key

When run from a terminal, omitted values are prompted for interactively.
Saved values are loaded from ~/.config/codex-beg when present; create them with
./scripts/configure-codex-beg.sh.
Alternative for one terminal session or automation:
  export CONTROL_PLANE_API_KEY='...'

Options:
  --tunnel-id ID        Override CONTROL_PLANE_TUNNEL_ID.
  --api-key-file FILE  Override CONTROL_PLANE_API_KEY_FILE.
  --alias NAME         Runtime alias (default: codex-beg).
  --mcp-url URL        MCP URL (default: http://127.0.0.1:43123/mcp).
  --health-url URL     Codex BEG health URL.
  -h, --help           Show this help.
  --version            Show the script version.

The API key is never accepted as a command-line value. The script uses the
official managed `tunnel-client runtimes connect` flow and verifies status.
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

prompt_for_tunnel_id() {
  printf 'Tunnel ID: '
  IFS= read -r TUNNEL_ID || die "Tunnel ID input was interrupted"
  PROMPTED_TUNNEL_ID=1
}

load_persistent_config() {
  if [ -z "$TUNNEL_ID" ] && [ -f "$TUNNEL_ID_FILE" ]; then
    TUNNEL_ID="$(tr -d '\r\n' < "$TUNNEL_ID_FILE")"
  fi
  if [ -z "$KEY_FILE" ] && [ -f "$DEFAULT_KEY_FILE" ]; then
    KEY_FILE="$DEFAULT_KEY_FILE"
  fi
}

trap 'exit 130' INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tunnel-id)
      [ "$#" -ge 2 ] || die "--tunnel-id requires a value"
      TUNNEL_ID="$2"
      shift 2
      ;;
    --api-key-file)
      [ "$#" -ge 2 ] || die "--api-key-file requires a path"
      KEY_FILE="$2"
      shift 2
      ;;
    --alias)
      [ "$#" -ge 2 ] || die "--alias requires a value"
      ALIAS="$2"
      shift 2
      ;;
    --mcp-url)
      [ "$#" -ge 2 ] || die "--mcp-url requires a URL"
      MCP_SERVER_URL="$2"
      shift 2
      ;;
    --health-url)
      [ "$#" -ge 2 ] || die "--health-url requires a URL"
      HEALTH_URL="$2"
      shift 2
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

load_persistent_config

[ "$(uname -s)" = "Darwin" ] || die "This runtime script is for macOS only"
command -v curl >/dev/null 2>&1 || die "curl is required"
if [[ "$TUNNEL_CLIENT_BIN" == */* ]]; then
  [ -x "$TUNNEL_CLIENT_BIN" ] || die "tunnel-client executable is not runnable: $TUNNEL_CLIENT_BIN"
else
  command -v "$TUNNEL_CLIENT_BIN" >/dev/null 2>&1 || die "tunnel-client not found; run scripts/setup-tunnel-client.sh"
fi

if [ -z "$TUNNEL_ID" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    prompt_for_tunnel_id
  else
    die "Set CONTROL_PLANE_TUNNEL_ID or pass --tunnel-id"
  fi
fi

if ! is_valid_tunnel_id && [ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Warning: CONTROL_PLANE_TUNNEL_ID is invalid; please enter the tunnel ID again.\n' >&2
  IGNORED_INVALID_TUNNEL_ENV=1
  TUNNEL_ID=""
  load_persistent_config
fi

if ! is_valid_tunnel_id && [ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Warning: saved tunnel_id is missing or invalid; please enter the tunnel ID again.\n' >&2
  prompt_for_tunnel_id
fi

if ! is_valid_tunnel_id; then
  if [ "$PROMPTED_TUNNEL_ID" -eq 0 ] && [ "$IGNORED_INVALID_TUNNEL_ENV" -eq 0 ] && [ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ]; then
    die "Invalid tunnel ID from CONTROL_PLANE_TUNNEL_ID; unset it to be prompted, or pass --tunnel-id with tunnel_ followed by 32 lowercase hexadecimal characters"
  fi
  die "Invalid tunnel ID format; expected tunnel_ followed by 32 lowercase hexadecimal characters"
fi

if [ -n "$KEY_FILE" ]; then
  KEY_FILE_ERROR=""
  if [ ! -f "$KEY_FILE" ]; then
    KEY_FILE_ERROR="Runtime API key file not found: $KEY_FILE"
  elif [ ! -r "$KEY_FILE" ]; then
    KEY_FILE_ERROR="Runtime API key file is not readable: $KEY_FILE"
  elif [ ! -s "$KEY_FILE" ]; then
    KEY_FILE_ERROR="Runtime API key file is empty: $KEY_FILE"
  else
    KEY_MODE="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || true)"
    case "$KEY_MODE" in
      400|600) ;;
      *) KEY_FILE_ERROR="Runtime API key file must have mode 400 or 600; found ${KEY_MODE:-unknown}: $KEY_FILE" ;;
    esac
  fi

  if [ -n "$KEY_FILE_ERROR" ]; then
    if [ -t 0 ] && [ -t 1 ]; then
      printf 'Warning: %s; falling back to secure API key prompt.\n' "$KEY_FILE_ERROR" >&2
      KEY_FILE=""
    else
      die "$KEY_FILE_ERROR"
    fi
  fi
fi

if [ -n "$KEY_FILE" ]; then
  RUNTIME_API_KEY_REF="file:$KEY_FILE"
elif [ -n "${CONTROL_PLANE_API_KEY:-}" ]; then
  RUNTIME_API_KEY_REF="env:CONTROL_PLANE_API_KEY"
elif [ -t 0 ] && [ -t 1 ]; then
  printf 'Runtime API key (input hidden): '
  IFS= read -r -s CONTROL_PLANE_API_KEY || die "Runtime API key input was interrupted"
  printf '\n'
  export CONTROL_PLANE_API_KEY
  RUNTIME_API_KEY_REF="env:CONTROL_PLANE_API_KEY"
else
  die "Set CONTROL_PLANE_API_KEY_FILE or export CONTROL_PLANE_API_KEY"
fi

info "Checking Codex BEG at $HEALTH_URL"
curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null \
  || die "Codex BEG is not healthy; open the app first and run Doctor → Run checks"

info "Connecting alias '$ALIAS' to $TUNNEL_ID"
"$TUNNEL_CLIENT_BIN" runtimes connect \
  --alias "$ALIAS" \
  --tunnel-id "$TUNNEL_ID" \
  --runtime-api-key "$RUNTIME_API_KEY_REF" \
  --mcp-server-url "$MCP_SERVER_URL"

info "Verifying managed runtime status"
"$TUNNEL_CLIENT_BIN" runtimes status "$ALIAS" --json
info "If status reports process_running, healthy, and ready, open https://chatgpt.com/plugins, create a developer-mode app, choose Tunnel, and select or paste this tunnel_id"
