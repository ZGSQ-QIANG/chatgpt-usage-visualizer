// Windows integration. Pass scripts as UTF-16 encoded commands; never through cmd.exe.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
export const encoded = (s) => Buffer.from(s, 'utf16le').toString('base64');
// PowerShell 5 unwraps one-item pipelines before ConvertTo-Json.
export function parsePowerShellList(json) {
  const data = JSON.parse(json || 'null');
  return data == null ? [] : Array.isArray(data) ? data : [data];
}
export const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export function runPowerShell(script, timeout = 30000) {
  return execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); " + script)],
  { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function windowsProcesses() {
  const data = runPowerShell(`@(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{pid=$_.ProcessId; ppid=$_.ParentProcessId; executable=$_.ExecutablePath;
      command=$_.CommandLine; age=if ($_.CreationDate) { [math]::Max(0, ((Get-Date)-$_.CreationDate).TotalSeconds) } else { $null }}
  }) | ConvertTo-Json -Compress`);
  return parsePowerShellList(data);
}

export function findWindowsApp(names) {
  // An explicit executable path is useful for portable installs and custom locations.
  for (const n of names) if (path.isAbsolute(n) && /\.exe$/i.test(n) && fs.existsSync(n)) {
    return { name: path.basename(n, '.exe'), path: n };
  }
  let procs = [];
  try { procs = windowsProcesses(); } catch {}
  for (const n of names) {
    const hit = procs.find((p) => p.executable && path.basename(p.executable).toLowerCase() === `${n}.exe`.toLowerCase()
      && fs.existsSync(path.join(path.dirname(p.executable), 'resources', 'app.asar')));
    if (hit) return { name: n, path: hit.executable };
  }
  for (const n of names) {
    for (const dir of [path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', n),
      path.join(process.env.LOCALAPPDATA || os.homedir(), n), path.join(process.env.ProgramFiles || 'C:\\Program Files', n)]) {
      const exe = path.join(dir, `${n}.exe`);
      if (fs.existsSync(exe)) return { name: n, path: exe };
    }
  }
  // Store installations move on updates, so resolve InstallLocation on every launch.
  try {
    const locations = parsePowerShellList(runPowerShell(`@(Get-AppxPackage | Where-Object { $_.Name -match '^OpenAI\\.(Codex|ChatGPT)' } | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress`));
    for (const dir of locations) for (const n of names) for (const sub of ['app', '']) {
      const exe = path.join(dir, sub, `${n}.exe`);
      if (fs.existsSync(exe)) return { name: n, path: exe };
    }
  } catch {}
  return null;
}

export function openWindowsApp(app) {
  const child = spawn(app.path, [], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export function revealLauncher(shortcut) {
  const child = spawn('explorer.exe', [`/select,${shortcut}`], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

const dataDir = () => path.join(process.env.LOCALAPPDATA || os.homedir(), 'chatgpt-usage-visualizer');
const programsDir = () => path.join(process.env.APPDATA || os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const manifestPath = () => path.join(dataDir(), 'launcher.json');
export const getWindowsLog = () => path.join(dataDir(), 'logs', 'chatgpt-usage-visualizer.log');
export const windowsLog = getWindowsLog();

// IShellLinkW/IPersistFile use Unicode paths on every Windows locale. WScript's
// shortcut Save converts filenames to the system ANSI code page on some systems.
const SHELL_LINK = `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class UsageShellLink {}
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUsageShellLinkW {
 void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n, IntPtr data, uint flags);
 void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
 void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
 void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
 void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
 void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
 void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
 void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
 void GetHotkey(out short key); void SetHotkey(short key);
 void GetShowCmd(out int cmd); void SetShowCmd(int cmd);
 void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n, out int index);
 void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int index);
 void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint reserved);
 void Resolve(IntPtr hwnd, uint flags);
 void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
}
public static class UsageShortcut {
 public static void Save(string file, string target, string args, string cwd, string icon) {
  var link = (IUsageShellLinkW)new UsageShellLink();
  try {
   link.SetPath(target); link.SetArguments(args); link.SetWorkingDirectory(cwd);
   link.SetIconLocation(icon, 0); link.SetDescription("Codex Usage Visualizer"); link.SetShowCmd(7);
   ((IPersistFile)link).Save(file, true);
  } finally { Marshal.FinalReleaseComObject(link); }
 }
}
'@;`;

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch { return null; }
}
function ownedShortcut(m) {
  return m?.id === 'chatgpt-usage-visualizer' && typeof m.path === 'string'
    && path.dirname(m.path) === programsDir() && path.basename(m.path).endsWith(' (Usage).lnk');
}
export function windowsLaunchers() {
  const m = readManifest();
  return ownedShortcut(m) && fs.existsSync(m.path) ? [m.path] : [];
}
export function installWindowsLauncher({ app, name, nodePath, toolPath, extraArgs = [] }) {
  const launcherName = name || app.name;
  if (!launcherName || /[<>:"/\\|?*\x00-\x1f]/.test(launcherName) || /[. ]$/.test(launcherName)) throw new Error('启动器名称包含无效字符');
  const dest = path.join(programsDir(), `${launcherName} (Usage).lnk`);
  const old = windowsLaunchers();
  if (fs.existsSync(dest) && !old.includes(dest)) throw new Error(`启动器 ${dest} 已存在且不是本工具生成的`);
  fs.mkdirSync(programsDir(), { recursive: true });
  const logPath = getWindowsLog();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // PS invokes Node directly, with a hidden window and persistent log, without execution-policy changes.
  const args = [toolPath, 'start', '--with-app', '--yes', ...extraArgs].map(psQuote).join(' ');
  const script = `& ${psQuote(nodePath)} ${args} *>> ${psQuote(logPath)}`;
  const shortcutArgs = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded(script)}`;
  runPowerShell(`${SHELL_LINK}\n[UsageShortcut]::Save(${[dest, powershell, shortcutArgs, path.dirname(toolPath), app.path].map(psQuote).join(',')})`);
  fs.writeFileSync(manifestPath(), JSON.stringify({ id: 'chatgpt-usage-visualizer', path: dest }));
  const removed = old.filter((p) => p !== dest);
  for (const p of removed) fs.rmSync(p, { force: true });
  return { path: dest, name: launcherName, removed };
}
export function uninstallWindowsLauncher() {
  const found = windowsLaunchers();
  for (const p of found) fs.rmSync(p, { force: true });
  fs.rmSync(manifestPath(), { force: true });
  return found;
}
export function relaunchWindowsLater(shortcut, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('延迟秒数必须是非负数字');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', encoded(`Start-Sleep -Seconds ${seconds}; Invoke-Item -LiteralPath ${psQuote(shortcut)}`)],
  // Windows PowerShell exits without executing scripts when started without a console
  // using CREATE_DETACHED_PROCESS. A hidden, unreferenced child survives the parent.
  { stdio: 'ignore', windowsHide: true });
  child.unref();
}

export function windowsDialog({ title, message, buttons, defaultButton, cancelButton }) {
  try {
    return runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
      $f=New-Object System.Windows.Forms.Form; $f.Text=${psQuote(title)}; $f.Size=New-Object System.Drawing.Size(690,360);
      $f.StartPosition='CenterScreen'; $f.TopMost=$true; $f.Tag=${psQuote(cancelButton || '')};
      $l=New-Object System.Windows.Forms.Label; $l.Text=${psQuote(message)}; $l.Location=New-Object System.Drawing.Point(20,20);
      $l.Size=New-Object System.Drawing.Size(640,220); $f.Controls.Add($l);
      ${buttons.map((b, i) => `$b${i}=New-Object System.Windows.Forms.Button; $b${i}.Text=${psQuote(b)};
        $b${i}.Location=New-Object System.Drawing.Point(${20 + i * 215},260); $b${i}.Size=New-Object System.Drawing.Size(205,35);
        $b${i}.Add_Click({$f.Tag=$this.Text; $f.Close()}); $f.Controls.Add($b${i});
        ${b === defaultButton ? `$f.AcceptButton=$b${i};` : ''} ${b === cancelButton ? `$f.CancelButton=$b${i};` : ''}`).join('\n')}
      $timer=New-Object System.Windows.Forms.Timer; $timer.Interval=300000;
      $timer.Add_Tick({$f.Close()}); $timer.Start();
      [void]$f.ShowDialog(); $timer.Dispose(); Write-Output $f.Tag`, 310000);
  } catch { return cancelButton || null; }
}
