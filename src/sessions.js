import fs from 'node:fs';
import path from 'node:path';
import { normalizeSnapshot } from './normalize.js';

// 监听会话目录：桌面端每次对话写入新记录时触发回调（防抖）
export function watchSessions(dir, onChange, debounceMs = 2000) {
  if (!fs.existsSync(dir)) return () => {};
  let timer = null;
  let watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_evt, file) => {
      if (file && !String(file).endsWith('.jsonl')) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
  } catch {
    return () => {};
  }
  return () => { clearTimeout(timer); watcher.close(); };
}

function newestJsonl(dir, limit = 5) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch {}
      }
    }
  };
  walk(dir, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function findRateLimits(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.rate_limits) return o.rate_limits;
  for (const v of Object.values(o)) {
    const r = findRateLimits(v);
    if (r) return r;
  }
  return null;
}

// 备用数据源：只读最近会话文件末尾，提取最后一条额度快照（尾部字节可能包含对话，只在本机内存中扫描）
// 返回 { snapshot, mtime } 或 null
export function readLatestFromSessions(dir) {
  for (const { full: file, mtime } of newestJsonl(dir)) {
    let text;
    try {
      const { size } = fs.statSync(file);
      const len = Math.min(size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const snap = normalizeSnapshot(findRateLimits(JSON.parse(lines[i])));
        if (snap) return { snapshot: snap, mtime };
      } catch {}
    }
  }
  return null;
}
