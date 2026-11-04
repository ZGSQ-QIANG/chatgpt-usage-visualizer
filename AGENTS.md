# 给 AI 助手的安装说明

当用户把本仓库地址交给你并要求安装时，按以下步骤操作。整个过程不需要 sudo，不要修改 ChatGPT.app / Codex.app 本身，不要读取或输出 `~/.codex/auth.json` 等凭证文件。

## 目标

在用户的 macOS 上安装 Codex 侧栏额度组件：在 `~/Applications` 下生成一个与原应用同名同图标的启动器、替换程序坞中的原图标，之后用户照常从程序坞打开 Codex，左侧栏用量按钮上方就会显示额度组件。

## 步骤

### 1. 确认系统
运行 `uname`，结果必须是 `Darwin`。否则告诉用户本工具仅支持 macOS，停止。

### 2. 获取代码（固定放在 `~/chatgpt-usage-visualizer`）
```bash
cd ~
if [ -d ~/chatgpt-usage-visualizer/.git ]; then git -C ~/chatgpt-usage-visualizer pull --ff-only; else git clone https://github.com/ZGSQ-QIANG/chatgpt-usage-visualizer.git ~/chatgpt-usage-visualizer; fi
```
不要放在"下载"、"桌面"、"文稿"文件夹，macOS 隐私权限可能导致启动器无法运行。没有 git 时，可下载仓库 ZIP 解压到 `~/chatgpt-usage-visualizer`。

### 3. 确认 Node.js 22+
运行 `node -v`。若缺失或低于 v22：
- 有 Homebrew（`command -v brew` 有输出）时，运行 `brew install node`
- 没有 Homebrew 时，请用户到 https://nodejs.org 下载安装 LTS 版本，装好后继续

### 4. 运行安装脚本
```bash
~/chatgpt-usage-visualizer/install.sh
```
检查输出最后一行：
- `INSTALL_RESULT=ok`：成功，继续第 5 步
- `INSTALL_RESULT=need_node`：回到第 3 步
- `INSTALL_RESULT=unsupported_os`：停止
- 其他错误：参考下方"常见问题"

环境检查（doctor）中"app-server 额度读取"为 ✗ 不影响安装，组件会退回使用本地会话记录。程序坞默认会被修改（原图标替换为启动器，已自动备份，可用 `uninstall.sh` 还原）；用户不希望修改程序坞时加 `--no-dock`。如果显示"找不到应用"，用 `ls /Applications | grep -i -E "codex|chatgpt"` 找到应用名，再加 `--app 应用名` 重新运行。

### 5. 重启 Codex 使组件生效
重启会退出 Codex，正在 Codex 中运行的任务和对话会中断。**如果你本身运行在 Codex / ChatGPT 桌面端里，这一步会结束你自己的会话**，所以必须先向用户完成汇报，再把这条命令作为最后一个动作执行：

先告诉用户："安装完成，Codex 将在 15 秒后自动重启（可能会弹窗确认，如果没有任务在运行，点'立即重启'即可），重启后左侧栏用量按钮上方会出现额度组件。以后照常从程序坞点图标打开即可；Spotlight 里会看到两个同名应用，请选 ~/Applications 下的那个。"然后执行：
```bash
node ~/chatgpt-usage-visualizer/bin/chatgpt-usage.js relaunch
```

如果你不是运行在 Codex 里，执行后可以等待 30 秒验证：
```bash
tail -n 20 ~/Library/Logs/chatgpt-usage-visualizer.log
```
出现"已注入窗口"和"组件已运行"即成功。

## 常见问题

| 现象 | 处理 |
|---|---|
| `EPERM: process.cwd failed` | 先 `cd ~` 再重试 |
| doctor 中 codex 程序报 `ENOENT` | npm 版 Codex CLI 损坏，工具会自动改用桌面端内置程序，可忽略 |
| 程序坞修改失败 | 不影响使用，告诉用户手动把 `~/Applications` 下的启动器拖到程序坞 |
| 日志提示"找不到挂载点" | Codex 界面已更新，告诉用户需要等待本项目更新选择器 |
| 日志提示调试端口没有打开 | 该版本 Codex 可能禁用了调试端口，本工具无法使用 |

## 卸载
```bash
~/chatgpt-usage-visualizer/uninstall.sh
```
会停止组件、还原程序坞、删除启动器。
