#!/bin/bash
# Launch Chromium with the showcase extension and DevTools auto-opened on a local page.
#   CHROME_BIN=/path/to/chrome ./launch-chrome.sh [port=9252] [page=http://127.0.0.1:9253/]
# CHROME_BIN defaults to the newest Playwright Chromium, then chromium / google-chrome on PATH.
# Uses a throwaway profile (the extension is a demo; see extensions/showcase/README.md).
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$(cd "$HERE/../../../extensions/showcase" && pwd)"
PORT="${1:-9252}"
PAGE="${2:-http://127.0.0.1:9253/}"
BIN="${CHROME_BIN:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | sort | tail -1)}"
BIN="${BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}"
[ -x "$BIN" ] || { echo "set CHROME_BIN to a Chromium binary" >&2; exit 1; }
PROFILE="$(mktemp -d)"
exec xvfb-run -a -s "-screen 0 1500x950x24" "$BIN" --no-sandbox --user-data-dir="$PROFILE" \
  --load-extension="$EXT" --disable-extensions-except="$EXT" --auto-open-devtools-for-tabs \
  --remote-debugging-port="$PORT" --window-size=1400,900 --no-first-run --no-default-browser-check "$PAGE"
