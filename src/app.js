// 查找与识别 Codex 桌面端应用（各显示模式共用）
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USER_APPS = path.join(os.homedir(), 'Applications');
// 本工具生成的 .app（启动器，以及旧版本的菜单栏程序）都带这个 bundle id 前缀
const GENERATED_ID_PREFIXES = ['local.chatgpt-usage-visualizer.', 'local.codex-usage-countdown.'];

export function isGeneratedApp(appPath) {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    return GENERATED_ID_PREFIXES.some((id) => plist.includes(id));
  } catch {
    return false;
  }
}

// 依次在常见目录和 Spotlight 中查找桌面端应用（跳过本工具生成的应用）
export function findApp(names) {
  const dirs = ['/Applications', USER_APPS];
  for (const n of names) {
    for (const d of dirs) {
      const p = path.join(d, `${n}.app`);
      if (fs.existsSync(p) && !isGeneratedApp(p)) return { name: n, path: p };
    }
  }
  for (const n of names) {
    try {
      const hit = execFileSync('/usr/bin/mdfind', [`kMDItemFSName == "${n}.app"`], { encoding: 'utf8' })
        .split('\n').filter(Boolean).find((p) => !isGeneratedApp(p));
      if (hit) return { name: n, path: hit };
    } catch {}
  }
  return null;
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isRunning(appPath) {
  // 从行首精确匹配，避免把 ~/Applications 下的同名启动器误认为原应用
  const r = spawnSync('/usr/bin/pgrep', ['-f', `^${reEscape(path.join(appPath, 'Contents', 'MacOS'))}/`]);
  return r.status === 0;
}

// Codex 主进程的 PID（最早启动的那个），找不到返回 null
export function mainPid(appPath) {
  const r = spawnSync('/usr/bin/pgrep', ['-o', '-f', `^${reEscape(path.join(appPath, 'Contents', 'MacOS'))}/`], { encoding: 'utf8' });
  const pid = Number(String(r.stdout || '').trim().split('\n')[0]);
  return r.status === 0 && pid ? pid : null;
}

export function bundleId(appPath) {
  try {
    return execFileSync('/usr/bin/defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
