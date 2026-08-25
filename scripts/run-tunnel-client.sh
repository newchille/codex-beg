#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
KEY_FILE="${CONTROL_PLANE_API_KEY_FILE:-}"
ALIAS="${TUNNEL_CLIENT_ALIAS:-codex-beg}"
MCP_SERVER_URL="${MCP_SERVER_URL:-http://127.0.0.1:43123/mcp}"
HEALTH_URL="${CODEX_BEG_HEALTH_URL:-http://127.0.0.1:43123/healthz}"
TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-tunnel-client}"

usage() {
  cat <<'EOF'
Connect the local Codex BEG Agent Host to an existing OpenAI tunnel.

Usage:
  ./scripts/run-tunnel-client.sh [options]

Required configuration:
  CONTROL_PLANE_TUNNEL_ID       tunnel_ followed by 32 lowercase hex characters
  CONTROL_PLANE_API_KEY_FILE    user-only file containing the Runtime API key

Alternative for one terminal session:
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

[ "$(uname -s)" = "Darwin" ] || die "This runtime script is for macOS only"
command -v curl >/dev/null 2>&1 || die "curl is required"
if [[ "$TUNNEL_CLIENT_BIN" == */* ]]; then
  [ -x "$TUNNEL_CLIENT_BIN" ] || die "tunnel-client executable is not runnable: $TUNNEL_CLIENT_BIN"
else
  command -v "$TUNNEL_CLIENT_BIN" >/dev/null 2>&1 || die "tunnel-client not found; run scripts/setup-tunnel-client.sh"
fi
[ -n "$TUNNEL_ID" ] || die "Set CONTROL_PLANE_TUNNEL_ID or pass --tunnel-id"

if ! printf '%s\n' "$TUNNEL_ID" | LC_ALL=C grep -Eq '^tunnel_[0-9a-f]{32}$'; then
  die "Invalid tunnel ID format; expected tunnel_ followed by 32 lowercase hexadecimal characters"
fi

if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "Runtime API key file not found: $KEY_FILE"
  [ -r "$KEY_FILE" ] || die "Runtime API key file is not readable: $KEY_FILE"
  [ -s "$KEY_FILE" ] || die "Runtime API key file is empty: $KEY_FILE"
  KEY_MODE="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || true)"
  case "$KEY_MODE" in
    400|600) ;;
    *) die "Runtime API key file must have mode 400 or 600; found ${KEY_MODE:-unknown}: $KEY_FILE" ;;
  esac
  RUNTIME_API_KEY_REF="file:$KEY_FILE"
elif [ -n "${CONTROL_PLANE_API_KEY:-}" ]; then
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
info "If status reports process_running, healthy, and ready, select this same tunnel_id in ChatGPT Connector"
