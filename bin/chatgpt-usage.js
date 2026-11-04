#!/usr/bin/env node
// 命令入口：只负责分发，具体实现在 src/
import { cmd, flag, buildConfig } from '../src/cli.js';
import { USER_CONFIG_PATH } from '../src/config.js';
import { findApp } from '../src/app.js';
import { findCodexBin, AppServerClient } from '../src/appServer.js';
import { readLatestFromSessions } from '../src/sessions.js';
import { toDisplayWindows } from '../src/normalize.js';
import { cleanupLegacyMenubar } from '../src/legacy.js';

const sidebar = () => import('../src/commands.js');

function describe(snap) {
  return toDisplayWindows(snap).map((w) => `${w.label} 剩余 ${Math.round(100 - w.usedPercent)}%`).join('，') || '无窗口数据';
}

async function install() {
  const cfg = buildConfig();
  const app = findApp(cfg.appNames);
  if (!app) throw new Error(`找不到 Codex 应用（尝试过：${cfg.appNames.join('、')}），可用 --app 指定。`);
  if (cleanupLegacyMenubar()) console.log('✓ 已移除旧版本的菜单栏程序');
  const sb = await sidebar();
  const reveal = await sb.installSidebar(sb.sidebarConfig(), app);
  console.log(`NEEDS_RELAUNCH=${flag('relaunch') ? 'no' : 'yes'}`);
  console.log('INSTALL_RESULT=ok');
  if (reveal && !flag('no-reveal')) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('/usr/bin/open', ['-R', reveal]);
  }
}

async function uninstall() {
  const cfg = buildConfig();
  const sb = await sidebar();
  if (sb.removeSidebar(cfg)) console.log('✓ 已删除启动器并还原程序坞');
  if (cleanupLegacyMenubar()) console.log('✓ 已移除旧版本的菜单栏程序');
  console.log('UNINSTALL_RESULT=ok');
}

async function doctor() {
  const cfg = buildConfig();
  const ok = (b, m) => console.log(`${b ? '✓' : '✗'} ${m}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 22, `Node.js ${process.versions.node}（需要 22 或更高）`);
  ok(process.platform === 'darwin', `系统：${process.platform}（目前仅支持 macOS）`);
  const app = findApp(cfg.appNames);
  ok(!!app, app ? `应用：${app.path}` : `找不到应用（尝试过：${cfg.appNames.join('、')}）。--app 填桌面端应用的名字，可用 ls /Applications 查看`);
  const bin = findCodexBin(cfg, app && app.path);
  ok(!!bin, bin ? `codex 可执行文件：${bin}` : '找不到 codex 可执行文件（将退回使用会话记录）');
  if (bin) {
    const c = new AppServerClient(bin, { debug: flag('debug') });
    try {
      await c.start();
      ok(true, `app-server 额度读取成功：${describe(await c.readRateLimits())}`);
    } catch (e) {
      ok(false, `app-server 额度读取失败：${e.message}`);
    } finally {
      c.stop();
    }
  }
  const fb = readLatestFromSessions(cfg.sessionsDir);
  ok(!!fb, fb ? `会话记录备用数据：${describe(fb.snapshot)}` : `会话记录中没有找到额度数据（${cfg.sessionsDir}）`);
  await (await sidebar()).doctorSidebar(ok);
  console.log(`\n自定义配置文件位置：${USER_CONFIG_PATH}`);
}

async function help() {
  console.log(`chatgpt-usage —— 在 Codex 侧栏显示额度与重置倒计时（非官方工具）

用法：
  chatgpt-usage install    创建启动器（与原应用同名）：和 Codex 一起启动、一起退出
                             --dock 替换程序坞原图标  --relaunch 15 秒后重启 Codex
                             --launcher-name 启动器名称  --no-reveal 不在访达中显示
  chatgpt-usage uninstall  删除启动器，还原程序坞
  chatgpt-usage doctor     检查运行环境与数据源
  chatgpt-usage start      手动运行组件（终端前台）
  chatgpt-usage relaunch   15 秒后通过启动器重启 Codex（--delay 秒数）

选项：
  --app <名称>          指定应用名，例如 --app Codex
  --port <端口>         调试端口，默认 9222
  --codex-bin <路径>    指定 codex 可执行文件
  --yes                 需要重启 Codex 时不再询问
  --debug               输出详细日志`);
}

const commands = {
  install,
  uninstall,
  doctor,
  help,
  start: async () => (await sidebar()).start(),
  relaunch: async () => (await sidebar()).relaunch(),
};

(commands[cmd] || help)().catch((e) => {
  console.error(`错误：${e.message}`);
  process.exit(1);
});
