import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runningCommands } from '../src/busy.js';
import { psQuote, encoded, runPowerShell, installWindowsLauncher, windowsLaunchers,
  uninstallWindowsLauncher, relaunchWindowsLater, getWindowsLog, parsePowerShellList } from '../src/windows.js';

test('PowerShell zero, one and multiple results remain iterable lists', () => {
  assert.deepEqual(parsePowerShellList(''), []);
  assert.deepEqual(parsePowerShellList('null'), []);
  assert.deepEqual(parsePowerShellList('"C:\\\\Apps"'), ['C:\\Apps']);
  assert.deepEqual(parsePowerShellList('{"pid":1}'), [{ pid: 1 }]);
  assert.deepEqual(parsePowerShellList('["a","b"]'), ['a', 'b']);
});

test('PowerShell quoting preserves Unicode, apostrophes, and shell metacharacters', () => {
  const value = "D:\\开发 空间\\O'Brien\\$(no)&`tool";
  assert.equal(psQuote(value), "'D:\\开发 空间\\O''Brien\\$(no)&`tool'");
  assert.equal(Buffer.from(encoded(value), 'base64').toString('utf16le'), value);
});

test('Windows busy detection follows updated CLI outside Store package', () => {
  const app = 'C:\\Program Files\\WindowsApps\\Codex\\app\\ChatGPT.exe';
  const procs = [
    { pid: 1, ppid: 0, age: 1000, executable: app },
    { pid: 2, ppid: 1, age: 990, executable: 'C:\\Users\\Test\\AppData\\Local\\OpenAI\\Codex\\codex.exe' },
    { pid: 3, ppid: 2, age: 985, executable: 'C:\\node.exe', command: 'node mcp' },
    { pid: 4, ppid: 2, age: 5, executable: 'C:\\Windows\\System32\\cmd.exe', command: 'cmd /c build' },
  ];
  assert.deepEqual(runningCommands(app, procs).map((p) => p.pid), [4]);
  assert.deepEqual(runningCommands(app, [{ pid: 5, executable: null, command: null }]), []);
});

test('Windows shortcut round trip launches hidden Node with exact arguments and removes only owned files',
  { skip: process.platform !== 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-中文 O'Brien "));
    const oldEnv = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
    process.env.APPDATA = dir;
    process.env.LOCALAPPDATA = dir;
    try {
      const result = path.join(dir, 'result.json');
      const tool = path.join(dir, 'fake tool.js');
      fs.writeFileSync(tool, `require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify(process.argv.slice(2)));`);
      const app = { name: 'Codex', path: process.execPath };
      const options = { app, nodePath: process.execPath, toolPath: tool, name: '额度测试', extraArgs: ['--app', "C:\\开发 空间\\O'Brien\\Codex.exe", '--port', '9444'] };
      const installed = installWindowsLauncher(options);
      assert.deepEqual(windowsLaunchers(), [installed.path]);
      // Shell Link header ShowCommand is SW_SHOWMINNOACTIVE (7).
      assert.equal(fs.readFileSync(installed.path).readUInt32LE(60), 7);
      relaunchWindowsLater(installed.path, 0);
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(result) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(result), fs.existsSync(getWindowsLog()) ? fs.readFileSync(getWindowsLog(), 'utf16le') : 'Shortcut did not launch; no log created');
      assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), ['start', '--with-app', '--yes', ...options.extraArgs]);
      const replacement = installWindowsLauncher({ ...options, name: '第二个' });
      assert.equal(fs.existsSync(installed.path), false);
      assert.deepEqual(windowsLaunchers(), [replacement.path]);
      const unrelated = path.join(path.dirname(replacement.path), 'Other (Usage).lnk');
      fs.writeFileSync(unrelated, 'not ours');
      assert.throws(() => installWindowsLauncher({ ...options, name: 'Other' }), /已存在/);
      uninstallWindowsLauncher();
      assert.deepEqual(windowsLaunchers(), []);
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'not ours');
      assert.throws(() => installWindowsLauncher({ ...options, name: '../invalid' }), /无效字符/);
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
