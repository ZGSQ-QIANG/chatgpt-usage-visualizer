import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import { cleanupLegacyMenubar } from '../src/legacy.js';
import { isOurLauncher, installLauncherApp } from '../src/launcher.js';
import { runningCommands, codexBusy } from '../src/busy.js';
import { isOwnedApp, readPlistString } from '../src/ownership.js';

const HOME = os.homedir();
const APP = path.join(HOME, 'Applications', 'ChatGPT Usage.app');
const AGENT = path.join(HOME, 'Library', 'LaunchAgents', 'local.chatgpt-usage-visualizer.menubar.plist');
const LABEL = 'local.chatgpt-usage-visualizer.menubar';
const LAUNCHER_ID = 'local.chatgpt-usage-visualizer.launcher';

function fakeArtifacts(t, { appId = 'unrelated.app', agentLabel = null, symlink = false, linkedPlist = false, malformed = false } = {}) {
  const removed = [], commands = [], writes = [];
  const plist = path.join(APP, 'Contents', 'Info.plist');
  const existing = new Set([APP, path.dirname(plist), plist]);
  if (agentLabel !== null) existing.add(AGENT);
  t.mock.method(fs, 'existsSync', (p) => existing.has(p));
  t.mock.method(fs, 'lstatSync', (p) => {
    if (!existing.has(p)) throw new Error('not found');
    return { isDirectory: () => p === APP || p === path.dirname(plist), isFile: () => p === plist || p === AGENT,
      isSymbolicLink: () => symlink && (p === APP || p === AGENT) };
  });
  t.mock.method(fs, 'realpathSync', (p) => symlink || (linkedPlist && p === plist) ? path.join(HOME, 'Other.app') : p);
  t.mock.method(fs, 'readFileSync', (p) => {
    if (p === plist) return malformed ? 'invalid plist' : `<plist><dict><key>CFBundleIdentifier</key><string>${appId}</string><key>Note</key><string>${LAUNCHER_ID}</string></dict></plist>`;
    if (p === AGENT) return `<plist><dict><key>Label</key><string>${agentLabel}</string></dict></plist>`;
    throw new Error('unexpected read');
  });
  t.mock.method(fs, 'rmSync', (p, options) => removed.push({ path: p, options }));
  t.mock.method(fs, 'readdirSync', () => []);
  for (const name of ['mkdirSync', 'writeFileSync', 'copyFileSync', 'chmodSync']) {
    t.mock.method(fs, name, (...args) => writes.push({ name, args }));
  }
  t.mock.method(childProcess, 'spawnSync', (...args) => { commands.push(args); return { status: 0 }; });
  t.mock.method(childProcess, 'execFileSync', (_bin, args) => {
    if (malformed) throw new Error('invalid plist');
    const file = args.at(-1);
    if (file === plist) return appId;
    if (file === AGENT) return agentLabel;
    throw new Error('unexpected plist');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { removed, commands, writes };
}

test('legacy cleanup preserves unrelated same-name apps and foreign LaunchAgents', (t) => {
  const io = fakeArtifacts(t, { agentLabel: 'unrelated.agent' });
  assert.equal(cleanupLegacyMenubar(), false);
  assert.deepEqual(io.removed, []);
  assert.deepEqual(io.commands, []);
});

test('legacy cleanup removes only the separately verified owned app', (t) => {
  const io = fakeArtifacts(t, { appId: LABEL, agentLabel: 'unrelated.agent' });
  assert.equal(cleanupLegacyMenubar(), true);
  assert.deepEqual(io.removed.map((x) => x.path), [APP]);
  assert.deepEqual(io.commands, []);
});

test('legacy cleanup removes only the separately verified owned agent', (t) => {
  const io = fakeArtifacts(t, { agentLabel: LABEL });
  assert.equal(cleanupLegacyMenubar(), true);
  assert.deepEqual(io.removed.map((x) => x.path), [AGENT]);
  assert.equal(io.commands.length, 1);
});

for (const options of [{ symlink: true }, { linkedPlist: true }, { malformed: true }]) {
  test(`legacy cleanup preserves ${options.symlink ? 'symbolic links' : options.linkedPlist ? 'linked inner plists' : 'malformed identities'}`, (t) => {
    const io = fakeArtifacts(t, { appId: LABEL, agentLabel: options.linkedPlist ? 'unrelated.agent' : LABEL, ...options });
    assert.equal(cleanupLegacyMenubar(), false);
    assert.deepEqual(io.removed, []);
    assert.deepEqual(io.commands, []);
  });
}

test('launcher ownership requires the exact bundle identifier, not a string elsewhere in the plist', (t) => {
  fakeArtifacts(t);
  assert.equal(isOurLauncher(APP), false);
});

test('real plist ownership parsing rejects a dictionary and whitespace around the identifier', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ownership-')));
  const app = path.join(dir, 'Fixture.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  const file = path.join(app, 'Contents', 'Info.plist');
  const write = (value) => fs.writeFileSync(file, `<plist version="1.0"><dict><key>CFBundleIdentifier</key>${value}</dict></plist>`);
  write(`<dict><key>${LAUNCHER_ID}</key><string>unrelated</string></dict>`);
  assert.equal(isOwnedApp(app, [LAUNCHER_ID]), false);
  write(`<string> ${LAUNCHER_ID} </string>`);
  assert.equal(isOwnedApp(app, [LAUNCHER_ID]), false);
  write(`<string>${LAUNCHER_ID}</string>`);
  assert.equal(isOwnedApp(app, [LAUNCHER_ID]), true);
  assert.equal(readPlistString(file, 'Missing'), null);
  const notApp = path.join(dir, 'NotAnApp.app');
  fs.writeFileSync(notApp, 'not an application directory');
  assert.equal(isOwnedApp(notApp, [LAUNCHER_ID]), false);
  assert.equal(readPlistString(path.join(app, 'Contents'), 'CFBundleIdentifier'), null);
});

test('launcher rejects names that escape its application directory before any cleanup', (t) => {
  const io = fakeArtifacts(t);
  assert.throws(() => installLauncherApp({ app: { name: 'Synthetic', path: '/Applications/Synthetic.app' },
    name: '../Elsewhere', nodePath: '/synthetic/node', toolPath: '/synthetic/tool.js' }));
  assert.deepEqual(io.removed, []);
  assert.deepEqual(io.writes, []);
});

const CLIENT = '/Applications/Synthetic App.app';
const procs = () => [
  { pid: 1, ppid: 0, age: 3600, command: `${CLIENT}/Contents/MacOS/Synthetic` },
  { pid: 2, ppid: 1, age: 3590, command: `${CLIENT}/Contents/Resources/codex app-server` },
];

test('active tasks started early are busy regardless of age or grace setting', () => {
  const ps = [...procs(), { pid: 3, ppid: 2, age: 3500, command: '/usr/bin/node synthetic-build.js' }];
  assert.deepEqual(runningCommands(CLIENT, ps).map((p) => p.pid), [3]);
  assert.deepEqual(runningCommands(CLIENT, ps, 100000).map((p) => p.pid), [3]);
});

test('known MCP services are ignored but their unknown workload children stay busy', () => {
  const ps = [...procs(),
    { pid: 3, ppid: 2, age: 3585, command: 'npx @modelcontextprotocol/server-filesystem /synthetic' },
    { pid: 4, ppid: 3, age: 3580, command: '/bin/sh synthetic-build.sh' },
  ];
  assert.deepEqual(runningCommands(CLIENT, ps).map((p) => p.pid), [4]);
});

test('unknown long-lived services and processes without age information stay busy', () => {
  const ps = [...procs(), { pid: 3, ppid: 2, age: null, command: 'npx custom-background-worker' }];
  assert.deepEqual(runningCommands(CLIENT, ps).map((p) => p.pid), [3]);
});

test('failed process discovery is unknown and must not permit automatic restart', (t) => {
  t.mock.method(fs, 'readdirSync', () => []);
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('process discovery failed'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(codexBusy({ path: CLIENT }, { sessionsDir: '/synthetic', busy: {} }).busy, true);
});

const commandsSource = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8');
const ensureSource = commandsSource.slice(commandsSource.indexOf('async function ensureDebugApp('), commandsSource.indexOf('\nexport async function start('));
function restartHarness({ busy = false, choices = [], idleResult = 'idle' } = {}) {
  const calls = { dialogs: [], quits: 0, launches: 0, waits: 0 };
  const cancelled = Symbol('cancelled');
  const cfg = { appNames: ['Synthetic'], debugPort: 9222 };
  const context = {
    CANCELLED: cancelled, TITLE: 'Synthetic widget',
    findApp: () => ({ name: 'Synthetic', path: '/Applications/Synthetic.app' }),
    isPortOpen: async () => false, isRunning: () => true,
    codexBusy: () => ({ busy, reason: busy ? 'synthetic task' : '' }),
    askDialog: (opts) => { calls.dialogs.push(opts); return choices.shift() ?? null; },
    waitUntilIdle: async () => { calls.waits++; return idleResult; },
    quitApp: async () => { calls.quits++; return true; },
    launchWithPort: async () => { calls.launches++; return true; },
    spawnSync: () => ({ status: 0 }), log() {}, notify() {}, confirm: async () => false,
  };
  vm.runInNewContext(`${ensureSource};globalThis.run=ensureDebugApp`, context);
  return { calls, cancelled, run: () => context.run(cfg, { withApp: true }) };
}

test('launcher never silently restarts a running app even when heuristics report idle', async () => {
  const h = restartHarness();
  assert.equal(await h.run(), h.cancelled);
  assert.equal(h.calls.quits, 0);
  assert.equal(h.calls.dialogs.length, 1);
  assert.equal(h.calls.dialogs[0].defaultButton, h.calls.dialogs[0].cancelButton);
});

test('launcher explicit restart confirmation still works', async () => {
  const h = restartHarness({ choices: ['立即重启'] });
  await h.run();
  assert.equal(h.calls.quits, 1);
  assert.equal(h.calls.launches, 1);
});

test('waiting for idle requires a second explicit confirmation before quitting', async () => {
  const h = restartHarness({ busy: true, choices: ['任务完成后确认重启', '稍后手动重启'] });
  assert.equal(await h.run(), h.cancelled);
  assert.equal(h.calls.waits, 1);
  assert.equal(h.calls.dialogs.length, 2);
  assert.equal(h.calls.quits, 0);
});

test('waiting stops if the app has already quit', async () => {
  const h = restartHarness({ busy: true, choices: ['任务完成后确认重启'], idleResult: 'quit' });
  assert.equal(await h.run(), h.cancelled);
  assert.equal(h.calls.dialogs.length, 1);
  assert.equal(h.calls.quits, 0);
  assert.equal(h.calls.launches, 0);
});

test('dismissing the confirmation after waiting never quits the app', async () => {
  const h = restartHarness({ busy: true, choices: ['任务完成后确认重启', null] });
  assert.equal(await h.run(), h.cancelled);
  assert.equal(h.calls.dialogs[1].defaultButton, h.calls.dialogs[1].cancelButton);
  assert.equal(h.calls.quits, 0);
});

test('explicit confirmation after waiting can restart the app', async () => {
  const h = restartHarness({ busy: true, choices: ['任务完成后确认重启', '立即重启'] });
  await h.run();
  assert.equal(h.calls.quits, 1);
  assert.equal(h.calls.launches, 1);
});
