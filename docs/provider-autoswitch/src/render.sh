#!/bin/bash
# Renders every mockup state in light and dark to ../<state>-<theme>.png.
# Needs work-kit.css beside mockups.html: copy apps/web/dist/assets/main-*.css from an atum-work build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell 2>/dev/null | tail -1)}"
[ -f "$here/work-kit.css" ] || { echo "work-kit.css missing beside mockups.html" >&2; exit 1; }
for state in a-off a-on b-override c-switched c-none-left d-continue e-back; do
  for theme in light dark; do
    "$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=1180,760 --allow-file-access-from-files \
      --screenshot="$here/../$state-$theme.png" "file://$here/mockups.html#$state-$theme" >/dev/null 2>&1
  done
done
ls "$here/.."/*.png
