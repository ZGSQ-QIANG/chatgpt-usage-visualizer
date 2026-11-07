// 注入到 Codex 主窗口的组件脚本（在页面里运行，不能使用 Node API）
// 运行前会在前面拼接：window.__codexUsageConfig = {...}
(() => {
  const VERSION = '0.6.0';
  if (window.__codexUsageCountdown && window.__codexUsageCountdown.version === VERSION) return;
  if (window.__codexUsageCountdown) window.__codexUsageCountdown.destroy();

  const CFG = window.__codexUsageConfig || {};
  const MOUNT = CFG.mount || { anchorSelectors: ['button[aria-label="用量"]'], levelsUp: 1, position: 'before' };
  const TH = CFG.thresholds || { warnRemainingPercent: 25, dangerRemainingPercent: 10 };
  const STALE_MS = (CFG.staleAfterSec || 600) * 1000;
  const RING_C = 2 * Math.PI * 15;
  // 侧栏图标样式：只影响外观，不影响数据与功能
  const STYLES = { ring: '圆环', hourglass: '沙漏', coffee: '咖啡', battery: '电池' };
  const hasChoice = (choices, value) => typeof value === 'string' && Object.hasOwn(choices, value);
  const STYLE_KEY = 'chatgpt-usage-visualizer:style';
  let style = (() => {
    try {
      let v = localStorage.getItem(STYLE_KEY);
      if (v === 'candle') v = 'battery'; // 旧版本的蜡烛样式已替换为电池
      if (hasChoice(STYLES, v)) return v;
    } catch {}
    return hasChoice(STYLES, CFG.style) ? CFG.style : 'ring';
  })();
  const prevRemaining = [], flowUntil = [];
  // 时间显示方式：距重置（倒计时）或截止时间（具体的重置时刻）
  const TIME_MODES = { countdown: '距重置', deadline: '截止时间' };
  const TIME_KEY = 'chatgpt-usage-visualizer:time';
  let timeMode = (() => {
    try { const v = localStorage.getItem(TIME_KEY); if (hasChoice(TIME_MODES, v)) return v; } catch {}
    return hasChoice(TIME_MODES, CFG.timeDisplay) ? CFG.timeDisplay : 'countdown';
  })();

  // 沙漏玻璃是收腰的，沙子高度和体积不成正比。按玻璃轮廓（与 iconMarkup 中的曲线一致）
  // 计算截面积，求出"剩余 f 时沙面应在的高度"，让看到的沙量与实际比例一致。
  const SAND_LEVEL = (() => {
    const P0 = [27.5, 4.5], P1 = [27, 15.5], P2 = [20, 19.5], P3 = [18, 26]; // 上半部右侧轮廓
    const pts = [];
    for (let k = 0; k <= 400; k++) {
      const t = k / 400, u = 1 - t;
      const x = u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0];
      const y = u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1];
      pts.push([y, x - 18]); // [高度, 半宽]
    }
    // 从瓶颈往上累计面积：area[k] = 从 pts[k] 的高度到瓶颈之间的沙子面积
    const area = new Array(pts.length).fill(0);
    for (let k = pts.length - 2; k >= 0; k--) {
      const dy = pts[k + 1][0] - pts[k][0];
      area[k] = area[k + 1] + dy * (pts[k][1] + pts[k + 1][1]); // 梯形，宽 = 2 × 半宽
    }
    const total = area[0];
    const lut = [];
    for (let i = 0; i <= 100; i++) {
      const target = total * i / 100;
      let k = pts.length - 1;
      while (k > 0 && area[k] < target) k--;
      const k1 = Math.min(k + 1, pts.length - 1);
      const span = area[k] - area[k1] || 1;
      const r = (area[k] - target) / span;
      lut.push(pts[k][0] + r * (pts[k1][0] - pts[k][0]));
    }
    return (f) => lut[Math.round(Math.max(0, Math.min(1, f)) * 100)];
  })();

  let state = null; // { windows, syncedAt, status, error, retryAt }
  let lastPushAt = 0; // 最近一次收到同步程序推送的时间，用于判断同步程序是否还在运行
  const helperAlive = () => lastPushAt && now() - lastPushAt < 120000;
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
  // 截止时间：今天显示"00:18"；明天或更晚分两行显示（"明天 / 00:18"、"周五 / 00:27"），适应窄侧栏
  function fmtDeadline(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000), t = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(t)) / 86400000);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (diff <= 0) return hm;
    return `${diff === 1 ? '明天' : '周' + '日一二三四五六'[d.getDay()]}\n${hm}`;
  }
  // 各样式的时间标签：倒计时模式用"距…"，截止时间模式用"…时间"
  const TIME_LABELS = {
    ring: ['距重置', '重置时间'],
    hourglass: ['距翻转', '翻转时间'],
    coffee: ['距续杯', '续杯时间'],
    battery: ['距充满', '充满时间'],
  };
  function railLabel() {
    const [cd, dl] = TIME_LABELS[style] || TIME_LABELS.ring;
    return timeMode === 'deadline' ? dl : cd;
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
    :host([data-theme="light"]) { --bolt:#EF9F27; --sand:#4A98E6; --sand2:#2A74C6; --wood1:#D7A56F; --wood2:#97683B; --glass:rgba(120,160,200,.10); --glassline:#9CAAB8; --fg:#2f3432; --muted:#6f7673; --track:#dde2df; --ok:#5e7f6b; --warn:#b7812f; --danger:#c0533f; --stale:#a3a9a6; --line:#e3e6e4; --card:#ffffff; --cardborder:#e6e8e7; --btnhover:#f1f3f2; }
    :host([data-theme="dark"]) { --bolt:#FAC775; --sand:#8CC2F2; --sand2:#5A9BDA; --wood1:#C9965F; --wood2:#86592F; --glass:rgba(160,190,225,.10); --glassline:#6F7C89; --fg:#e6e9e7; --muted:#9aa29e; --track:#3a3f3d; --ok:#86b097; --warn:#d9a65a; --danger:#e07d6a; --stale:#6c7370; --line:#3a3f3d; --card:#232625; --cardborder:#363a38; --btnhover:#2e3230; }
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
    .cd { font-size:10px; letter-spacing:-.2px; font-variant-numeric:tabular-nums; white-space:pre; text-align:center; line-height:1.35; color:var(--fg); }
    :host([data-compact]) .ring, :host([data-compact]) .ring svg { width:30px; height:30px; }
    :host([data-compact]) .ring .pct { font-size:9.5px; }
    :host([data-compact]) .lbl { font-size:10px; }
    .sep { width:70%; height:1px; background:var(--line); margin-top:2px; }
    .s-ok { stroke:var(--ok); } .s-warn { stroke:var(--warn); } .s-danger { stroke:var(--danger); } .s-stale { stroke:var(--stale); }
    .b-ok { background:var(--ok); } .b-warn { background:var(--warn); } .b-danger { background:var(--danger); } .b-stale { background:var(--stale); }
    .pop { position:fixed; inset:auto; margin:0; z-index:2147483000; width:240px; background:var(--card); border:1px solid var(--cardborder); border-radius:14px; padding:16px 16px 12px; box-shadow:0 8px 28px rgba(0,0,0,.14); color:var(--fg); }
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
    .ico { width:36px; display:flex; justify-content:center; }
    .ico svg { width:36px; height:auto; overflow:visible; }
    :host([data-compact]) .ico, :host([data-compact]) .ico svg { width:30px; }
    .pct2 { font-size:10.5px; font-variant-numeric:tabular-nums; color:var(--fg); margin-top:-1px; }
    .sand { transition: y .6s ease, height .6s ease; }
    .stream { stroke-dasharray:1.2 1.8; opacity:0; transition:opacity .3s, stroke-width .3s; }
    .stream.on { opacity:.75; animation: flow .5s linear infinite; }
    .stream.on.burst { opacity:1; stroke-width:1.4; animation-duration:.3s; }
    @keyframes flow { to { stroke-dashoffset:-6; } }
    .grain { transform-box:view-box; animation: fall 1s linear infinite; opacity:0; }
    .grain:nth-child(2) { animation-delay:.33s; }
    .grain:nth-child(3) { animation-delay:.66s; }
    @keyframes fall {
      0% { transform:translateY(0); opacity:0; }
      12% { opacity:1; }
      88% { opacity:1; }
      100% { transform:translateY(var(--fall)); opacity:0; }
    }
    .ico-hourglass svg, .ico-battery svg { width:29px; }
    :host([data-compact]) .ico-hourglass svg, :host([data-compact]) .ico-battery svg { width:24px; }
    .hgg { transform-box:fill-box; transform-origin:center; }
    .hgg.flip { animation: flip .9s cubic-bezier(.6,0,.3,1); }
    @keyframes flip { from { transform:rotate(0deg); } to { transform:rotate(180deg); } }
    .liq { transition: y .6s ease, height .6s ease; }
    .wisp { transform-box:fill-box; transform-origin:center bottom; opacity:0; animation: rise 2.6s ease-in infinite; }
    .wisp:nth-of-type(2) { animation-delay:.85s; }
    .wisp:nth-of-type(3) { animation-delay:1.7s; }
    @keyframes rise {
      0% { opacity:0; transform:translateY(5px) scaleX(1); }
      25% { opacity:1; }
      60% { transform:translateY(-3px) scaleX(-1); }
      100% { opacity:0; transform:translateY(-10px) scaleX(1); }
    }
    .bfill { transition: y .8s ease, height .8s ease, fill .4s; }
    .bfill.charging { animation: charge 1.6s ease-in-out infinite; }
    @keyframes charge { 50% { opacity:.55; } }
    .bolt { transition: opacity .3s; }
    .sty { display:flex; align-items:center; gap:6px; margin:-2px 0 10px; font-size:11.5px; color:var(--muted); }
    .sty span { white-space:nowrap; min-width:24px; }
    button:focus { outline:none; }
    button:focus-visible { outline:2px solid var(--ok); outline-offset:1px; }
    .sty button { flex:1; white-space:nowrap; font:inherit; font-size:11.5px; color:var(--fg); background:transparent; border:1px solid var(--cardborder); border-radius:7px; padding:3px 0; cursor:pointer; }
    .sty button:hover { background:var(--btnhover); }
    .sty button.on { border-color:var(--ok); color:var(--ok); }
    @media (prefers-reduced-motion: reduce) {
      .val, .bar i, .sand, .liq, .bfill { transition:none; }
      .stream.on, .hgg.flip, .wisp, .bfill.charging, .grain { animation:none; }
      .grain { opacity:0; }
      .wisp { opacity:.6; }
    }
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
      <div class="pop" popover="manual" hidden role="dialog" aria-label="剩余额度">
        <div class="hd"><span>剩余额度</span><button class="x" aria-label="关闭">×</button></div>
        <div class="body"></div><div class="sty"><span>样式</span>${Object.entries(STYLES).map(([k, v]) => `<button data-style="${k}">${v}</button>`).join('')}</div><div class="sty tm"><span>时间</span>${Object.entries(TIME_MODES).map(([k, v]) => `<button data-time="${k}">${v}</button>`).join('')}</div><div class="ftw"><div class="ft"></div><button class="rf" title="立即同步一次（不影响自动同步）">刷新</button></div>
      </div>`;
    const rail = root.querySelector('.rail');
    rail.addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
    rail.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePop(); } });
    root.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); togglePop(false); });
    root.querySelector('.rf').addEventListener('click', (e) => { e.stopPropagation(); manualRefresh(); });
    root.querySelectorAll('.sty button[data-style]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      style = b.dataset.style;
      try { localStorage.setItem(STYLE_KEY, style); } catch {}
      renderStructure();
    }));
    root.querySelectorAll('.sty button[data-time]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      timeMode = b.dataset.time;
      try { localStorage.setItem(TIME_KEY, timeMode); } catch {}
      renderStructure();
    }));
    renderStructure();
  }

  // 各样式的图标；id 带上序号，避免两个额度窗口的渐变和裁剪互相冲突
  function iconMarkup(i) {
    if (style === 'hourglass') return `
      <svg viewBox="0 0 36 52">
        <defs>
          <linearGradient id="wd${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--wood1)"/><stop offset="1" style="stop-color:var(--wood2)"/></linearGradient>
          <linearGradient id="sd${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" style="stop-color:var(--sand2)"/><stop offset=".45" style="stop-color:var(--sand)"/><stop offset="1" style="stop-color:var(--sand2)"/></linearGradient>
          <clipPath id="ht${i}"><path d="M8.5 4.5h19c-.5 11-7.5 15-9.5 21.5-2-6.5-9-10.5-9.5-21.5z"/></clipPath>
          <clipPath id="hb${i}"><path d="M8.5 47.5h19c-.5-11-7.5-15-9.5-21.5-2 6.5-9 10.5-9.5 21.5z"/></clipPath>
        </defs>
        <g class="hgg">
          <path d="M8 4c0 11 7.5 15.5 10 22-2.5 6.5-10 11-10 22h20c0-11-7.5-15.5-10-22 2.5-6.5 10-11 10-22z" fill="var(--glass)"/>
          <rect class="sand st" x="0" width="36" clip-path="url(#ht${i})"/>
          <rect class="sand sb" x="0" width="36" clip-path="url(#hb${i})"/>
          <path class="mound" clip-path="url(#hb${i})"/>
          <line class="stream" x1="18" y1="26" x2="18" stroke-width="1"/>
          <g class="grains"><circle class="grain" cx="18" cy="26.6" r=".75"/><circle class="grain" cx="18" cy="26.6" r=".75"/><circle class="grain" cx="18" cy="26.6" r=".75"/></g>
          <path d="M8 4c0 11 7.5 15.5 10 22-2.5 6.5-10 11-10 22M28 4c0 11-7.5 15.5-10 22 2.5 6.5 10 11 10 22" fill="none" stroke="var(--glassline)" stroke-width="1.1"/>
          <path d="M10.6 7.5c.6 5.2 2.6 8.6 4.6 11.2M10.6 44.5c.6-5.2 2.6-8.6 4.6-11.2" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1" stroke-linecap="round"/>
          <rect x="3.2" y="3.6" width="1.9" height="44.8" rx=".95" fill="url(#wd${i})"/>
          <rect x="30.9" y="3.6" width="1.9" height="44.8" rx=".95" fill="url(#wd${i})"/>
          <rect x="1.5" y="1" width="33" height="3.6" rx="1.8" fill="url(#wd${i})"/>
          <rect x="1.5" y="47.4" width="33" height="3.6" rx="1.8" fill="url(#wd${i})"/>
        </g>
      </svg>`;
    if (style === 'coffee') return `
      <svg viewBox="0 0 40 46">
        <g fill="none" stroke="var(--muted)" stroke-width="1.8" stroke-linecap="round">
          <path class="wisp" d="M14 12c-3-3 3-5 0-9"/><path class="wisp" d="M20 12.5c-3-3 3-5 0-9"/><path class="wisp" d="M26 12c-3-3 3-5 0-9"/>
        </g>
        <clipPath id="cp${i}"><path d="M7.5 15h25l-2.2 21a4 4 0 0 1-4 3.6H13.7a4 4 0 0 1-4-3.6z"/></clipPath>
        <rect class="liq" x="0" width="40" fill="#8B5A3C" clip-path="url(#cp${i})"/>
        <rect class="liq crema" x="0" width="40" height="2" fill="#C8996B" clip-path="url(#cp${i})"/>
        <path d="M7.5 15h25l-2.2 21a4 4 0 0 1-4 3.6H13.7a4 4 0 0 1-4-3.6z" fill="none" stroke="var(--fg)" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M32 19.5h2.5a4 4 0 0 1 0 8H31" fill="none" stroke="var(--fg)" stroke-width="1.6"/>
        <path d="M5 43h30" stroke="var(--fg)" stroke-width="1.6" stroke-linecap="round"/>
      </svg>`;
    if (style === 'battery') return `
      <svg viewBox="0 0 30 50">
        <clipPath id="bc${i}"><rect x="6" y="9" width="18" height="35" rx="3.5"/></clipPath>
        <rect x="10.5" y="1.5" width="9" height="4" rx="1.6" fill="var(--fg)" opacity=".55"/>
        <rect x="3" y="5.5" width="24" height="42" rx="6.5" fill="none" stroke="var(--fg)" stroke-width="2"/>
        <rect class="bfill" x="6" width="18" clip-path="url(#bc${i})"/>
        <path class="bolt" d="M16.8 16 10.5 28.2h4.6L13.2 37.5 19.5 25.3h-4.6z" fill="var(--bolt)" stroke="var(--fg)" stroke-width=".7" stroke-linejoin="round"/>
      </svg>`;
    return `<div class="ring"><svg viewBox="0 0 36 36"><circle class="trk" cx="18" cy="18" r="15" fill="none" stroke-width="3.2"/>
            <circle class="val" cx="18" cy="18" r="15" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(2)}"/></svg>
            <span class="pct"></span></div>`;
  }

  // 按剩余比例更新图标
  function updateIcon(el, w, i) {
    const f = Math.max(0, Math.min(100, w.remaining)) / 100;
    const prev = prevRemaining[i];
    if (prev !== undefined && w.remaining < prev) flowUntil[i] = now() + 4000;
    const reset = prev !== undefined && w.remaining >= prev + 15;
    prevRemaining[i] = w.remaining;
    const pct2 = el.querySelector('.pct2');
    if (pct2) pct2.textContent = `${w.remaining}%`;
    const color = w.lv === 'stale' ? 'var(--stale)' : w.lv === 'danger' ? 'var(--danger)' : null;

    if (style === 'hourglass') {
      const sand = color || `url(#sd${i})`;
      const st = el.querySelector('.st'), sb = el.querySelector('.sb'), stream = el.querySelector('.stream');
      // 上半部：沙面高度 topY，沙子从沙面一直到瓶颈；下半部与之镜像对称（以 y=26 为轴）
      const topY = SAND_LEVEL(f), botY = 52 - SAND_LEVEL(f);
      st.setAttribute('y', topY); st.setAttribute('height', Math.max(0.01, 26 - topY)); st.setAttribute('fill', sand);
      sb.setAttribute('y', botY); sb.setAttribute('height', Math.max(0.01, 48 - botY)); sb.setAttribute('fill', sand);
      // 下半部沙堆顶上的小沙丘
      const mound = el.querySelector('.mound');
      mound.setAttribute('d', f < 0.98 ? `M8 ${botY + 0.2}Q18 ${botY - 2.6} 28 ${botY + 0.2}Z` : '');
      mound.setAttribute('fill', sand);
      // 漏沙：只要上面还有沙子，就持续落下细沙；刚被消耗时沙流更明显
      const falling = f > 0.005;
      const fallTo = Math.max(27.5, (f < 0.98 ? botY - 1.6 : botY) - 0.5);
      stream.setAttribute('y2', fallTo);
      stream.setAttribute('stroke', color || 'var(--sand)');
      stream.classList.toggle('on', falling);
      stream.classList.toggle('burst', falling && now() < (flowUntil[i] || 0));
      const grains = el.querySelector('.grains');
      grains.style.setProperty('--fall', `${(fallTo - 26.6).toFixed(2)}px`);
      grains.style.display = falling ? '' : 'none';
      grains.querySelectorAll('.grain').forEach((g) => g.setAttribute('fill', color || 'var(--sand)'));
      if (reset) { const g = el.querySelector('.hgg'); g.classList.remove('flip'); void g.getBBox(); g.classList.add('flip'); setTimeout(() => g.classList.remove('flip'), 950); }
    } else if (style === 'coffee') {
      const top = 15 + 24.6 * (1 - f);
      el.querySelectorAll('.liq').forEach((r) => {
        if (r.classList.contains('crema')) r.setAttribute('y', top);
        else { r.setAttribute('y', top); r.setAttribute('height', 24.6 * f + 0.01); }
      });
      el.querySelector('.crema').style.opacity = f > 0.02 ? 1 : 0;
      const wisps = f >= 0.6 ? 3 : f >= 0.3 ? 2 : f > 0 ? 1 : 0;
      el.querySelectorAll('.wisp').forEach((p, k) => { p.style.display = k < wisps ? '' : 'none'; });
    } else if (style === 'battery') {
      const fill = el.querySelector('.bfill'), h = 35 * f;
      fill.setAttribute('y', 44 - h); fill.setAttribute('height', Math.max(0.01, h));
      fill.setAttribute('fill', color || (w.lv === 'warn' ? 'var(--warn)' : 'var(--ok)'));
      // 距重置 10 分钟内显示闪电，表示马上"充满"
      const charging = w.secs !== null && w.secs > 0 && w.secs <= 600;
      el.querySelector('.bolt').style.opacity = charging ? 1 : 0;
      fill.classList.toggle('charging', charging);
    } else {
      const v = el.querySelector('.val');
      v.setAttribute('class', `val s-${w.lv}`);
      v.style.strokeDashoffset = (RING_C * (1 - f)).toFixed(2);
      el.querySelector('.pct').textContent = `${w.remaining}%`;
    }
  }

  function renderStructure() {
    if (!root) return;
    const ws = windowsView();
    const rail = root.querySelector('.rail');
    rail.innerHTML = ws.length
      ? ws.map((w, i) => `
        <div class="w" data-i="${i}">
          <span class="lbl">${w.label}</span>
          ${style === 'ring' ? iconMarkup(i) : `<div class="ico ico-${style}">${iconMarkup(i)}</div><span class="pct2"></span>`}
          <span class="lbl">${railLabel()}</span><span class="cd"></span>
        </div>`).join('') + '<div class="sep"></div>'
      : `<div class="w"><span class="lbl">额度</span><span class="cd">同步中…</span></div><div class="sep"></div>`;
    root.querySelectorAll('.sty button[data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === style));
    root.querySelectorAll('.sty button[data-time]').forEach((b) => b.classList.toggle('on', b.dataset.time === timeMode));
    prevRemaining.length = 0;
    root.querySelector('.body').innerHTML = ws.map((w, i) => `
      <div class="blk" data-i="${i}">
        <div class="top"><span>${w.label}额度</span><span class="big"><span class="n"></span>%<small>剩余</small></span></div>
        <div class="bar"><i></i></div>
        <div class="row"><span>${railLabel()}</span><b class="cdf"></b></div>
        <div class="row"><span class="at"></span></div>
      </div>`).join('');
    tick();
  }

  function tick() {
    if (!root) return;
    host.setAttribute('data-theme', isDark() ? 'dark' : 'light');
    const ws = windowsView();
    if (!ws.length) {
      const cd = root.querySelector('.rail .cd');
      if (cd) cd.textContent = state && state.error ? '同步失败'
        : !state || !state.syncedAt ? '同步中…'
        : now() - state.syncedAt > STALE_MS ? '数据已过期' : '无限制';
    }
    ws.forEach((w, i) => {
      const r = root.querySelector(`.rail .w[data-i="${i}"]`);
      if (r) {
        updateIcon(r, w, i);
        const compact = host.hasAttribute('data-compact');
        r.querySelector('.cd').textContent = timeMode === 'deadline' && !(w.secs !== null && w.secs <= 0)
          ? fmtDeadline(w.resetsAt) : fmtRail(w.secs, compact);
      }
      const b = root.querySelector(`.body .blk[data-i="${i}"]`);
      if (b) {
        b.querySelector('.n').textContent = w.remaining;
        const bar = b.querySelector('.bar i');
        bar.className = `b-${w.lv}`;
        bar.style.width = `${Math.max(0, Math.min(100, w.remaining))}%`;
        if (timeMode === 'deadline') {
          b.querySelector('.cdf').textContent = w.secs !== null && w.secs <= 0 ? '重置中…' : fmtResetAt(w.resetsAt).replace(' 重置', '');
          b.querySelector('.at').textContent = w.secs !== null && w.secs > 0 ? `还有 ${fmtFull(w.secs)}` : '';
        } else {
          b.querySelector('.cdf').textContent = fmtFull(w.secs);
          b.querySelector('.at').textContent = fmtResetAt(w.resetsAt);
        }
      }
    });
    const ft = root.querySelector('.ft');
    if (lastPushAt && !helperAlive()) {
      ft.className = 'ft err';
      ft.textContent = '同步程序已停止，请退出 Codex 后从程序坞重新打开';
    } else if (!state || !state.syncedAt) {
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
    if (state && state.syncedAt && src && helperAlive()) ft.textContent += src;
    const rf = root.querySelector('.rf');
    rf.disabled = refreshing || typeof window.__codexUsageRefresh !== 'function' || (lastPushAt && !helperAlive());
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
    if (popOpen) pop.hidden = false;
    // 顶层弹窗不受侧栏的 contain:paint / overflow 裁剪，收起侧栏时也可显示。
    if (typeof pop.showPopover === 'function') {
      if (popOpen && !pop.matches(':popover-open')) pop.showPopover();
      else if (!popOpen && pop.matches(':popover-open')) pop.hidePopover();
    }
    if (popOpen) placePop();
    else pop.hidden = true;
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
    // 脱离文档会让浏览器关闭顶层弹窗；重挂载前同步逻辑状态，避免下一次点击只关不弹。
    if (host && popOpen) togglePop(false);
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
      lastPushAt = now();
      refreshDone();
      const prevCount = state && state.windows ? state.windows.length : -1;
      state = payload;
      const count = payload && payload.windows ? payload.windows.length : 0;
      // 窗口数量变化（例如只有每周额度的套餐），或没有任何额度窗口时，重建结构
      if (count !== prevCount || count === 0) renderStructure(); else tick();
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
