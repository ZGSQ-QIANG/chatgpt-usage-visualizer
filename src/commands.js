// 命令实现：start、relaunch、安装与卸载启动器、环境检查（通过调试端口把额度组件注入 Codex 左侧栏）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { flag, opt, log, sleep, buildConfig } from './cli.js';
import { USER_CONFIG_PATH } from './config.js';
import { findApp, isRunning } from './app.js';
import { findCodexBin } from './appServer.js';
import { UsageSync } from './sync.js';
import { Injector, isPortOpen, listTargets, pickMainTargets } from './cdp.js';
import { launchWithPort, quitApp, installLauncherApp, uninstallLauncherApp, findInstalledLaunchers, LAUNCHER_LOG, dockInstall, dockRestore, relaunchLater } from './launcher.js';
import { codexBusy, askDialog, notify } from './busy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = path.join(here, '..', 'bin', 'chatgpt-usage.js');
export const sidebarConfig = () => buildConfig();

function widgetSource(cfg) {
  const injectCfg = { mount: cfg.mount, thresholds: cfg.thresholds, staleAfterSec: cfg.staleAfterSec, style: cfg.style, timeDisplay: cfg.timeDisplay };
  const src = fs.readFileSync(path.join(here, 'widget.js'), 'utf8');
  return `window.__codexUsageConfig = ${JSON.stringify(injectCfg)};\n${src}`;
}

async function confirm(q) {
  if (flag('yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} (y/N) `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

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
      const choice = askDialog({
        title: TITLE,
        message: `显示额度组件需要重启 ${app.name}，这会中断正在运行的任务。\n\n${b.busy ? `检测到可能仍有任务（${b.reason}）。` : '暂未检测到任务，但启发式检测不能保证空闲。'}请确认所有任务已结束后再重启。`,
        buttons: b.busy ? ['稍后手动重启', '立即重启', '任务完成后确认重启'] : ['稍后手动重启', '立即重启'],
        defaultButton: '稍后手动重启',
        cancelButton: '稍后手动重启',
      });
      log(`用户选择：${choice || '关闭对话框'}`);
      if (choice === '任务完成后确认重启') {
        notify(TITLE, `正在等待 ${app.name} 的任务结束，之后将请你确认重启`);
        const r = await waitUntilIdle(app, cfg);
        if (r === 'quit') { log(`${app.name} 已被退出，停止等待`); return CANCELLED; }
        const ready = askDialog({
          title: TITLE,
          message: `暂未检测到活动任务。请确认 ${app.name} 中的任务已结束；重启仍会中断新开始的任务。`,
          buttons: ['稍后手动重启', '立即重启'],
          defaultButton: '稍后手动重启',
          cancelButton: '稍后手动重启',
        });
        if (ready !== '立即重启') return CANCELLED;
      } else if (choice !== '立即重启') {
        spawnSync('/usr/bin/open', ['-a', app.path]);
        return CANCELLED;
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

export async function start() {
  const cfg = sidebarConfig();
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
    onRefresh: () => { log('手动刷新'); sync.refresh('手动刷新'); },
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

export async function installSidebar(cfg, app) {
  const launcher = installLauncherApp({
    app,
    name: opt('launcher-name') || cfg.launcherName,
    nodePath: process.execPath,
    toolPath: TOOL_PATH,
    extraArgs: [opt('app') ? ['--app', opt('app')] : [], opt('port') ? ['--port', opt('port')] : []].flat(),
  });
  const dest = launcher.path;
  console.log(`✓ 侧栏组件：已创建启动器"${launcher.name}"：${dest}`);

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
    console.log(`· 侧栏组件需要退出 ${app.name} 后从程序坞的启动器重新打开才会出现`);
  }
  console.log(`  日志：${LAUNCHER_LOG}`);
  return dest;
}

export function removeSidebar(cfg) {
  const launchers = findInstalledLaunchers();
  if (!launchers.length) return false;
  try { dockRestore(findApp(cfg.appNames), launchers); } catch {}
  uninstallLauncherApp();
  return true;
}

export async function relaunch() {
  const sec = Number(opt('delay') || 15);
  const [launcher] = findInstalledLaunchers();
  if (!launcher) throw new Error('没有找到启动器，请先运行 install');
  relaunchLater(launcher, sec);
  console.log(`✓ 将在 ${sec} 秒后通过启动器重新打开 Codex（如正在运行会先退出）`);
  console.log('RELAUNCH_RESULT=scheduled');
}


// 侧栏模式相关的环境检查
export async function doctorSidebar(ok) {
  const cfg = sidebarConfig();
  const port = await isPortOpen(cfg.debugPort);
  ok(port, `侧栏模式：调试端口 ${cfg.debugPort}${port ? ' 已开启' : ' 未开启（从启动器打开 Codex 时会自动开启）'}`);
  if (port) {
    const targets = pickMainTargets(await listTargets(cfg.debugPort), cfg.targetFilter);
    ok(targets.length > 0, `侧栏模式：Codex 主窗口 ${targets.length} 个`);
  }
  const launchers = findInstalledLaunchers();
  ok(true, launchers.length ? `侧栏模式：已安装启动器 ${launchers.join('、')}` : '侧栏模式：未安装');
}
