// 极简 CDP 客户端：使用 Node 22 内置 WebSocket，无第三方依赖

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`调试端口返回 ${res.status}`);
  return res.json();
}

export async function isPortOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function pickMainTargets(targets, filter) {
  return targets.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      String(t.url).startsWith(filter.urlPrefix) &&
      !filter.excludeUrlIncludes.some((s) => String(t.url).includes(s)),
  );
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
      (this.listeners.get('close') || []).forEach((fn) => fn());
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`无法连接 ${url}`)), { once: true });
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// 管理所有主窗口：注入组件脚本、推送数据、窗口重载后自动补注入
export class Injector {
  constructor({ port, filter, widgetSource, getPayload, log }) {
    this.port = port;
    this.filter = filter;
    this.widgetSource = widgetSource;
    this.getPayload = getPayload;
    this.log = log;
    this.sessions = new Map(); // targetId -> CdpSession
  }

  async scan() {
    let targets;
    try {
      targets = pickMainTargets(await listTargets(this.port), this.filter);
    } catch {
      return 0;
    }
    for (const t of targets) {
      if (this.sessions.has(t.id)) continue;
      try {
        const s = await CdpSession.connect(t.webSocketDebuggerUrl);
        this.sessions.set(t.id, s);
        s.on('close', () => this.sessions.delete(t.id));
        s.on('Page.loadEventFired', () => this.#pushTo(s).catch(() => {}));
        await s.send('Page.enable');
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: this.widgetSource });
        await s.evaluate(this.widgetSource);
        await this.#pushTo(s);
        this.log(`已注入窗口：${t.title || t.url}`);
      } catch (e) {
        this.log(`注入失败（${t.title || t.id}）：${e.message}`);
      }
    }
    return this.sessions.size;
  }

  async #pushTo(s) {
    const payload = JSON.stringify(this.getPayload());
    await s.evaluate(`window.__codexUsageCountdown && window.__codexUsageCountdown.update(${payload})`);
  }

  async pushAll() {
    await Promise.all([...this.sessions.values()].map((s) => this.#pushTo(s).catch(() => {})));
  }

  // 返回挂载状态，供 doctor 和日志使用
  async status() {
    const out = [];
    for (const s of this.sessions.values()) {
      try { out.push(await s.evaluate('window.__codexUsageCountdown ? window.__codexUsageCountdown.status() : null')); } catch {}
    }
    return out;
  }

  async anyFocused() {
    for (const s of this.sessions.values()) {
      try { if (await s.evaluate('document.hasFocus()')) return true; } catch {}
    }
    return false;
  }

  async removeAll() {
    for (const s of this.sessions.values()) {
      try { await s.evaluate('window.__codexUsageCountdown && window.__codexUsageCountdown.destroy()'); } catch {}
      s.close();
    }
    this.sessions.clear();
  }
}
