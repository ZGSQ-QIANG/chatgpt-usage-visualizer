import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { normalizeSnapshot } from './normalize.js';

const VERSION = '0.4.0';

// 查找 codex 可执行文件：配置 > 桌面端安装包内置 > PATH
// 每个候选都先试运行 `--version`，跳过安装损坏的（例如 npm 安装缺少平台二进制）
export function findCodexBin(cfg, appPath) {
  const candidates = [];
  if (cfg.codexBin) candidates.push(cfg.codexBin);
  if (appPath) {
    for (const sub of ['Resources', 'MacOS']) {
      const found = searchExecutable(path.join(appPath, 'Contents', sub), 'codex', 5);
      if (found) candidates.push(found);
    }
  }
  try {
    const p = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
    if (p) candidates.push(p);
  } catch {}
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 10000 });
      return c;
    } catch {}
  }
  return null;
}

function searchExecutable(dir, name, depth) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) {
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
    }
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.endsWith('.lproj')) {
      const r = searchExecutable(path.join(dir, e.name), name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

// 与 `codex app-server` 通过 stdio 交换 JSON 行（JSON-RPC 2.0，省略 jsonrpc 字段）
// 事件：'rateLimits'(稀疏快照)、'exit'
export class AppServerClient extends EventEmitter {
  constructor(bin, { debug = false } = {}) {
    super();
    this.bin = bin;
    this.debug = debug;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
  }

  async start() {
    this.proc = spawn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`app-server 已退出 (${code})`));
      this.pending.clear();
      this.proc = null;
      this.emit('exit', code);
    });
    this.proc.on('error', (e) => this.emit('exit', e.message));
    this.proc.stderr.on('data', (d) => this.debug && process.stderr.write(`[app-server] ${d}`));
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.#onLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'chatgpt-usage-visualizer', title: 'Codex Usage Countdown', version: VERSION },
    });
    this.notify('initialized');
  }

  #send(msg) {
    if (!this.proc) throw new Error('app-server 未运行');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id) && !msg.method) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'account/rateLimits/updated') {
      const snap = normalizeSnapshot(msg.params);
      if (snap) this.emit('rateLimits', snap);
      return;
    }
    // 服务端发来的请求（如审批），本工具不处理，直接拒绝
    if (msg.method && msg.id !== undefined) {
      this.#send({ id: msg.id, error: { code: -32601, message: 'not supported by chatgpt-usage-visualizer' } });
    }
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { method, id };
      if (params !== undefined) msg.params = params;
      try { this.#send(msg); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) {
    const msg = { method };
    if (params !== undefined) msg.params = params;
    this.#send(msg);
  }

  async readRateLimits() {
    const result = await this.request('account/rateLimits/read');
    const snap = normalizeSnapshot(result);
    if (!snap) throw new Error('额度响应格式无法识别');
    return snap;
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}
