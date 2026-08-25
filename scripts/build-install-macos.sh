#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_VERSION="0.1.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${CODEX_BEG_INSTALL_DIR:-$HOME/Applications}"
INSTALL_DEPS=0
LAUNCH=0
STAGING_PARENT=""
BUILD_OUTPUT_DIR="$REPO_ROOT/apps/desktop/release/mac-arm64"

usage() {
  cat <<'EOF'
Codex BEG source build and user-level install for macOS Apple Silicon.

Usage:
  ./scripts/build-install-macos.sh [options]

Options:
  --install-deps       Install missing Node.js/pnpm with Homebrew.
  --install-dir DIR   Install into DIR (default: ~/Applications).
  --replace            Deprecated compatibility flag; replacement is always enabled.
  --launch             Open Codex BEG after installation.
  -h, --help           Show this help.
  --version            Show the script version.

The script always builds a fresh arm64 app from the current checkout, deletes
the previous build output and installed app, then installs the new app without
requiring sudo. No backup is kept.
EOF
}

info() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$STAGING_PARENT" ] && [ -d "$STAGING_PARENT" ]; then
    rm -rf "$STAGING_PARENT"
  fi
}

trap cleanup EXIT
trap 'exit 130' INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-deps)
      INSTALL_DEPS=1
      shift
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a directory"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --replace)
      # Kept for backwards compatibility; replacement is always enabled.
      shift
      ;;
    --launch)
      LAUNCH=1
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

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS only"
[ "$(uname -m)" = "arm64" ] || die "This build is arm64-only; run it on an Apple Silicon Mac"
[ -f "$REPO_ROOT/pnpm-lock.yaml" ] || die "Run this script from a Codex BEG repository checkout"

if [ "$INSTALL_DEPS" -eq 1 ]; then
  command -v brew >/dev/null 2>&1 || die "Homebrew is required for --install-deps; install it from https://brew.sh first"
  if ! command -v node >/dev/null 2>&1; then
    info "Installing Node.js with Homebrew"
    brew install node
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    info "Installing pnpm with Homebrew"
    brew install pnpm
  fi
fi

command -v node >/dev/null 2>&1 || die "Node.js is missing; install Node.js 22+ or rerun with --install-deps"
command -v pnpm >/dev/null 2>&1 || die "pnpm is missing; install pnpm or rerun with --install-deps"
command -v ditto >/dev/null 2>&1 || die "macOS ditto is missing"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required; found $(node --version)"

cd "$REPO_ROOT"
info "Installing locked dependencies"
pnpm install --frozen-lockfile
if [ -e "$BUILD_OUTPUT_DIR" ]; then
  info "Removing previous arm64 build output"
  rm -rf -- "$BUILD_OUTPUT_DIR"
fi
info "Building a fresh Codex BEG app from the current checkout"
pnpm package

APP_SOURCE="$REPO_ROOT/apps/desktop/release/mac-arm64/Codex BEG.app"
[ -d "$APP_SOURCE" ] || die "Build completed without producing $APP_SOURCE"

mkdir -p "$INSTALL_DIR"
APP_DEST="$INSTALL_DIR/Codex BEG.app"

STAGING_PARENT="$(mktemp -d "$INSTALL_DIR/.codex-beg-install.XXXXXX")"
info "Copying app to $APP_DEST"
ditto "$APP_SOURCE" "$STAGING_PARENT/Codex BEG.app"

if [ -e "$APP_DEST" ]; then
  info "Removing existing app: $APP_DEST"
  rm -rf -- "$APP_DEST"
fi
mv "$STAGING_PARENT/Codex BEG.app" "$APP_DEST"

info "Installed: $APP_DEST"
info "Open Doctor → Run checks after launching the app"
if [ "$LAUNCH" -eq 1 ]; then
  open "$APP_DEST"
fi
