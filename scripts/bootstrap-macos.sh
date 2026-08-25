#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${CODEX_BEG_INSTALL_DIR:-$HOME/Applications}"
INSTALL_PLUGIN=0
SKIP_CONNECT=0
BREW_BIN=""
HOMEBREW_INSTALLER=""

usage() {
  cat <<'EOF'
Complete Codex BEG setup for a clean macOS Apple Silicon machine.

Usage:
  ./scripts/bootstrap-macos.sh [options]

Options:
  --with-codex-plugin  Also install the optional official Tunnel MCP plugin.
  --install-dir DIR    Install the app into DIR (default: ~/Applications).
  --skip-connect       Install everything but do not ask for tunnel credentials.
  -h, --help           Show this help.
  --version            Show the script version.

The default flow installs Homebrew when needed, installs Node.js and pnpm,
builds and launches Codex BEG, installs the official tunnel-client, then
prompts for tunnel_id and a Runtime API key without echoing the key.
The app is freshly built from the current checkout every time; any existing
installed app is deleted before replacement and no backup is kept.
The ChatGPT MCP app/plugin is created separately in the ChatGPT web UI.
EOF
}

info() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$HOMEBREW_INSTALLER" ] && [ -f "$HOMEBREW_INSTALLER" ]; then
    rm -f "$HOMEBREW_INSTALLER"
  fi
}

trap cleanup EXIT
trap 'exit 130' INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-codex-plugin)
      INSTALL_PLUGIN=1
      shift
      ;;
    --replace)
      # Kept for backwards compatibility; replacement is now always enabled.
      shift
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a directory"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --skip-connect)
      SKIP_CONNECT=1
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

[ "$(uname -s)" = "Darwin" ] || die "This bootstrap script is for macOS only"
[ "$(uname -m)" = "arm64" ] || die "This bootstrap script is for Apple Silicon Macs only"
[ -f "$REPO_ROOT/pnpm-lock.yaml" ] || die "Run this script from a Codex BEG repository checkout"

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
  elif [ -x /opt/homebrew/bin/brew ]; then
    BREW_BIN="/opt/homebrew/bin/brew"
  elif [ -x /usr/local/bin/brew ]; then
    BREW_BIN="/usr/local/bin/brew"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to install Homebrew"
    HOMEBREW_INSTALLER="$(mktemp "${TMPDIR:-/tmp}/codex-beg-homebrew.XXXXXX")"
    info "Homebrew not found; downloading the official installer"
    curl --fail --silent --show-error --location \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
      --output "$HOMEBREW_INSTALLER"
    /bin/bash "$HOMEBREW_INSTALLER"

    if [ -x /opt/homebrew/bin/brew ]; then
      BREW_BIN="/opt/homebrew/bin/brew"
    elif [ -x /usr/local/bin/brew ]; then
      BREW_BIN="/usr/local/bin/brew"
    else
      die "Homebrew installation finished but brew was not found"
    fi
  fi

  eval "$($BREW_BIN shellenv)"
  command -v brew >/dev/null 2>&1 || die "brew is not available after Homebrew setup"
  info "Using Homebrew: $(command -v brew)"
}

ensure_homebrew

BUILD_ARGS=(--install-deps --install-dir "$INSTALL_DIR" --launch)

info "Building and installing Codex BEG"
"$SCRIPT_DIR/build-install-macos.sh" "${BUILD_ARGS[@]}"

info "Installing the official tunnel-client"
if [ "$INSTALL_PLUGIN" -eq 1 ]; then
  "$SCRIPT_DIR/setup-tunnel-client.sh" --with-codex-plugin
else
  "$SCRIPT_DIR/setup-tunnel-client.sh"
fi

if [ "$SKIP_CONNECT" -eq 1 ]; then
  info "Installation complete; skipped tunnel connection"
  info "Later run: ./scripts/run-codex-beg.sh"
else
  info "Saving tunnel credentials for future runs"
  "$SCRIPT_DIR/configure-codex-beg.sh"
  info "Connecting Codex BEG to the tunnel"
  "$SCRIPT_DIR/run-codex-beg.sh"
fi

info "For later runs without installation: ./scripts/run-codex-beg.sh"
info "Next: open https://chatgpt.com/plugins, create a developer-mode app, choose Tunnel, and select or paste the same tunnel_id"
