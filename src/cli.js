// 命令行公共工具：参数解析、日志、配置
import { loadConfig } from './config.js';

export const args = process.argv.slice(2);
export const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'help';
export const flag = (name) => args.includes(`--${name}`);
export const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
export const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
export const log = (m) => console.log(`[${ts()}] ${m}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildConfig() {
  const o = {};
  if (opt('port')) o.debugPort = Number(opt('port'));
  if (opt('app')) o.appNames = [opt('app')];
  if (opt('codex-bin')) o.codexBin = opt('codex-bin');
  return loadConfig(o);
}
