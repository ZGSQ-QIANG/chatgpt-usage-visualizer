#!/usr/bin/env node
// 模拟 `codex app-server`，用于测试
import readline from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'account/rateLimits/read') {
    out({ id: m.id, result: { rateLimits: {
      primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1793809099 },
      secondary: { usedPercent: 54, windowDurationMins: 10080, resetsAt: 1793896079 },
      planType: 'plus' } } });
    out({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1793809099 } } } });
  }
});
