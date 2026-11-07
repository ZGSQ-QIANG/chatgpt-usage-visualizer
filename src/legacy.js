// 清理旧版本留下的文件（例如已移除的菜单栏模式），安装和卸载时调用
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOwnedApp, readPlistString } from './ownership.js';

const HOME = os.homedir();
const MENUBAR_LABEL = 'local.chatgpt-usage-visualizer.menubar';
const MENUBAR_APP = path.join(HOME, 'Applications', 'ChatGPT Usage.app');
const MENUBAR_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${MENUBAR_LABEL}.plist`);

// 返回是否清理了任何东西
export function cleanupLegacyMenubar() {
  const appOwned = isOwnedApp(MENUBAR_APP, [MENUBAR_LABEL]);
  const agentOwned = readPlistString(MENUBAR_PLIST, 'Label') === MENUBAR_LABEL;
  if (agentOwned) {
    spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${MENUBAR_LABEL}`], { stdio: 'ignore' });
    fs.rmSync(MENUBAR_PLIST, { force: true });
  }
  if (appOwned) fs.rmSync(MENUBAR_APP, { recursive: true, force: true });
  return appOwned || agentOwned;
}
