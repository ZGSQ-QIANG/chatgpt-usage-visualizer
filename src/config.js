import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const USER_CONFIG_PATH = path.join(os.homedir(), '.chatgpt-usage-visualizer', 'config.json');
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.codex-usage-countdown', 'config.json');

export function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra) || typeof base !== 'object' || typeof extra !== 'object' || !base || !extra) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(base[k], v);
  return out;
}

// 读取默认配置，再用 ~/.chatgpt-usage-visualizer/config.json 覆盖（只需写想改的字段）
export function loadConfig(cliOverrides = {}) {
  const defaults = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'default.json'), 'utf8'));
  let user = {};
  // 兼容旧项目名的配置文件
  const file = fs.existsSync(USER_CONFIG_PATH) ? USER_CONFIG_PATH : fs.existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : null;
  if (file) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn(`[配置] 无法解析 ${file}，已忽略：${e.message}`);
    }
  }
  const cfg = deepMerge(deepMerge(defaults, user), cliOverrides);
  cfg.sessionsDir = expandHome(cfg.sessionsDir);
  return cfg;
}
