#!/usr/bin/env node
// 模拟 `codex app-server`，用于测试
import fs from 'node:fs';
import readline from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'account/rateLimits/read' && process.env.FAKE_FAIL_FILE && fs.existsSync(process.env.FAKE_FAIL_FILE)) {
    out({ id: m.id, error: { code: -1, message: 'failed to fetch codex rate limits: error sending request' } });
    return;
  }
  if (m.method === 'account/rateLimits/read') {
    out({ id: m.id, result: { rateLimits: {
      primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1793809099 },
      secondary: { usedPercent: 54, windowDurationMins: 10080, resetsAt: 1793896079 },
      planType: 'plus' } } });
    out({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1793809099 } } } });
  }
});
