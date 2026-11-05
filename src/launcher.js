import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPortOpen } from './cdp.js';
import { isRunning, bundleId } from './app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const LAUNCHER_ID = 'local.chatgpt-usage-visualizer.launcher';
const LEGACY_LAUNCHER_IDS = ['local.codex-usage-countdown.launcher']; // 旧项目名生成的启动器
const LAUNCHER_DIR = path.join(os.homedir(), 'Applications');

// 判断某个 .app 是否是本工具生成的启动器（启动器可能与原应用同名）
export function isOurLauncher(appPath) {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    return [LAUNCHER_ID, ...LEGACY_LAUNCHER_IDS].some((id) => plist.includes(id));
  } catch {
    return false;
  }
}

export function findInstalledLaunchers() {
  let entries = [];
  try { entries = fs.readdirSync(LAUNCHER_DIR); } catch { return []; }
  return entries.filter((e) => e.endsWith('.app')).map((e) => path.join(LAUNCHER_DIR, e)).filter(isOurLauncher);
}

export async function quitApp(app, timeoutMs = 20000) {
  // 按 bundle id 退出，避免同名启动器造成歧义
  const id = bundleId(app.path);
  spawnSync('/usr/bin/osascript', ['-e', id ? `quit app id "${id}"` : `quit app "${app.name}"`]);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!isRunning(app.path)) return true;
    await sleep(500);
  }
  return false;
}

export async function launchWithPort(app, port, timeoutMs = 30000) {
  spawnSync('/usr/bin/open', ['-a', app.path, '--args', `--remote-debugging-port=${port}`]);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await sleep(500);
  }
  return false;
}

// ---------- 启动器：一个不显示程序坞图标的小 .app，负责以调试模式打开 Codex 并运行组件 ----------
export const LAUNCHER_LOG = path.join(os.homedir(), 'Library', 'Logs', 'chatgpt-usage-visualizer.log');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 返回 { path, removed }：removed 为被替换掉的旧启动器路径（用于更新程序坞）
export function installLauncherApp({ app, name, nodePath, toolPath, extraArgs = [] }) {
  const launcherName = name || app.name;
  const LAUNCHER_PATH = path.join(LAUNCHER_DIR, `${launcherName}.app`);
  if (path.resolve(LAUNCHER_PATH) === path.resolve(app.path)) {
    throw new Error(`${app.path} 是原应用本身，请用 --launcher-name 换一个启动器名称`);
  }
  if (fs.existsSync(LAUNCHER_PATH) && !isOurLauncher(LAUNCHER_PATH)) {
    throw new Error(`${LAUNCHER_PATH} 已存在且不是本工具生成的，请用 --launcher-name 换一个名称`);
  }
  const removed = findInstalledLaunchers();
  for (const old of removed) fs.rmSync(old, { recursive: true, force: true });
  const contents = path.join(LAUNCHER_PATH, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.mkdirSync(path.dirname(LAUNCHER_LOG), { recursive: true });

  // 沿用 Codex 的图标
  let hasIcon = false;
  try {
    let icon = execFileSync('/usr/bin/defaults', ['read', path.join(app.path, 'Contents', 'Info'), 'CFBundleIconFile'], { encoding: 'utf8' }).trim();
    if (icon && !icon.endsWith('.icns')) icon += '.icns';
    const src = path.join(app.path, 'Contents', 'Resources', icon);
    if (icon && fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(contents, 'Resources', 'AppIcon.icns'));
      hasIcon = true;
    }
  } catch {}

  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>${LAUNCHER_ID}</string>
  <key>CFBundleName</key><string>${xmlEsc(launcherName)}</string>
  <key>CFBundleDisplayName</key><string>${xmlEsc(launcherName)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.6.0</string>
  <key>LSUIElement</key><true/>
  ${hasIcon ? '<key>CFBundleIconFile</key><string>AppIcon</string>' : ''}
</dict></plist>
`);

  const args = ['start', '--yes', '--with-app', ...extraArgs].map(shq).join(' ');
  const script = path.join(contents, 'MacOS', 'launcher');
  fs.writeFileSync(script, `#!/bin/bash
# 由 chatgpt-usage install 生成
if [ ! -x ${shq(nodePath)} ] || [ ! -f ${shq(toolPath)} ]; then
  osascript -e 'display alert "额度组件启动器已失效" message "找不到 Node 或工具文件，请重新运行 chatgpt-usage install。"'
  open -a ${shq(app.path)}
  exit 1
fi
# 在后台运行组件后立即退出。启动器进程若一直存活，macOS 会认为应用已打开，
# 再次点击程序坞图标时会报"应用程序已不能再打开"
/usr/bin/nohup ${shq(nodePath)} ${shq(toolPath)} ${args} >> ${shq(LAUNCHER_LOG)} 2>&1 < /dev/null &
disown
exit 0
`);
  fs.chmodSync(script, 0o755);
  spawnSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', LAUNCHER_PATH]);
  return { path: LAUNCHER_PATH, name: launcherName, removed: removed.filter((p) => p !== LAUNCHER_PATH) };
}

export function uninstallLauncherApp() {
  const found = findInstalledLaunchers();
  for (const p of found) fs.rmSync(p, { recursive: true, force: true });
  return found;
}

// ---------- 程序坞：把原 Codex 图标替换为启动器（可还原） ----------
const PB = '/usr/libexec/PlistBuddy';
const DOCK_BACKUP = path.join(os.homedir(), '.chatgpt-usage-visualizer', 'dock-backup.plist');
const pb = (file, cmd) => execFileSync(PB, ['-c', cmd, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryPb = (file, cmd) => { try { return pb(file, cmd); } catch { return null; } };
const urlToPath = (u) => decodeURIComponent(String(u).replace(/^file:\/\//, '')).replace(/\/$/, '');

function readDockTiles(tmp) {
  const tiles = [];
  for (let i = 0; ; i++) {
    if (tryPb(tmp, `Print :persistent-apps:${i}:tile-type`) === null && tryPb(tmp, `Print :persistent-apps:${i}`) === null) break;
    const url = tryPb(tmp, `Print :persistent-apps:${i}:tile-data:file-data:_CFURLString`);
    tiles.push({ index: i, path: url ? urlToPath(url) : null });
  }
  return tiles;
}

function retarget(tmp, i, targetPath) {
  const base = `:persistent-apps:${i}:tile-data`;
  pb(tmp, `Set ${base}:file-data:_CFURLString ${pathToFileURL(targetPath).href}/`);
  tryPb(tmp, `Delete ${base}:book`);
  tryPb(tmp, `Delete ${base}:bundle-identifier`);
  tryPb(tmp, `Delete ${base}:file-label`); // 让程序坞按应用本身的名字显示
}

function editDock(fn) {
  const tmp = path.join(os.tmpdir(), `chatgpt-usage-dock-${process.pid}.plist`);
  execFileSync('/usr/bin/defaults', ['export', 'com.apple.dock', tmp]);
  const result = fn(tmp, readDockTiles(tmp));
  if (result !== 'unchanged') {
    execFileSync('/usr/bin/defaults', ['import', 'com.apple.dock', tmp]);
    spawnSync('/usr/bin/killall', ['Dock']);
  }
  fs.rmSync(tmp, { force: true });
  return result;
}

// 返回 'replaced' | 'added' | 'exists'；oldPaths 为旧启动器路径，会被改指向新启动器
export function dockInstall(appPath, LAUNCHER_PATH, oldPaths = []) {
  return editDock((tmp, tiles) => {
    if (!fs.existsSync(DOCK_BACKUP)) {
      fs.mkdirSync(path.dirname(DOCK_BACKUP), { recursive: true });
      fs.copyFileSync(tmp, DOCK_BACKUP);
    }
    if (tiles.some((t) => t.path === LAUNCHER_PATH)) return 'unchanged';
    const orig = tiles.find((t) => oldPaths.includes(t.path)) || tiles.find((t) => t.path === appPath);
    if (orig) {
      retarget(tmp, orig.index, LAUNCHER_PATH);
      return 'replaced';
    }
    const i = tiles.length;
    const url = `${pathToFileURL(LAUNCHER_PATH).href}/`;
    pb(tmp, `Add :persistent-apps:${i} dict`);
    pb(tmp, `Add :persistent-apps:${i}:tile-type string file-tile`);
    pb(tmp, `Add :persistent-apps:${i}:tile-data dict`);
    pb(tmp, `Add :persistent-apps:${i}:tile-data:file-data dict`);
    pb(tmp, `Add :persistent-apps:${i}:tile-data:file-data:_CFURLString string ${url}`);
    pb(tmp, `Add :persistent-apps:${i}:tile-data:file-data:_CFURLStringType integer 15`);
    return 'added';
  }).replace('unchanged', 'exists');
}

// 把启动器图标换回原应用；返回 'restored' | 'none'
export function dockRestore(app, launcherPaths) {
  return editDock((tmp, tiles) => {
    const t = tiles.find((x) => launcherPaths.includes(x.path));
    if (!t) return 'unchanged';
    if (app) retarget(tmp, t.index, app.path);
    else pb(tmp, `Delete :persistent-apps:${t.index}`);
    return 'restored';
  }).replace('unchanged', 'none');
}

// 延迟几秒后通过启动器重新打开 Codex（独立进程，调用方退出也不影响）
export function relaunchLater(LAUNCHER_PATH, seconds = 15) {
  const child = spawn('/bin/sh', ['-c', `sleep ${Number(seconds)}; /usr/bin/open ${shq(LAUNCHER_PATH)}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
