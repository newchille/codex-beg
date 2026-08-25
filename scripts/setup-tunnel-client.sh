#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
INSTALL_PLUGIN=0

usage() {
  cat <<'EOF'
Install the official OpenAI tunnel-client on macOS.

Usage:
  ./scripts/setup-tunnel-client.sh [--with-codex-plugin]

Options:
  --with-codex-plugin  Also install the official Tunnel MCP plugin for Codex.
  -h, --help           Show this help.
  --version            Show the script version.

This script never asks for or stores a tunnel ID or API key.
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
    --with-codex-plugin)
      INSTALL_PLUGIN=1
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

[ "$(uname -s)" = "Darwin" ] || die "This setup script is for macOS only"
command -v brew >/dev/null 2>&1 || die "Homebrew is required; install it from https://brew.sh first"

if ! command -v tunnel-client >/dev/null 2>&1; then
  info "Installing official tunnel-client"
  brew install openai/tools/tunnel-client
else
  info "Using existing tunnel-client: $(command -v tunnel-client)"
fi

command -v tunnel-client >/dev/null 2>&1 || die "tunnel-client was not found after Homebrew installation"
info "tunnel-client version: $(tunnel-client --version 2>/dev/null || printf 'version unavailable')"

if [ "$INSTALL_PLUGIN" -eq 1 ]; then
  info "Installing the official Tunnel MCP plugin for Codex"
  tunnel-client codex plugin install
  tunnel-client codex status
fi

info "No credentials were requested or stored"
info "Next: open Codex BEG and run scripts/run-codex-beg.sh; it will prompt for tunnel_id and the Runtime API key"
