#!/bin/sh

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS icon generation requires Darwin" >&2
  exit 1
fi

command -v qlmanage >/dev/null 2>&1 || { echo "qlmanage is required" >&2; exit 1; }
command -v sips >/dev/null 2>&1 || { echo "sips is required" >&2; exit 1; }
command -v iconutil >/dev/null 2>&1 || { echo "iconutil is required" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_svg="$repo_root/apps/desktop/renderer/src/app-icon.svg"
output_icns="$repo_root/apps/desktop/renderer/src/app-icon.icns"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-beg-icon.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT INT TERM

iconset="$temp_dir/app-icon.iconset"
mkdir -p "$iconset"

qlmanage -t -s 1024 -o "$temp_dir" "$source_svg" >/dev/null
rendered_png="$temp_dir/app-icon.svg.png"
[ -f "$rendered_png" ] || { echo "Quick Look did not render $source_svg" >&2; exit 1; }

for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  set -- $spec
  size=$1
  filename=$2
  sips -z "$size" "$size" "$rendered_png" --out "$iconset/$filename" >/dev/null
done

iconutil -c icns "$iconset" -o "$temp_dir/app-icon.icns"
mv "$temp_dir/app-icon.icns" "$output_icns"
echo "Generated $output_icns"
