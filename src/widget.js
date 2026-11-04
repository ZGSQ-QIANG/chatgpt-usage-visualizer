// 注入到 Codex 主窗口的组件脚本（在页面里运行，不能使用 Node API）
// 运行前会在前面拼接：window.__codexUsageConfig = {...}
(() => {
  const VERSION = '0.5.0';
  if (window.__codexUsageCountdown && window.__codexUsageCountdown.version === VERSION) return;
  if (window.__codexUsageCountdown) window.__codexUsageCountdown.destroy();

  const CFG = window.__codexUsageConfig || {};
  const MOUNT = CFG.mount || { anchorSelectors: ['button[aria-label="用量"]'], levelsUp: 1, position: 'before' };
  const TH = CFG.thresholds || { warnRemainingPercent: 25, dangerRemainingPercent: 10 };
  const STALE_MS = (CFG.staleAfterSec || 600) * 1000;
  const RING_C = 2 * Math.PI * 15;

  let state = null; // { windows, syncedAt, status, error, retryAt }
  let host = null, root = null, popOpen = false, observer = null, timer = null, rafPending = false, resizeObs = null;

  const pad = (n) => String(n).padStart(2, '0');
  const now = () => Date.now();

  function remainingSec(w) {
    return w.resetsAt ? Math.floor(w.resetsAt - now() / 1000) : null;
  }
  // 侧栏较窄时（紧凑模式）省略秒数，避免文字溢出
  function fmtRail(s, compact) {
    if (s === null) return '—';
    if (s <= 0) return compact ? '重置中' : '重置中…';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return compact ? `${d}天${h}时` : `${d}天 ${pad(h)}时`;
    return compact ? `${h}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
  }
  function fmtFull(s) {
    if (s === null) return '—';
    if (s <= 0) return '重置中…';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return `${d > 0 ? d + '天 ' : ''}${pad(h)}:${pad(m)}:${pad(s % 60)}`;
  }
  function fmtResetAt(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())} 重置`;
  }
  function fmtAgo(ms) {
    const s = Math.max(0, Math.floor((now() - ms) / 1000));
    if (s < 10) return '刚刚更新';
    if (s < 60) return `${s} 秒前更新`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前更新`;
    return `${Math.floor(s / 3600)} 小时前更新`;
  }
  function level(remaining, stale) {
    if (stale) return 'stale';
    if (remaining <= TH.dangerRemainingPercent) return 'danger';
    if (remaining <= TH.warnRemainingPercent) return 'warn';
    return 'ok';
  }
  function isDark() {
    const c = getComputedStyle(document.body).color.match(/\d+(\.\d+)?/g);
    if (!c) return matchMedia('(prefers-color-scheme: dark)').matches;
    const [r, g, b] = c.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 140; // 文字偏亮 => 深色主题
  }

  const CSS = `
    :host { all: initial; display: block; width: 100%; font-family: inherit; color: var(--fg); }
    :host([data-theme="light"]) { --fg:#2f3432; --muted:#6f7673; --track:#dde2df; --ok:#5e7f6b; --warn:#b7812f; --danger:#c0533f; --stale:#a3a9a6; --line:#e3e6e4; --card:#ffffff; --cardborder:#e6e8e7; --btnhover:#f1f3f2; }
    :host([data-theme="dark"]) { --fg:#e6e9e7; --muted:#9aa29e; --track:#3a3f3d; --ok:#86b097; --warn:#d9a65a; --danger:#e07d6a; --stale:#6c7370; --line:#3a3f3d; --card:#232625; --cardborder:#363a38; --btnhover:#2e3230; }
    * { box-sizing: border-box; }
    .rail { display:flex; flex-direction:column; align-items:center; gap:14px; padding:6px 0 10px; cursor:pointer; border-radius:8px; outline:none; }
    .rail:focus-visible { box-shadow: 0 0 0 2px var(--ok); }
    .w { display:flex; flex-direction:column; align-items:center; gap:3px; }
    .lbl { font-size:11px; color:var(--muted); white-space:nowrap; }
    .ring { position:relative; width:36px; height:36px; }
    .ring svg { width:36px; height:36px; transform:rotate(-90deg); }
    .ring .pct { position:absolute; inset:0; display:grid; place-items:center; font-size:10.5px; font-variant-numeric:tabular-nums; color:var(--fg); }
    .trk { stroke:var(--track); }
    .val { transition: stroke-dashoffset .6s ease; }
    .cd { font-size:10px; letter-spacing:-.2px; font-variant-numeric:tabular-nums; white-space:nowrap; color:var(--fg); }
    :host([data-compact]) .ring, :host([data-compact]) .ring svg { width:30px; height:30px; }
    :host([data-compact]) .ring .pct { font-size:9.5px; }
    :host([data-compact]) .lbl { font-size:10px; }
    .sep { width:70%; height:1px; background:var(--line); margin-top:2px; }
    .s-ok { stroke:var(--ok); } .s-warn { stroke:var(--warn); } .s-danger { stroke:var(--danger); } .s-stale { stroke:var(--stale); }
    .b-ok { background:var(--ok); } .b-warn { background:var(--warn); } .b-danger { background:var(--danger); } .b-stale { background:var(--stale); }
    .pop { position:fixed; z-index:2147483000; width:240px; background:var(--card); border:1px solid var(--cardborder); border-radius:14px; padding:16px 16px 12px; box-shadow:0 8px 28px rgba(0,0,0,.14); color:var(--fg); }
    .pop[hidden] { display:none; }
    .hd { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; font-size:14px; font-weight:600; }
    .x { border:0; background:transparent; color:var(--muted); font-size:16px; width:24px; height:24px; border-radius:6px; cursor:pointer; line-height:1; }
    .x:hover { background:var(--btnhover); color:var(--fg); }
    .blk { padding:4px 0 12px; }
    .blk + .blk { border-top:0; }
    .top { display:flex; justify-content:space-between; align-items:baseline; font-size:13px; }
    .big { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
    .big small { font-size:11px; font-weight:400; color:var(--muted); margin-left:3px; }
    .bar { height:5px; border-radius:3px; background:var(--track); margin:8px 0 8px; overflow:hidden; }
    .bar i { display:block; height:100%; border-radius:3px; transition: width .6s ease; }
    .row { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-top:3px; }
    .row b { font-weight:500; color:var(--fg); font-variant-numeric:tabular-nums; }
    .ftw { display:flex; align-items:center; justify-content:space-between; gap:8px; border-top:1px solid var(--line); padding-top:10px; margin-top:2px; }
    .ft { font-size:11.5px; color:var(--muted); line-height:1.4; }
    .ft.err { color:var(--danger); }
    .rf { flex-shrink:0; font:inherit; font-size:12px; color:var(--fg); background:transparent; border:1px solid var(--cardborder); border-radius:8px; padding:4px 10px; cursor:pointer; }
    .rf:hover { background:var(--btnhover); }
    .rf:disabled { color:var(--muted); cursor:default; background:transparent; }
    @media (prefers-reduced-motion: reduce) { .val, .bar i { transition:none; } }
  `;

  function windowsView() {
    const stale = !state || !state.syncedAt || now() - state.syncedAt > STALE_MS;
    return (state && state.windows ? state.windows : []).map((w) => {
      const secs = remainingSec(w);
      const remaining = Math.round(100 - w.usedPercent);
      return { ...w, secs, remaining, lv: level(remaining, stale || (secs !== null && secs <= 0)) };
    });
  }

  function build() {
    host = document.createElement('div');
    host.setAttribute('data-chatgpt-usage-visualizer', VERSION);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="rail" role="button" tabindex="0" aria-label="查看剩余额度"></div>
      <div class="pop" hidden role="dialog" aria-label="剩余额度">
        <div class="hd"><span>剩余额度</span><button class="x" aria-label="关闭">×</button></div>
        <div class="body"></div><div class="ftw"><div class="ft"></div><button class="rf" title="立即同步一次（不影响自动同步）">刷新</button></div>
      </div>`;
    const rail = root.querySelector('.rail');
    rail.addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
    rail.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePop(); } });
    root.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); togglePop(false); });
    root.querySelector('.rf').addEventListener('click', (e) => { e.stopPropagation(); manualRefresh(); });
    renderStructure();
  }

  function renderStructure() {
    if (!root) return;
    const ws = windowsView();
    const rail = root.querySelector('.rail');
    rail.innerHTML = ws.length
      ? ws.map((w, i) => `
        <div class="w" data-i="${i}">
          <span class="lbl">${w.label}</span>
          <div class="ring"><svg viewBox="0 0 36 36"><circle class="trk" cx="18" cy="18" r="15" fill="none" stroke-width="3.2"/>
            <circle class="val" cx="18" cy="18" r="15" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(2)}"/></svg>
            <span class="pct"></span></div>
          <span class="lbl">距重置</span><span class="cd"></span>
        </div>`).join('') + '<div class="sep"></div>'
      : `<div class="w"><span class="lbl">额度</span><span class="cd">同步中…</span></div><div class="sep"></div>`;
    root.querySelector('.body').innerHTML = ws.map((w, i) => `
      <div class="blk" data-i="${i}">
        <div class="top"><span>${w.label}额度</span><span class="big"><span class="n"></span>%<small>剩余</small></span></div>
        <div class="bar"><i></i></div>
        <div class="row"><span>距重置</span><b class="cdf"></b></div>
        <div class="row"><span class="at"></span></div>
      </div>`).join('');
    tick();
  }

  function tick() {
    if (!root) return;
    host.setAttribute('data-theme', isDark() ? 'dark' : 'light');
    const ws = windowsView();
    ws.forEach((w, i) => {
      const r = root.querySelector(`.rail .w[data-i="${i}"]`);
      if (r) {
        const v = r.querySelector('.val');
        v.setAttribute('class', `val s-${w.lv}`);
        v.style.strokeDashoffset = (RING_C * (1 - Math.max(0, Math.min(100, w.remaining)) / 100)).toFixed(2);
        r.querySelector('.pct').textContent = `${w.remaining}%`;
        r.querySelector('.cd').textContent = fmtRail(w.secs, host.hasAttribute('data-compact'));
      }
      const b = root.querySelector(`.body .blk[data-i="${i}"]`);
      if (b) {
        b.querySelector('.n').textContent = w.remaining;
        const bar = b.querySelector('.bar i');
        bar.className = `b-${w.lv}`;
        bar.style.width = `${Math.max(0, Math.min(100, w.remaining))}%`;
        b.querySelector('.cdf').textContent = fmtFull(w.secs);
        b.querySelector('.at').textContent = fmtResetAt(w.resetsAt);
      }
    });
    const ft = root.querySelector('.ft');
    if (!state || !state.syncedAt) {
      ft.className = state && state.error ? 'ft err' : 'ft';
      ft.textContent = state && state.error ? `同步失败，稍后自动重试` : '正在同步…';
    } else if (state.error) {
      ft.className = 'ft err';
      ft.textContent = `同步失败，稍后自动重试 · ${fmtAgo(state.syncedAt)}`;
    } else if (now() - state.syncedAt > STALE_MS) {
      ft.className = 'ft err';
      ft.textContent = `数据可能已过期 · ${fmtAgo(state.syncedAt)}`;
    } else {
      ft.className = 'ft';
      ft.textContent = `自动同步 · ${fmtAgo(state.syncedAt)}`;
    }
    const src = state && state.source === 'sessions' ? ' · 来自会话记录' : '';
    if (state && state.syncedAt && src) ft.textContent += src;
    const rf = root.querySelector('.rf');
    rf.disabled = refreshing || typeof window.__codexUsageRefresh !== 'function';
    rf.textContent = refreshing ? '刷新中…' : '刷新';
    if (popOpen) placePop();
  }

  function placePop() {
    const pop = root.querySelector('.pop');
    const r = host.getBoundingClientRect();
    const h = pop.offsetHeight || 300;
    pop.style.left = `${Math.round(r.right + 10)}px`;
    pop.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - h - 8, r.bottom - h)))}px`;
  }

  function togglePop(force) {
    popOpen = force === undefined ? !popOpen : force;
    const pop = root.querySelector('.pop');
    pop.hidden = !popOpen;
    if (popOpen) placePop();
  }

  // 手动刷新：通知本机的同步程序立即拉取一次；收到新数据或 15 秒后恢复按钮
  let refreshing = false, refreshTimer = null;
  function manualRefresh() {
    if (refreshing || typeof window.__codexUsageRefresh !== 'function') return;
    refreshing = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshing = false; tick(); }, 15000);
    try { window.__codexUsageRefresh(''); } catch {}
    tick();
  }
  function refreshDone() {
    if (!refreshing) return;
    refreshing = false;
    clearTimeout(refreshTimer);
  }

  const onDocClick = (e) => { if (popOpen && !e.composedPath().includes(host)) togglePop(false); };
  const onKey = (e) => { if (e.key === 'Escape' && popOpen) togglePop(false); };

  function findAnchor() {
    for (const sel of MOUNT.anchorSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function ensureMounted() {
    rafPending = false;
    if (host && host.isConnected) return;
    const anchor = findAnchor();
    if (!anchor) return;
    let target = anchor;
    for (let i = 0; i < (MOUNT.levelsUp || 0) && target.parentElement; i++) target = target.parentElement;
    if (!host) build();
    if (MOUNT.position === 'after') target.after(host);
    else target.before(host);
    if (resizeObs) resizeObs.disconnect();
    resizeObs = new ResizeObserver(() => {
      const compact = host.getBoundingClientRect().width < 48;
      if (compact !== host.hasAttribute('data-compact')) { host.toggleAttribute('data-compact', compact); tick(); }
    });
    resizeObs.observe(host);
  }

  function start() {
    ensureMounted();
    observer = new MutationObserver(() => {
      if (!rafPending && !(host && host.isConnected)) { rafPending = true; requestAnimationFrame(ensureMounted); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timer = setInterval(tick, 1000);
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  window.__codexUsageCountdown = {
    version: VERSION,
    update(payload) {
      refreshDone();
      const prevCount = state && state.windows ? state.windows.length : -1;
      state = payload;
      const count = payload && payload.windows ? payload.windows.length : 0;
      if (count !== prevCount) renderStructure(); else tick();
    },
    status() {
      return { mounted: !!(host && host.isConnected), anchorFound: !!findAnchor(), hasData: !!(state && state.syncedAt) };
    },
    destroy() {
      if (observer) observer.disconnect();
      if (resizeObs) resizeObs.disconnect();
      clearInterval(timer);
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (host) host.remove();
      host = root = null;
      delete window.__codexUsageCountdown;
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
