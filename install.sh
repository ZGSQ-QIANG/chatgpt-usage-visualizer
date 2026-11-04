#!/bin/bash
# 一键安装：检查环境 → 创建启动器 → 替换程序坞图标 →（可选）重启 Codex
# 用法：./install.sh [--relaunch] [--no-dock] [--app 应用名]
# 退出码：0 成功；2 缺少或 Node 版本过低；3 非 macOS；1 其他错误
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HOME" || exit 1

if [ "$(uname)" != "Darwin" ]; then
  echo "✗ 仅支持 macOS"; echo "INSTALL_RESULT=unsupported_os"; exit 3
fi

NODE="$(command -v node || true)"
for c in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"
done
if [ -z "$NODE" ]; then
  echo "✗ 没有找到 Node.js，需要 22 或更高版本"; echo "INSTALL_RESULT=need_node"; exit 2
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then
  echo "✗ Node.js 版本为 $("$NODE" -v)，需要 22 或更高"; echo "INSTALL_RESULT=need_node"; exit 2
fi
echo "✓ Node.js $("$NODE" -v)：$NODE"

case "$DIR" in
  "$HOME/Downloads"*|"$HOME/Desktop"*|"$HOME/Documents"*)
    echo "! 工具位于 $DIR，macOS 隐私权限可能阻止启动器访问。建议放在 ~/chatgpt-usage-visualizer" ;;
esac

DOCK="--dock"; ARGS=()
for a in "$@"; do
  case "$a" in
    --no-dock) DOCK="" ;;
    *) ARGS+=("$a") ;;
  esac
done

# 停掉旧版本（含旧项目名 codex-usage-countdown）正在运行的组件
pkill -f "chatgpt-usage.js start" 2>/dev/null
pkill -f "codex-usage.js start" 2>/dev/null

echo "--- 环境检查 ---"
"$NODE" "$DIR/bin/chatgpt-usage.js" doctor "${ARGS[@]+"${ARGS[@]}"}" || true
echo "--- 安装 ---"
"$NODE" "$DIR/bin/chatgpt-usage.js" install --no-reveal $DOCK "${ARGS[@]+"${ARGS[@]}"}"
