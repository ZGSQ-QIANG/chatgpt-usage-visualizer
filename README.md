# ChatGPT Usage Visualizer

ChatGPT / Codex 桌面端额度可视化工具：在 Codex 左侧栏"用量"按钮上方，常驻显示 **5 小时额度** 和 **每周额度** 的剩余比例与重置倒计时。点击组件可查看详情：剩余百分比、精确到秒的倒计时、重置时刻和同步状态。全自动同步，也可以随时手动刷新。

<p align="center"><a href="https://ZGSQ-QIANG.github.io/chatgpt-usage-visualizer/demo/"><img src="docs/styles.gif" width="260" alt="四种图标样式"></a></p>
<p align="center"><a href="https://ZGSQ-QIANG.github.io/chatgpt-usage-visualizer/demo/"><b>▶ 在线体验组件效果</b></a><br><sub>无需安装，可切换四种样式、模拟额度消耗与重置、切换深浅色</sub></p>

<img src="docs/preview-light.png" width="360"> <img src="docs/preview-dark.png" width="360">

> ⚠️ **非官方工具，与 OpenAI 无关。** 本工具通过 Chromium 调试端口向 Codex 界面注入组件，属于对官方客户端的非官方修改，可能违反 OpenAI 的使用条款，请自行评估风险；Codex 更新界面后组件可能暂时失效。

## 让 AI 帮你安装

把下面这段话发给你的 AI 编程助手（Codex、Claude Code 等能执行终端命令的助手），它会自动完成全部安装：

```
请帮我安装这个工具：https://github.com/ZGSQ-QIANG/chatgpt-usage-visualizer
按照仓库里 AGENTS.md 的步骤执行。
```

安装完成后，先确认任务已结束，再完全退出 Codex 并从程序坞的启动器打开；如果出现重启对话框，需要明确确认后才会退出原应用。

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

## 使用方式

**不想用启动器的话**，也可以每次手动运行 `node bin/chatgpt-usage.js start`，保持终端窗口开着，按 `Ctrl+C` 停止。

### 启动器的工作方式

- 点击启动器：以调试模式打开 Codex，并在后台运行组件，不需要开终端
- 退出 Codex：组件在几秒内自动停止
- 重复点击：不会启动多份，只会把 Codex 调到前台
- 如果点启动器时 Codex 已经以普通方式打开：始终弹窗说明重启会中断任务，默认选择“稍后手动重启”；检测到可能正在执行任务时，可以选择：
  - **任务完成后确认重启**：后台等待连续约 10 秒未检测到活动任务，再次请你确认；不会自行退出 Codex
  - **立即重启**：马上重启，当前任务会中断。对话框会显示判断依据，如果你确认没有任务在运行（例如只是刚结束一次对话），可以直接选这个
  - **稍后手动重启**：什么都不做，方便时退出 Codex 再从程序坞打开即可

  "正在执行任务"的判断方式：最近 30 秒内有会话记录写入，或 Codex 下有未知的活动命令。只排除可明确识别的 MCP 服务本身和应用内部进程；早期启动的构建、服务的工作子进程及未知常驻进程仍按忙碌处理。无法读取进程状态时也按忙碌处理。检测仍是启发式，重启前请确认任务确实已结束；旧的 `busy.commandGraceSec` 不再用于忽略任务。

组件依赖调试端口，而调试端口只能在 Codex 启动时开启，所以**必须从启动器打开**。启动器与原应用同名同图标，需要留意两点：Codex 运行时，程序坞里会同时出现两个相同的图标，固定的那个是启动器，带运行指示点的是 Codex 本身，这是正常的；用 Spotlight 或启动台搜索时会看到两个同名应用，位于 `~/Applications` 的是启动器，位于 `/Applications` 的是原应用。如果打开的是原应用、通过通知打开，或者 Codex 自动更新后自行重启，组件不会出现，退出 Codex 后再从程序坞打开即可。Codex 设置了开机自动打开的话，请到"系统设置 → 通用 → 登录项"里换成 `~/Applications` 下的启动器。

日志位于 `~/Library/Logs/chatgpt-usage-visualizer.log`。移动了工具文件夹或重装了 Node 后，需要重新运行 `install`；不再需要时运行 `node bin/chatgpt-usage.js uninstall`。

## 不同套餐

组件会按服务端实际返回的额度窗口来显示：同时有 5 小时和每周额度时显示两个；只有每周额度的套餐只显示每周一个；没有任何额度限制时显示"无限制"。

## 图标样式

侧栏图标有四种样式可选，只改变外观，数据和功能完全一样：

<img src="docs/styles.gif" width="240">

- **圆环**（默认）：圆环长度表示剩余比例
- **沙漏**：木质框架的玻璃沙漏，上半部分的蓝色沙子是剩余额度。细沙会持续从瓶颈落下，额度被消耗时沙流更明显，额度重置时沙漏翻转。沙漏是收腰的，所以沙子的高度按玻璃的实际形状换算，看到的沙量和剩余比例一致
- **咖啡**：咖啡液面是剩余额度，热气会飘起来，额度越少热气越少
- **电池**：电量是剩余额度，额度偏低时变橙、变红；距离重置 10 分钟内出现闪电并开始"充电"闪烁，重置时电量重新充满

切换方式：点开详情卡片，在"样式"一栏直接点选，立即生效并会被记住；也可以在 `~/.chatgpt-usage-visualizer/config.json` 中写入 `"style": "hourglass"`（可选 `ring`、`hourglass`、`coffee`、`battery`）作为默认样式。剩余额度低于 10% 时，沙漏的沙子会变成红色作为提醒。

## 时间显示方式

点开详情卡片，在"时间"一栏可以选择：

- **距重置**（默认）：显示倒计时，例如 `04:02:49`、`1天 04时`
- **截止时间**：显示具体的重置时刻，今天显示 `00:18`，之后显示 `明天 00:18`、`周五 00:27`；详情卡片里同时给出还剩多久

时间标签会配合样式：

| 样式 | 距重置 | 截止时间 |
|---|---|---|
| 圆环 | 距重置 | 重置时间 |
| 沙漏 | 距翻转 | 翻转时间 |
| 咖啡 | 距续杯 | 续杯时间 |
| 电池 | 距充满 | 充满时间 |

选择会被记住；也可以在配置文件中写入 `"timeDisplay": "deadline"` 作为默认（可选 `countdown`、`deadline`）。

## 自动同步机制

数据来自 Codex 自带的 `codex app-server`（`account/rateLimits/read` 接口）。工具会优先使用 Codex 桌面端安装包里自带的 codex 程序，不需要另外安装 Codex CLI；登录由 Codex 自己处理，本工具不读取、不保存任何凭证。以下时机会自动更新：

- 启动时立即读取一次
- 定时轮询：Codex 窗口在前台时每 60 秒，后台时每 5 分钟
- 你在 Codex 中对话产生新记录时（监听 `~/.codex/sessions`，最多 15 秒一次）
- 任一额度倒计时归零后 3 秒，确认服务端已重置
- app-server 主动推送的额度变化

找不到可用的 codex 程序时，会退回读取本地会话记录中的最后一次额度快照（在本机读取最近最多 5 个候选文件、每个最多 512 KiB 的日志尾部，再提取额度字段；读入的字节可能包含对话，但不会另行保存或上传原始对话）。这种模式下数据只在你对话时更新，闲置一段时间后会提示"数据可能已过期"，倒计时归零后会显示"重置中…"直到下次对话。

同步失败时按 30 秒、1 分钟、2 分钟……逐步拉长重试；超过 10 分钟没有新数据，圆环变灰并提示数据可能已过期。

## 自定义配置

在 `~/.chatgpt-usage-visualizer/config.json` 中写入需要覆盖的字段即可，其余沿用 `config/default.json`：

```json
{
  "appNames": ["ChatGPT", "Codex"],
  "pollFocusedSec": 60,
  "pollBackgroundSec": 300,
  "thresholds": { "warnRemainingPercent": 25, "dangerRemainingPercent": 10 },
  "busy": { "recentWriteSec": 30, "pollSec": 5 },
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
node bin/chatgpt-usage.js uninstall   删除启动器，还原程序坞
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
- 本工具不向作者服务器上传数据，不收集统计信息，不直接读取登录凭证；官方 `codex app-server` 仍可能连接官方服务获取额度。备用模式会在本机读取会话日志尾部，详见“自动同步机制”。
- 清理旧版本前会核验应用的准确 bundle ID 和启动项的 Label；不匹配、无法读取或经过符号链接的对象会保留。启动器名称不能包含路径分隔符。
- 调试发现请求拒绝 HTTP 重定向；组件只连接配置端口上的字面量回环 WebSocket 地址。此校验不能阻止本机其他程序使用已开启的调试端口。
- 组件运行在独立的 Shadow DOM 中，不修改 Codex 的样式和安装包。

## 开发

```bash
npm test                                   # 单元测试（含模拟 app-server）
node bin/chatgpt-usage.js start --debug    # 输出详细日志
```

目录结构：`bin/` 命令行入口，`src/widget.js` 注入界面的组件，`src/sync.js` 自动同步，`src/appServer.js` app-server 客户端，`src/sessions.js` 会话记录读取，`src/cdp.js` 调试协议，`src/launcher.js` 启动器与程序坞，`src/busy.js` 任务检测，`src/commands.js` 各命令的实现，`config/default.json` 默认配置。

欢迎提交 Issue 和 Pull Request，尤其是 Codex 更新后的选择器适配。

## 许可证

[MIT](LICENSE)
