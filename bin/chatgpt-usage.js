#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, USER_CONFIG_PATH } from '../src/config.js';
import { Injector, isPortOpen, listTargets, pickMainTargets } from '../src/cdp.js';
import { findApp, isRunning, launchWithPort, quitApp, installLauncherApp, uninstallLauncherApp, findInstalledLaunchers, LAUNCHER_LOG, dockInstall, dockRestore, relaunchLater } from '../src/launcher.js';
import { findCodexBin, AppServerClient } from '../src/appServer.js';
import { readLatestFromSessions } from '../src/sessions.js';
import { toDisplayWindows } from '../src/normalize.js';
import { UsageSync } from '../src/sync.js';
import { codexBusy, askDialog, notify } from '../src/busy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'help';
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (m) => console.log(`[${ts()}] ${m}`);

function buildConfig() {
  const o = {};
  if (opt('port')) o.debugPort = Number(opt('port'));
  if (opt('app')) o.appNames = [opt('app')];
  if (opt('codex-bin')) o.codexBin = opt('codex-bin');
  return loadConfig(o);
}

function widgetSource(cfg) {
  const injectCfg = { mount: cfg.mount, thresholds: cfg.thresholds, staleAfterSec: cfg.staleAfterSec };
  const src = fs.readFileSync(path.join(here, '..', 'src', 'widget.js'), 'utf8');
  return `window.__codexUsageConfig = ${JSON.stringify(injectCfg)};\n${src}`;
}

async function confirm(q) {
  if (flag('yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} (y/N) `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = 'Codex 额度组件';

// 等待任务结束：连续两次检测为空闲才算结束；返回 'idle' 或 'quit'（用户自己退出了 Codex）
async function waitUntilIdle(app, cfg) {
  const pollMs = (cfg.busy?.pollSec ?? 5) * 1000;
  let idleCount = 0, lastReason = '';
  while (true) {
    await sleep(pollMs);
    if (!isRunning(app.path)) return 'quit';
    const b = codexBusy(app, cfg);
    if (b.busy) {
      idleCount = 0;
      if (b.reason !== lastReason) { log(`等待任务结束：${b.reason}`); lastReason = b.reason; }
    } else if (++idleCount >= 2) return 'idle';
  }
}

const CANCELLED = Symbol('cancelled');

// 返回 app（端口已开启时可能为 null）；返回 CANCELLED 表示用户选择暂不重启
async function ensureDebugApp(cfg, { withApp = false } = {}) {
  const app = findApp(cfg.appNames);
  // 调试端口已开启时可以直接使用，不强制要求找到应用
  if (await isPortOpen(cfg.debugPort)) return app;
  if (!app) throw new Error(`找不到 Codex 应用（尝试过：${cfg.appNames.join('、')}）。可用 --app "应用名" 指定。`);
  if (isRunning(app.path)) {
    const b = codexBusy(app, cfg);
    if (withApp) {
      if (b.busy) {
        log(`${app.name} 正以普通方式运行，且可能正在执行任务（${b.reason}）`);
        const choice = askDialog({
          title: TITLE,
          message: `检测到 ${app.name} 可能正在执行任务（判断依据：${b.reason}）。\n\n显示额度组件需要重启 ${app.name}，现在重启会中断当前任务。\n\n如果你确认当前没有任务在运行（例如只是刚结束一次对话或安装），可以直接点击"立即重启"。\n\n选择"任务完成后自动重启"，会在任务结束后自动重启；选择"稍后手动重启"，可以在方便时退出 ${app.name}，再从程序坞重新打开。`,
          buttons: ['稍后手动重启', '立即重启', '任务完成后自动重启'],
          defaultButton: '任务完成后自动重启',
          cancelButton: '稍后手动重启',
        });
        log(`用户选择：${choice || '关闭对话框'}`);
        if (choice === '任务完成后自动重启') {
          notify(TITLE, `将在 ${app.name} 的任务完成后自动重启`);
          const r = await waitUntilIdle(app, cfg);
          if (r === 'quit') { log(`${app.name} 已被退出，停止等待`); return CANCELLED; }
          notify(TITLE, `任务已完成，正在重启 ${app.name}`);
        } else if (choice !== '立即重启') {
          spawnSync('/usr/bin/open', ['-a', app.path]);
          return CANCELLED;
        }
      }
    } else {
      const warn = b.busy ? `检测到它可能正在执行任务（${b.reason}），` : '';
      const ok = await confirm(`需要重启 ${app.name} 以开启调试端口，${warn}正在运行的任务会被中断。现在重启？`);
      if (!ok) throw new Error('已取消。也可以先手动退出 Codex 再运行本命令。');
    }
    log(`正在退出 ${app.name}…`);
    if (!(await quitApp(app))) throw new Error(`${app.name} 未能在 20 秒内退出，请手动退出后重试。`);
  }
  log(`正在以调试模式启动 ${app.name}…`);
  if (!(await launchWithPort(app, cfg.debugPort))) {
    throw new Error(`调试端口 ${cfg.debugPort} 没有打开。这个版本的 Codex 可能禁用了调试端口。`);
  }
  return app;
}

async function start() {
  const cfg = buildConfig();
  const withApp = flag('with-app');
  let locked = acquireLock();
  if (!locked && withApp) {
    // 另一个实例可能正在随 Codex 退出，稍等它释放
    const a = findApp(cfg.appNames);
    if (a && !isRunning(a.path)) {
      for (let i = 0; i < 16 && !locked; i++) { await sleep(500); locked = acquireLock(); }
    }
  }
  if (!locked) {
    // 已有实例在运行（或正在等待任务结束）：只需把 Codex 调到前台
    const a = findApp(cfg.appNames);
    if (withApp && a) spawnSync('/usr/bin/open', ['-a', a.path]);
    log('组件已在运行，无需重复启动。');
    return;
  }
  let app;
  try {
    app = await ensureDebugApp(cfg, { withApp });
  } catch (e) {
    releaseLock();
    throw e;
  }
  if (app === CANCELLED) {
    releaseLock();
    log('暂不重启，组件未启动。');
    return;
  }
  const codexBin = findCodexBin(cfg, app && app.path);
  if (!codexBin) log('没有找到 codex 可执行文件，将只使用会话记录作为数据源（数据可能不是最新）。');

  let injector;
  const sync = new UsageSync({
    cfg,
    codexBin,
    log,
    debug: flag('debug'),
    isFocused: () => (injector ? injector.anyFocused() : Promise.resolve(true)),
  });
  injector = new Injector({
    port: cfg.debugPort,
    filter: cfg.targetFilter,
    widgetSource: widgetSource(cfg),
    getPayload: () => sync.payload(),
    log,
  });
  sync.on('change', () => injector.pushAll());

  await sync.start();

  let waitingLogged = false, anchorWarned = false, ticks = 0, closedChecks = 0, iv = null;
  const shutdown = async (reason) => {
    clearInterval(iv);
    sync.stop();
    await injector.removeAll();
    releaseLock();
    log(reason || '已停止并移除组件。');
    process.exit(0);
  };
  const loop = async () => {
    const portOpen = await isPortOpen(cfg.debugPort);
    // 随 Codex 一起退出：连续两次检测到调试端口关闭就停止。
    // 不再要求"应用已不在运行"：否则 Codex 退出后很快又被以普通方式打开时，
    // 本进程会一直占着运行锁，之后点启动器只会提示"组件已在运行"而没有任何效果
    if (withApp && !portOpen) {
      if (++closedChecks >= 2) {
        const reopened = app && isRunning(app.path);
        return shutdown(reopened ? 'Codex 已退出并以普通方式重新打开，组件停止；请从程序坞重新打开以显示组件。' : 'Codex 已退出，组件随之停止。');
      }
      return;
    }
    closedChecks = 0;
    if (portOpen) {
      if (waitingLogged) { log('检测到 Codex 已以调试模式运行'); waitingLogged = false; }
      await injector.scan();
      if (++ticks % 6 === 0) {
        const st = await injector.status();
        const lost = st.length > 0 && st.every((s) => s && !s.anchorFound && !s.mounted);
        if (lost && !anchorWarned) {
          log(`找不到挂载点，Codex 界面可能已更新。请检查 ${USER_CONFIG_PATH} 中的 mount.anchorSelectors。`);
          anchorWarned = true;
        } else if (!lost) anchorWarned = false;
      }
    } else if (!waitingLogged) {
      log('Codex 未以调试模式运行（可能已退出）。请运行 chatgpt-usage start 重新启动，或保持本窗口等待。');
      waitingLogged = true;
    }
  };
  await loop();
  iv = setInterval(loop, withApp ? 3000 : 5000);
  log(withApp ? '组件已运行，将随 Codex 一起退出。' : '组件已运行，按 Ctrl+C 停止并移除组件。');
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
}

async function doctor() {
  const cfg = buildConfig();
  const ok = (b, m) => console.log(`${b ? '✓' : '✗'} ${m}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 22, `Node.js ${process.versions.node}（需要 22 或更高）`);
  ok(process.platform === 'darwin', `系统：${process.platform}（目前仅支持 macOS）`);
  const app = findApp(cfg.appNames);
  ok(!!app, app ? `应用：${app.path}` : `找不到应用（尝试过：${cfg.appNames.join('、')}）。--app 填桌面端应用的名字，可用 ls /Applications 查看`);
  const port = await isPortOpen(cfg.debugPort);
  ok(port, `调试端口 ${cfg.debugPort}${port ? ' 已开启' : ' 未开启（运行 chatgpt-usage start 会自动处理）'}`);
  if (port) {
    const targets = pickMainTargets(await listTargets(cfg.debugPort), cfg.targetFilter);
    ok(targets.length > 0, `主窗口：${targets.length} 个`);
  }
  const bin = findCodexBin(cfg, app && app.path);
  ok(!!bin, bin ? `codex 可执行文件：${bin}` : '找不到 codex 可执行文件（将退回使用会话记录）');
  if (bin) {
    const c = new AppServerClient(bin, { debug: flag('debug') });
    try {
      await c.start();
      const snap = await c.readRateLimits();
      ok(true, `app-server 额度读取成功：${describe(snap)}`);
    } catch (e) {
      ok(false, `app-server 额度读取失败：${e.message}`);
    } finally {
      c.stop();
    }
  }
  const fb = readLatestFromSessions(cfg.sessionsDir);
  ok(!!fb, fb ? `会话记录备用数据：${describe(fb.snapshot)}` : `会话记录中没有找到额度数据（${cfg.sessionsDir}）`);
  console.log(`\n自定义配置文件位置：${USER_CONFIG_PATH}`);
}

const LOCK = path.join(os.homedir(), '.chatgpt-usage-visualizer', 'run.pid');
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (pid && pid !== process.pid) { process.kill(pid, 0); return false; }
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
function releaseLock() {
  try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch {}
}

async function install() {
  const cfg = buildConfig();
  const app = findApp(cfg.appNames);
  if (!app) throw new Error(`找不到 Codex 应用（尝试过：${cfg.appNames.join('、')}），可用 --app 指定。`);
  const launcher = installLauncherApp({
    app,
    name: opt('launcher-name') || cfg.launcherName,
    nodePath: process.execPath,
    toolPath: path.join(here, 'chatgpt-usage.js'),
    extraArgs: [opt('app') ? ['--app', opt('app')] : [], opt('port') ? ['--port', opt('port')] : []].flat(),
  });
  const dest = launcher.path;
  console.log(`✓ 已创建启动器"${launcher.name}"：${dest}`);

  if (flag('dock')) {
    try {
      const r = dockInstall(app.path, dest, launcher.removed);
      console.log({
        replaced: `✓ 程序坞：已把原图标替换为启动器（显示名称仍为"${launcher.name}"）`,
        added: `✓ 程序坞：已添加启动器"${launcher.name}"`,
        exists: '✓ 程序坞：启动器已在程序坞中',
      }[r]);
    } catch (e) {
      console.log(`✗ 程序坞修改失败（${e.message}），请手动把启动器拖到程序坞`);
    }
  } else {
    console.log('· 未修改程序坞（加 --dock 可自动替换原图标）');
  }

  if (flag('relaunch')) {
    relaunchLater(dest, Number(opt('relaunch-delay') || 15));
    console.log(`✓ 将在 ${opt('relaunch-delay') || 15} 秒后通过启动器重新打开 ${app.name}（如正在运行会先退出）`);
  } else {
    console.log(`· 请退出 ${app.name}，之后从程序坞的启动器打开（位于 ${dest}）`);
  }
  console.log(`日志：${LAUNCHER_LOG}`);
  console.log('INSTALL_RESULT=ok');
  if (!flag('no-reveal')) spawnSync('/usr/bin/open', ['-R', dest]);
}

async function uninstall() {
  const cfg = buildConfig();
  const launchers = findInstalledLaunchers();
  try {
    if (dockRestore(findApp(cfg.appNames), launchers) === 'restored') console.log('✓ 程序坞：已还原原来的图标');
  } catch {}
  const removed = uninstallLauncherApp();
  console.log(removed.length ? `✓ 已删除启动器：${removed.join('、')}` : '· 没有找到已安装的启动器');
  console.log('UNINSTALL_RESULT=ok');
}

function describe(snap) {
  return toDisplayWindows(snap)
    .map((w) => `${w.label} 剩余 ${Math.round(100 - w.usedPercent)}%`)
    .join('，') || '无窗口数据';
}

async function help() {
  console.log(`chatgpt-usage —— 在 Codex 侧边栏显示额度倒计时（非官方工具）

用法：
  chatgpt-usage start     以调试模式启动 Codex（如需会询问重启），注入组件并自动同步
  chatgpt-usage doctor    检查运行环境、调试端口、数据源和挂载点
  chatgpt-usage install   创建启动器（默认与原应用同名）：和 Codex 一起启动、一起退出
                        --launcher-name 自定义启动器名称
                        --dock 同时把程序坞里的原图标替换为启动器
                        --relaunch 15 秒后通过启动器重新打开 Codex
                        --no-reveal 不在访达中显示启动器
  chatgpt-usage uninstall 删除启动器并还原程序坞
  chatgpt-usage relaunch  延迟 15 秒后通过启动器重新打开 Codex（--delay 秒数）

选项：
  --app <名称>          指定应用名，例如 --app Codex
  --port <端口>         调试端口，默认 9222
  --codex-bin <路径>    指定 codex 可执行文件
  --yes                 需要重启 Codex 时不再询问
  --debug               输出详细日志`);
}

async function relaunch() {
  const sec = Number(opt('delay') || 15);
  const [launcher] = findInstalledLaunchers();
  if (!launcher) throw new Error('没有找到启动器，请先运行 install');
  relaunchLater(launcher, sec);
  console.log(`✓ 将在 ${sec} 秒后通过启动器重新打开 Codex（如正在运行会先退出）`);
  console.log('RELAUNCH_RESULT=scheduled');
}

const run = { start, doctor, install, uninstall, relaunch, help }[cmd] || help;
run().catch((e) => {
  console.error(`错误：${e.message}`);
  process.exit(1);
});
