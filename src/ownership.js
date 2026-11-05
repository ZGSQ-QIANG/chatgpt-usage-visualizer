import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 清理前读取真实 plist 字段；未知格式、符号链接和无法读取的文件均不视为本工具所有。
export function readPlistString(file, key) {
  try {
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) return null;
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-expect', 'string', '-n', '-o', '-', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
  } catch {
    return null;
  }
}

export function isOwnedApp(appPath, identifiers) {
  try {
    if (!fs.lstatSync(appPath).isDirectory() || fs.realpathSync(appPath) !== path.resolve(appPath)) return false;
    return identifiers.includes(readPlistString(path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleIdentifier'));
  } catch {
    return false;
  }
}
