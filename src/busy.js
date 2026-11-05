import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 判断 Codex 是否可能正在执行任务（启发式，两条满足其一即视为忙碌）：
// 1. 最近 recentWriteSec 秒（默认 30）内有会话记录写入（模型正在回复或刚执行完步骤）
// 2. Codex 内置的 codex 进程下有未知的活动命令（如构建、测试）。
//    只排除可识别的 MCP 服务本身，不能按启动时间永久忽略早期开始的任务。

function parseEtime(s) {
  // macOS ps 的 etime 格式：[[dd-]hh:]mm:ss
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function listProcesses() {
  let out = '';
  try {
    out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  const procs = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), age: parseEtime(m[3]), command: m[4] }));
  return procs.length ? procs : null;
}

function isKnownMcpService(command) {
  // 只识别明确的官方服务入口；shell 包装器和未知服务均保守视为活动任务。
  return /^(?:\S*\/)?npx\s+(?:(?:-y|--yes)\s+)?@modelcontextprotocol\/server-[\w-]+(?:\s|$)/.test(command)
    || /^(?:\S*\/)?node\s+\S*\/@modelcontextprotocol\/server-[\w-]+\/(?:dist|build)\/\S+\.js(?:\s|$)/.test(command);
}

export function runningCommands(appPath, procs = listProcesses()) {
  if (!procs) return null;
  const inApp = (p) => p.command.startsWith(appPath + '/');
  const roots = procs.filter((p) => inApp(p) && /\/codex(?:\s|$)/.test(p.command.slice(appPath.length)));
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const found = [];
  const visited = new Set();
  for (const root of roots) {
    const stack = [...(children.get(root.pid) || [])];
    while (stack.length) {
      const p = stack.pop();
      if (visited.has(p.pid)) continue;
      visited.add(p.pid);
      stack.push(...(children.get(p.pid) || []));
      if (inApp(p) || isKnownMcpService(p.command)) continue;
      found.push(p);
    }
  }
  return found;
}

function newestSessionWriteAgeSec(dir) {
  let newest = 0;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch {}
      }
    }
  };
  walk(dir, 0);
  return newest ? (Date.now() - newest) / 1000 : Infinity;
}

// 返回 { busy, reason }
export function codexBusy(app, cfg) {
  const b = cfg.busy || {};
  const writeAge = newestSessionWriteAgeSec(cfg.sessionsDir);
  if (writeAge < (b.recentWriteSec ?? 30)) return { busy: true, reason: `${Math.round(writeAge)} 秒前有会话写入` };
  const cmds = runningCommands(app.path);
  if (!cmds) return { busy: true, reason: '无法确认进程状态，请手动确认任务已结束' };
  if (cmds.length) return { busy: true, reason: `正在运行命令：${cmds[0].command.slice(0, 60)}` };
  return { busy: false, reason: '' };
}

const asStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '" & linefeed & "')}"`;

// 弹出最多三个按钮的对话框，返回被点击的按钮文字；取消或出错返回 null
export function askDialog({ title, message, buttons, defaultButton, cancelButton }) {
  const script = `display dialog ${asStr(message)} with title ${asStr(title)} buttons {${buttons.map(asStr).join(', ')}}`
    + (defaultButton ? ` default button ${asStr(defaultButton)}` : '')
    + (cancelButton ? ` cancel button ${asStr(cancelButton)}` : '')
    + ' with icon caution giving up after 300';
  // 先 activate，让对话框显示在最前面（组件程序在后台运行，否则对话框可能被 Codex 窗口挡住）
  const r = spawnSync('/usr/bin/osascript', ['-e', 'activate', '-e', script], { encoding: 'utf8' });
  if (r.status !== 0) return cancelButton || null;
  if (/gave up:true/.test(r.stdout)) return cancelButton || null; // 5 分钟无人操作，按取消处理
  const m = r.stdout.match(/button returned:([^,]*)/);
  return m ? m[1].trim() : null;
}

export function notify(title, message) {
  spawnSync('/usr/bin/osascript', ['-e', `display notification ${asStr(message)} with title ${asStr(title)}`]);
}
