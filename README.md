# ChatGPT Usage Visualizer

ChatGPT / Codex 桌面端额度可视化工具。

在 Codex 桌面端左侧栏、系统"用量"按钮上方，常驻显示 **5 小时额度** 和 **每周额度** 的剩余比例与重置倒计时。点击组件可查看详情：剩余百分比、精确到秒的倒计时、重置时刻和同步状态。额度全自动同步，无需手动刷新。

<img src="docs/preview-light.png" width="360"> <img src="docs/preview-dark.png" width="360">

> ⚠️ **非官方工具，与 OpenAI 无关。** 本工具通过 Chromium 调试端口向 Codex 界面注入组件，属于对官方客户端的非官方修改，可能违反 OpenAI 的使用条款，请自行评估风险。Codex 更新界面后组件可能暂时失效，需要更新配置或等待本项目更新。

## 让 AI 帮你安装

把下面这段话发给你的 AI 编程助手（Codex、Claude Code 等能执行终端命令的助手），它会自动完成全部安装：

```
请帮我安装这个工具：https://github.com/ZGSQ-QIANG/chatgpt-usage-visualizer
按照仓库里 AGENTS.md 的步骤执行。
```

安装完成后 Codex 会自动重启一次，之后照常从程序坞点 Codex 图标打开即可（图标已被替换为启动器）。

## 运行要求

- macOS
- Node.js 22 或更高版本（终端运行 `node -v` 查看，没有的话到 [nodejs.org](https://nodejs.org) 安装）
- Codex 桌面端（ChatGPT.app 或 Codex.app）

## 快速开始

**1. 下载**

在本页面点击绿色的 Code 按钮 → Download ZIP，或者用 git：

```bash
cd ~
git clone https://github.com/ZGSQ-QIANG/chatgpt-usage-visualizer.git
cd ~/chatgpt-usage-visualizer
```

如果下载的是 ZIP，请解压到用户主目录（例如 `~/chatgpt-usage-visualizer`），不要放在"下载"文件夹里运行，避免 macOS 权限问题。之后也不要再移动这个文件夹。

**2. 检查环境**

```bash
node bin/chatgpt-usage.js doctor
```

每一项前面显示 ✓ 或 ✗。"app-server 额度读取"为 ✗ 也能用，只是会退回读取本地会话记录（见下文）。

**3. 一键安装**

```bash
./install.sh
```

会在 `~/Applications` 下生成一个与原应用同名、同图标的启动器（例如 `~/Applications/ChatGPT.app`），并把程序坞里原来的图标替换成它（原设置已备份，卸载时会还原；不想改程序坞可加 `--no-dock`）。完全退出 Codex 后，照常从程序坞点图标打开即可。想换启动器名称可加 `--launcher-name 名称`。卸载运行 `./uninstall.sh`。

**不想用启动器的话**，也可以每次手动运行 `node bin/chatgpt-usage.js start`，保持终端窗口开着，按 `Ctrl+C` 停止。

## 启动器的工作方式

- 点击启动器：以调试模式打开 Codex，并在后台运行组件，不需要开终端
- 退出 Codex：组件在几秒内自动停止
- 重复点击：不会启动多份，只会把 Codex 调到前台
- 如果点启动器时 Codex 已经以普通方式打开：没有在执行任务就直接重启一次以开启调试端口；检测到可能正在执行任务时，会弹窗提醒重启会中断任务，并让你选择：
  - **任务完成后自动重启**：后台等待任务结束（连续约 10 秒检测为空闲），通知后自动重启
  - **立即重启**：马上重启，当前任务会中断。对话框会显示判断依据，如果你确认没有任务在运行（例如只是刚结束一次对话），可以直接选这个
  - **稍后手动重启**：什么都不做，方便时退出 Codex 再从程序坞打开即可

  "正在执行任务"的判断方式：最近 30 秒内有会话记录写入，或 Codex 下有它启动的命令仍在运行（如构建、测试；随 Codex 一起启动的常驻服务不算）。这是启发式判断，个别情况可能误判，可在配置的 `busy` 中调整。

组件依赖调试端口，而调试端口只能在 Codex 启动时开启，所以**必须从启动器打开**。启动器与原应用同名同图标，需要留意两点：Codex 运行时，程序坞里会同时出现两个相同的图标，固定的那个是启动器，带运行指示点的是 Codex 本身，这是正常的；用 Spotlight 或启动台搜索时会看到两个同名应用，位于 `~/Applications` 的是启动器，位于 `/Applications` 的是原应用。如果打开的是原应用、通过通知打开，或者 Codex 自动更新后自行重启，组件不会出现，退出 Codex 后再从程序坞打开即可。Codex 设置了开机自动打开的话，请到"系统设置 → 通用 → 登录项"里换成 `~/Applications` 下的启动器。

日志位于 `~/Library/Logs/chatgpt-usage-visualizer.log`。移动了工具文件夹或重装了 Node 后，需要重新运行 `install`；不再需要时运行 `node bin/chatgpt-usage.js uninstall`。

## 自动同步机制

数据来自 Codex 自带的 `codex app-server`（`account/rateLimits/read` 接口）。工具会优先使用 Codex 桌面端安装包里自带的 codex 程序，不需要另外安装 Codex CLI；登录由 Codex 自己处理，本工具不读取、不保存任何凭证。以下时机会自动更新：

- 启动时立即读取一次
- 定时轮询：Codex 窗口在前台时每 60 秒，后台时每 5 分钟
- 你在 Codex 中对话产生新记录时（监听 `~/.codex/sessions`，最多 15 秒一次）
- 任一额度倒计时归零后 3 秒，确认服务端已重置
- app-server 主动推送的额度变化

找不到可用的 codex 程序时，会退回读取本地会话记录中的最后一次额度快照（只解析额度记录，不读取对话内容）。这种模式下数据只在你对话时更新，闲置一段时间后会提示"数据可能已过期"，倒计时归零后会显示"重置中…"直到下次对话。

同步失败时按 30 秒、1 分钟、2 分钟……逐步拉长重试；超过 10 分钟没有新数据，圆环变灰并提示数据可能已过期。

## 自定义配置

在 `~/.chatgpt-usage-visualizer/config.json` 中写入需要覆盖的字段即可，其余沿用 `config/default.json`：

```json
{
  "appNames": ["ChatGPT", "Codex"],
  "pollFocusedSec": 60,
  "pollBackgroundSec": 300,
  "thresholds": { "warnRemainingPercent": 25, "dangerRemainingPercent": 10 },
  "busy": { "recentWriteSec": 30, "commandGraceSec": 120, "pollSec": 5 },
  "mount": {
    "anchorSelectors": ["button[aria-label=\"用量\"]", "button[aria-label=\"Usage\"]"],
    "levelsUp": 1,
    "position": "before"
  }
}
```

剩余比例低于 `warnRemainingPercent` 时变为琥珀色，低于 `dangerRemainingPercent` 时变为红色。

## 命令一览

```
node bin/chatgpt-usage.js doctor      检查运行环境、调试端口、数据源
node bin/chatgpt-usage.js install     创建启动器（--dock 替换程序坞图标，--launcher-name 自定义名称）
node bin/chatgpt-usage.js uninstall   删除启动器并还原程序坞
node bin/chatgpt-usage.js relaunch    15 秒后通过启动器重新打开 Codex
node bin/chatgpt-usage.js start       手动启动（终端前台运行）

选项：--app <应用名>  --launcher-name <名称>  --port <端口>  --codex-bin <路径>  --yes  --debug
```

## 常见问题

**组件没有出现。** 先确认是从程序坞的启动器（`~/Applications` 下）打开的 Codex，再查看日志 `~/Library/Logs/chatgpt-usage-visualizer.log`。

**日志提示"找不到挂载点"。** Codex 更新后界面结构变了。组件以系统"用量"按钮为锚点，通常只需更新 `mount.anchorSelectors`：用 Chrome 打开 `chrome://inspect/#devices`，Configure 中添加 `localhost:9222`，在地址为 `app://-/index.html` 的项下点 inspect，用元素选择器点一下用量按钮，查看它的 `aria-label` 等稳定属性，写进配置后重新打开。请避免使用 `Button-q1uiwE` 这类带随机后缀的类名，它们每次发版都会变。

**运行时报 `EPERM: process.cwd failed`。** 终端所在的目录已被删除或没有访问权限。先执行 `cd ~`，再进入工具目录重试；如果工具放在"下载"文件夹，建议移到用户主目录。

**doctor 显示 codex 程序报 `ENOENT`。** 你用 npm 安装的 Codex CLI 不完整，工具会自动跳过它、改用桌面端内置的程序。想修复 CLI 可以运行 `npm install -g @openai/codex`。

**`--app` 应该填什么？** 填 Codex 桌面应用的名字，可以用 `ls /Applications | grep -i -E "codex|chatgpt"` 查看，例如 `--app ChatGPT`。

## 安全说明

- 调试端口只监听本机（127.0.0.1），但在 Codex 以调试模式运行期间，本机的其他程序也能连接并控制 Codex 窗口。请只在信任的电脑上使用。
- 本工具不联网上传任何数据，不收集统计信息，不读取登录凭证。
- 组件运行在独立的 Shadow DOM 中，不修改 Codex 的样式和安装包。

## 开发

```bash
npm test                                   # 单元测试（含模拟 app-server）
node bin/chatgpt-usage.js start --debug      # 输出详细日志
```

目录结构：`bin/` 命令行入口，`src/widget.js` 注入界面的组件，`src/sync.js` 自动同步，`src/appServer.js` app-server 客户端，`src/cdp.js` 调试协议，`src/launcher.js` 应用启动与启动器生成，`config/default.json` 默认配置。

欢迎提交 Issue 和 Pull Request，尤其是 Codex 更新后的选择器适配。

## 许可证

[MIT](LICENSE)
