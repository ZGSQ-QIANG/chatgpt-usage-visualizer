import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSnapshot, mergeSnapshot, toDisplayWindows, windowLabel } from '../src/normalize.js';
import { readLatestFromSessions } from '../src/sessions.js';
import { AppServerClient } from '../src/appServer.js';
import { pickMainTargets } from '../src/cdp.js';
import { runningCommands, codexBusy } from '../src/busy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUT = { limit_id: 'codex', primary: { used_percent: 9.0, window_minutes: 300, resets_at: 1793809099 },
  secondary: { used_percent: 53.0, window_minutes: 10080, resets_at: 1793896079 }, plan_type: 'plus' };

test('兼容会话记录的下划线字段', () => {
  const s = normalizeSnapshot(ROLLOUT);
  assert.equal(s.primary.usedPercent, 9);
  assert.equal(s.secondary.windowMinutes, 10080);
  assert.equal(s.planType, 'plus');
});

test('兼容 app-server 的驼峰字段与毫秒时间戳', () => {
  const s = normalizeSnapshot({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793809099000 }, secondary: null } });
  assert.equal(s.primary.resetsAt, 1793809099);
  assert.equal(s.secondary, null);
});

test('稀疏通知只覆盖收到的窗口', () => {
  const prev = normalizeSnapshot(ROLLOUT);
  const next = normalizeSnapshot({ rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1 } } });
  const m = mergeSnapshot(prev, next);
  assert.equal(m.primary.usedPercent, 30);
  assert.equal(m.secondary.usedPercent, 53);
});

test('按时长命名并排序', () => {
  assert.equal(windowLabel(300), '5 小时');
  assert.equal(windowLabel(10080), '每周');
  const swapped = { primary: normalizeSnapshot(ROLLOUT).secondary, secondary: normalizeSnapshot(ROLLOUT).primary };
  assert.deepEqual(toDisplayWindows(swapped).map((w) => w.label), ['5 小时', '每周']);
});

test('从会话记录末尾读取最新额度', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuc-'));
  fs.mkdirSync(path.join(dir, '2026', '11'), { recursive: true });
  const f = path.join(dir, '2026', '11', 'rollout-a.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'message', payload: { text: '私密对话内容' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: ROLLOUT } }),
  ].join('\n'));
  const r = readLatestFromSessions(dir);
  assert.equal(r.snapshot.secondary.usedPercent, 53);
  assert.ok(r.mtime > 0);
});

test('app-server 握手、读取与推送', async () => {
  const c = new AppServerClient(path.join(here, 'fake-codex.js'));
  const pushed = new Promise((res) => c.on('rateLimits', res));
  await c.start();
  const snap = await c.readRateLimits();
  assert.equal(snap.primary.usedPercent, 15);
  assert.equal((await pushed).primary.usedPercent, 16);
  c.stop();
});


import { UsageSync } from '../src/sync.js';

test('app-server 临时失败时保留较新的数据，并尽快重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuc-sync-'));
  const old = path.join(dir, 'rollout-old.jsonl');
  fs.writeFileSync(old, JSON.stringify({ payload: { rate_limits: ROLLOUT } }) + '\n');
  const t = (Date.now() - 3600000) / 1000;
  fs.utimesSync(old, t, t); // 一小时前的旧记录
  const failFlag = path.join(dir, 'fail');
  process.env.FAKE_FAIL_FILE = failFlag;
  const logs = [];
  const sync = new UsageSync({ cfg: { sessionsDir: dir, pollFocusedSec: 60, pollBackgroundSec: 300 },
    codexBin: path.join(here, 'fake-codex.js'), log: (m) => logs.push(m) });
  try {
  await sync.start();
  assert.equal(sync.source, 'app-server');
  const goodAt = sync.syncedAt;
  fs.writeFileSync(failFlag, '1');
  await sync.refresh('测试');
  assert.equal(sync.source, 'app-server');          // 没有被旧会话记录覆盖
  assert.ok(sync.syncedAt >= goodAt);             // 仍是 app-server 的数据（期间的推送可能让时间略晚）
  assert.equal(sync.payload().error, '同步失败');
  assert.equal(sync.failures, 1);                    // 30 秒后重试
  fs.rmSync(failFlag);
  await sync.refresh('测试');
  assert.equal(sync.payload().error, null);
  assert.ok(logs.some((l) => l.includes('已恢复')));
  } finally {
    sync.stop();
    delete process.env.FAKE_FAIL_FILE;
  }
});

test('只选择主窗口', () => {
  const t = (url, type = 'page') => ({ id: url, url, type, webSocketDebuggerUrl: 'ws://x' });
  const picked = pickMainTargets([
    t('app://-/index.html'), t('app://-/index.html?initialRoute=%2Favatar-overlay'),
    t('app://-/detached-window.html?initialRoute=%2Fdetached-window'), t('https://chatgpt.com/'),
    t('app://-/index.html', 'iframe'),
  ], { urlPrefix: 'app://-/index.html', excludeUrlIncludes: ['initialRoute='] });
  assert.equal(picked.length, 1);
});

test('识别 Codex 正在运行的命令，排除常驻 MCP 服务和应用自身进程', () => {
  const APP = '/Applications/ChatGPT.app';
  const procs = [
    { pid: 1, ppid: 0, age: 3600, command: `${APP}/Contents/MacOS/ChatGPT` },
    { pid: 2, ppid: 1, age: 3590, command: `${APP}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server` },
    { pid: 3, ppid: 2, age: 3585, command: 'npx some-mcp-server' },
    { pid: 4, ppid: 2, age: 3580, command: `${APP}/Contents/Frameworks/helper` },
  ];
  assert.equal(runningCommands(APP, procs).length, 0);
  procs.push({ pid: 5, ppid: 2, age: 30, command: '/bin/zsh -lc npm run build' });
  procs.push({ pid: 6, ppid: 5, age: 29, command: 'node build.js' });
  const found = runningCommands(APP, procs);
  assert.deepEqual(found.map((p) => p.pid).sort(), [5, 6]);
});

test('最近有会话写入时视为忙碌', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuc-busy-'));
  const f = path.join(dir, 'rollout-x.jsonl');
  fs.writeFileSync(f, '{}\n');
  const app = { path: '/nonexistent/App.app' };
  assert.equal(codexBusy(app, { sessionsDir: dir, busy: {} }).busy, true);
  const old = (Date.now() - 600000) / 1000;
  fs.utimesSync(f, old, old);
  assert.equal(codexBusy(app, { sessionsDir: dir, busy: {} }).busy, false);
});


test('组件样式表包含所有关键规则（防止编辑时误删）', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'widget.js'), 'utf8');
  for (const sel of ['.rail {', '.pop {', '.sty {', '.sty button {', '.ftw {', '.rf {', '.bar {', '.ring {', '.ico {']) {
    assert.ok(src.includes(sel), `缺少样式规则 ${sel}`);
  }
});

test('只有每周额度的套餐（如 Pro）只显示每周', () => {
  for (const raw of [
    { primary: null, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1793896079 } },
    { primary: { used_percent: 40, window_minutes: 10080, resets_at: 1793896079 }, secondary: null },
    { rateLimits: { primary: null, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793896079 } } },
  ]) {
    assert.deepEqual(toDisplayWindows(normalizeSnapshot(raw)).map((w) => w.label), ['每周']);
  }
  assert.deepEqual(toDisplayWindows(normalizeSnapshot({ primary: null, secondary: null })), []);
});
