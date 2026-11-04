import { EventEmitter } from 'node:events';
import { AppServerClient } from './appServer.js';
import { mergeSnapshot, toDisplayWindows } from './normalize.js';
import { readLatestFromSessions, watchSessions } from './sessions.js';

// 自动同步：启动读取 + 定时轮询（前台 / 后台不同间隔）+ 会话文件变化触发 + 倒计时归零触发 + app-server 推送
// 事件：'change'
export class UsageSync extends EventEmitter {
  constructor({ cfg, codexBin, isFocused, log, debug = false }) {
    super();
    this.cfg = cfg;
    this.codexBin = codexBin;
    this.isFocused = isFocused || (async () => true);
    this.log = log;
    this.debug = debug;
    this.snapshot = null;
    this.syncedAt = null;
    this.source = null;
    this.error = null;
    this.failures = 0;
    this.client = null;
    this.pollTimer = null;
    this.resetTimer = null;
    this.inflight = null;
    this.stopped = false;
  }

  payload() {
    return {
      windows: toDisplayWindows(this.snapshot),
      syncedAt: this.syncedAt,
      source: this.source,
      error: this.error ? String(this.error) : null,
    };
  }

  async start() {
    await this.#startClient();
    this.unwatch = watchSessions(this.cfg.sessionsDir, () => this.#throttledSessionRefresh());
    await this.refresh('启动');
  }

  async #startClient() {
    if (!this.codexBin || this.stopped) return;
    const c = new AppServerClient(this.codexBin, { debug: this.debug });
    c.on('rateLimits', (snap) => {
      this.lastPush = { snap, at: Date.now() };
      this.snapshot = mergeSnapshot(this.snapshot, snap);
      this.source = 'app-server';
      this.#accept('app-server 推送');
    });
    c.on('exit', () => {
      if (this.client === c) this.client = null;
      if (!this.stopped) {
        this.log('app-server 已断开，10 秒后重连');
        setTimeout(() => this.#startClient().catch(() => {}), 10000);
      }
    });
    try {
      await c.start();
      this.client = c;
      this.log(`已连接 app-server：${this.codexBin}`);
    } catch (e) {
      this.log(`app-server 启动失败，将使用会话记录作为数据源：${e.message}`);
      c.stop();
    }
  }

  #accept(reason, syncedAt = Date.now()) {
    this.syncedAt = syncedAt;
    this.error = null;
    this.failures = 0;
    if (this.debug) this.log(`额度已更新（${reason}）`);
    this.#scheduleResetCheck();
    this.emit('change', this.payload());
  }

  // 对话进行中会频繁写文件，限制为最多 15 秒拉一次
  #throttledSessionRefresh() {
    const wait = 15000 - (Date.now() - (this.lastRefreshAt || 0));
    if (wait <= 0) return this.refresh('会话更新');
    if (!this.sessionTimer) {
      this.sessionTimer = setTimeout(() => { this.sessionTimer = null; this.refresh('会话更新'); }, wait);
    }
  }

  // 同一时间只跑一次拉取
  refresh(reason) {
    if (this.inflight) return this.inflight;
    this.inflight = this.#doRefresh(reason).finally(() => {
      this.inflight = null;
      this.#schedulePoll();
    });
    return this.inflight;
  }

  async #doRefresh(reason) {
    this.lastRefreshAt = Date.now();
    if (this.client) {
      try {
        const startedAt = Date.now();
        let snap = mergeSnapshot(null, await this.client.readRateLimits());
        // 读取期间收到的推送更新，叠加在完整快照之上
        if (this.lastPush && this.lastPush.at >= startedAt) snap = mergeSnapshot(snap, this.lastPush.snap);
        this.snapshot = snap;
        this.source = 'app-server';
        this.#accept(reason);
        return;
      } catch (e) {
        this.log(`读取额度失败：${e.message}`);
      }
    }
    const fallback = readLatestFromSessions(this.cfg.sessionsDir);
    if (fallback) {
      this.snapshot = fallback.snapshot;
      this.source = 'sessions';
      this.#accept(`${reason}，来自会话记录`, Math.round(fallback.mtime));
      return;
    }
    this.failures++;
    this.error = '无法获取额度数据';
    this.emit('change', this.payload());
  }

  async #schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.stopped) return;
    let sec;
    if (this.failures > 0) sec = Math.min(300, 30 * 2 ** (this.failures - 1));
    else sec = (await this.isFocused()) ? this.cfg.pollFocusedSec : this.cfg.pollBackgroundSec;
    this.pollTimer = setTimeout(() => this.refresh('定时'), sec * 1000);
  }

  // 最近的重置时刻过后 3 秒拉一次；若服务端仍返回已过期的时间，30 秒后再试
  #scheduleResetCheck() {
    clearTimeout(this.resetTimer);
    const nowSec = Date.now() / 1000;
    const ts = toDisplayWindows(this.snapshot).map((w) => w.resetsAt).filter(Boolean);
    if (!ts.length) return;
    const expired = ts.some((t) => t <= nowSec);
    const next = Math.min(...ts.filter((t) => t > nowSec), Infinity);
    const delayMs = expired ? 30000 : (next - nowSec + 3) * 1000;
    if (Number.isFinite(delayMs)) this.resetTimer = setTimeout(() => this.refresh('额度重置'), Math.min(delayMs, 2 ** 31 - 1));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.resetTimer);
    clearTimeout(this.sessionTimer);
    if (this.unwatch) this.unwatch();
    if (this.client) this.client.stop();
  }
}
