#!/usr/bin/env bash
# 用独立配置启动 Brave 并加载 AutoBookmark 扩展（不影响主配置）
# 用法: scripts/brave.sh [URL...]
set -euo pipefail
cd "$(dirname "$0")/.."

BRAVE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
[ -x "$BRAVE" ] || { echo "未找到 Brave: $BRAVE"; exit 1; }
[ -d .output/chrome-mv3 ] || { echo "请先构建: pnpm build"; exit 1; }

exec "$BRAVE" \
  --user-data-dir="$HOME/.autobookmark-brave-profile" \
  --disable-extensions-except="$PWD/.output/chrome-mv3" \
  --load-extension="$PWD/.output/chrome-mv3" \
  --no-first-run --no-default-browser-check \
  "$@"
