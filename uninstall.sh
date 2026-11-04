#!/bin/bash
# 一键卸载：停止组件、还原程序坞、删除启动器（不会删除本文件夹）
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HOME" || exit 1
pkill -f "chatgpt-usage.js start" 2>/dev/null && echo "✓ 已停止正在运行的组件"
pkill -f "codex-usage.js start" 2>/dev/null
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
"$NODE" "$DIR/bin/chatgpt-usage.js" uninstall
rm -rf "$HOME/.chatgpt-usage-visualizer/run.pid"
echo "如需彻底删除，可再执行：rm -rf \"$DIR\" ~/.chatgpt-usage-visualizer"
