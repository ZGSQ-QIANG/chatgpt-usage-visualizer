// 把不同来源、不同命名风格（驼峰 / 下划线）的额度数据统一成一种结构
// 输出：{ primary, secondary, planType }，每个窗口为 { usedPercent, windowMinutes, resetsAt(秒) } 或 null

const pick = (o, ...keys) => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function normWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const used = Number(pick(w, 'usedPercent', 'used_percent'));
  const minutes = Number(pick(w, 'windowDurationMins', 'window_minutes', 'windowMinutes'));
  let resetsAt = pick(w, 'resetsAt', 'resets_at');
  if (resetsAt === undefined) {
    const inSec = pick(w, 'resetsInSeconds', 'resets_in_seconds');
    if (inSec !== undefined) resetsAt = Math.floor(Date.now() / 1000) + Number(inSec);
  }
  resetsAt = Number(resetsAt);
  if (!Number.isFinite(used)) return null;
  // 兼容毫秒时间戳
  if (resetsAt > 1e12) resetsAt = Math.floor(resetsAt / 1000);
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowMinutes: Number.isFinite(minutes) ? minutes : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

// 接受：app-server 的 { rateLimits: {...} }、通知 params、或会话记录里的 rate_limits 对象
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rl = raw.rateLimits || raw.rate_limits || raw;
  const out = {};
  if ('primary' in rl) out.primary = normWindow(rl.primary);
  if ('secondary' in rl) out.secondary = normWindow(rl.secondary);
  const plan = pick(rl, 'planType', 'plan_type');
  if (plan !== undefined) out.planType = plan;
  if (!('primary' in out) && !('secondary' in out)) return null;
  return out;
}

// 稀疏通知：只覆盖收到的字段
export function mergeSnapshot(prev, next) {
  if (!next) return prev;
  if (!prev) return { primary: null, secondary: null, ...next };
  return { ...prev, ...next };
}

// 按窗口时长决定显示名称，不依赖 primary/secondary 的顺序
export function windowLabel(minutes) {
  if (!minutes) return '额度';
  if (minutes >= 10000 && minutes <= 10200) return '每周';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function toDisplayWindows(snapshot) {
  if (!snapshot) return [];
  return ['primary', 'secondary']
    .map((k) => snapshot[k])
    .filter(Boolean)
    .sort((a, b) => (a.windowMinutes || 0) - (b.windowMinutes || 0))
    .map((w) => ({ ...w, label: windowLabel(w.windowMinutes) }));
}
