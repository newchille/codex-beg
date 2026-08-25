#!/bin/sh

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS tray icon generation requires Darwin" >&2
  exit 1
fi

command -v sips >/dev/null 2>&1 || { echo "sips is required" >&2; exit 1; }
command -v swift >/dev/null 2>&1 || { echo "swift is required" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$repo_root/apps/desktop/electron"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-beg-tray.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT INT TERM
swift -module-cache-path "$temp_dir/module-cache" "$repo_root/scripts/build-tray-icon.swift" "$output_dir"
sips -s dpiHeight 72 -s dpiWidth 72 "$output_dir/trayIconTemplate.png" >/dev/null
sips -s dpiHeight 144 -s dpiWidth 144 "$output_dir/trayIconTemplate@2x.png" >/dev/null
echo "Generated $output_dir/trayIconTemplate.png and $output_dir/trayIconTemplate@2x.png"
