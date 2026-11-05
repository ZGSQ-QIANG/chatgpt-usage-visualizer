import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const original = fs.readFileSync(new URL('../src/widget.js', import.meta.url), 'utf8');
// Expose closure functions in the VM only; production keeps its existing API.
const source = original.replace(/\}\)\(\);\s*$/, `
  globalThis.widgetTest = {
    preferences: () => ({ style, timeMode, label: railLabel() }),
    renderStructure, tick,
    setState: (value) => { state = value; },
    setNodes: (h, r) => { host = h; root = r; },
  };
})();`);
assert.notEqual(source, original, 'The widget IIFE must be available to the VM');

function widget({ config = {}, stored = {}, storageError = false } = {}) {
  let clock = 1_000_000;
  class Clock extends Date {
    static now() { return clock; }
  }
  const context = vm.createContext({
    window: { __codexUsageConfig: config },
    document: { readyState: 'loading', addEventListener() {} },
    localStorage: {
      getItem(key) {
        if (storageError) throw new Error('Storage unavailable');
        return stored[key.split(':').at(-1)] ?? null;
      },
    },
    Date: Clock,
    getComputedStyle: () => ({ color: 'rgb(0, 0, 0)' }),
    clearTimeout() {},
    setTimeout() {},
  });
  vm.runInContext(source, context);
  const api = context.widgetTest;
  // This minimal DOM stores the actual markup and text written by the widget.
  const cd = { textContent: '' };
  const rail = {
    markup: '',
    set innerHTML(value) {
      this.markup = value;
      cd.textContent = value.match(/<span class="cd">([^<]*)<\/span>/)?.[1] ?? '';
    },
    get innerHTML() {
      return this.markup.replace(/(<span class="cd">)[^<]*(<\/span>)/, `$1${cd.textContent}$2`);
    },
    querySelector: (selector) => selector === '.cd' ? cd : null,
  };
  const nodes = { '.rail': rail, '.rail .cd': cd, '.body': {}, '.ft': {}, '.rf': {} };
  api.setNodes({ setAttribute() {} }, {
    querySelector: (selector) => nodes[selector] ?? null,
    querySelectorAll: () => [],
  });
  return { api, nodes, cd, update: context.window.__codexUsageCountdown.update,
    setClock: (value) => { clock = value; } };
}

const invalid = ['toString', 'constructor', '__proto__', 'unknown', '', null, 12, true, {}, ['ring']];

test('malformed configured styles fall back to the ring without throwing', () => {
  for (const value of invalid) {
    const { api } = widget({ config: { style: value } });
    const prefs = api.preferences();
    assert.equal(prefs.style, 'ring', `Configured style ${JSON.stringify(value)}`);
    assert.equal(prefs.label, '距重置');
  }
});

test('malformed stored styles fall back to a valid configured style', () => {
  for (const value of invalid) {
    const { api } = widget({ config: { style: 'coffee' }, stored: { style: value } });
    assert.equal(api.preferences().style, 'coffee', `Stored style ${JSON.stringify(value)}`);
    assert.equal(api.preferences().label, '距续杯');
  }
});

test('malformed configured time modes fall back to countdown', () => {
  for (const value of [...invalid, ['deadline']]) {
    const { api } = widget({ config: { timeDisplay: value } });
    assert.equal(api.preferences().timeMode, 'countdown', `Configured time ${JSON.stringify(value)}`);
  }
});

test('malformed stored time modes fall back to a valid configured time mode', () => {
  for (const value of [...invalid, ['deadline']]) {
    const { api } = widget({ config: { timeDisplay: 'deadline' }, stored: { time: value } });
    assert.equal(api.preferences().timeMode, 'deadline', `Stored time ${JSON.stringify(value)}`);
    assert.equal(api.preferences().label, '重置时间');
  }
});

test('valid styles render their expected labels in both time modes', () => {
  const labels = { ring: ['距重置', '重置时间'], hourglass: ['距翻转', '翻转时间'],
    coffee: ['距续杯', '续杯时间'], battery: ['距充满', '充满时间'] };
  for (const [style, values] of Object.entries(labels)) {
    for (const [index, timeDisplay] of ['countdown', 'deadline'].entries()) {
      for (const options of [{ config: { style, timeDisplay } },
        { stored: { style, time: timeDisplay } }]) {
        const { api, nodes } = widget(options);
        assert.equal(api.preferences().style, style);
        assert.equal(api.preferences().timeMode, timeDisplay);
        api.setState({ windows: [{ label: 'Test', usedPercent: 25, resetsAt: 2000 }], syncedAt: 1_000_000 });
        api.renderStructure();
        assert.ok(nodes['.rail'].innerHTML.includes(values[index]));
        if (style !== 'ring') assert.ok(nodes['.rail'].innerHTML.includes(`ico-${style}`));
      }
    }
  }
});

test('stored candle migrates to battery and storage errors use configured preferences', () => {
  assert.equal(widget({ stored: { style: 'candle' } }).api.preferences().style, 'battery');
  const { api } = widget({ config: { style: 'hourglass', timeDisplay: 'deadline' }, storageError: true });
  assert.equal(api.preferences().style, 'hourglass');
  assert.equal(api.preferences().timeMode, 'deadline');
});

test('empty successful snapshots stop claiming unlimited when a tick makes them stale', () => {
  const { api, cd, nodes, setClock } = widget();
  api.setState({ windows: [], syncedAt: 1_000_000, error: null });
  api.renderStructure();
  assert.equal(cd.textContent, '无限制');
  setClock(1_600_001);
  api.tick();
  assert.equal(cd.textContent, '数据已过期');
  assert.match(nodes['.ft'].textContent, /数据可能已过期/);
});

test('already stale empty snapshots never render unlimited', () => {
  const { api, cd, setClock } = widget();
  setClock(1_600_001);
  api.setState({ windows: [], syncedAt: 1_000_000, error: null });
  api.renderStructure();
  assert.equal(cd.textContent, '数据已过期');
});

test('empty snapshots update loading and error text on tick and recover on fresh data', () => {
  const { api, cd, nodes, update, setClock } = widget();
  api.renderStructure();
  assert.equal(cd.textContent, '同步中…');
  api.setState({ windows: [], syncedAt: null, error: 'Synthetic failure' });
  api.tick();
  assert.equal(cd.textContent, '同步失败');
  assert.equal(nodes['.ft'].className, 'ft err');
  api.setState({ windows: [], syncedAt: 1_000_000, error: null });
  api.tick();
  assert.equal(cd.textContent, '无限制');
  api.setState({ windows: [], syncedAt: 1_000_000, error: 'Synthetic failure' });
  api.tick();
  assert.equal(cd.textContent, '同步失败');
  api.setState({ windows: [], syncedAt: null, error: null });
  api.tick();
  assert.equal(cd.textContent, '同步中…');
  setClock(1_700_000);
  update({ windows: [], syncedAt: 1_700_000, error: null });
  assert.equal(cd.textContent, '无限制');
  assert.equal(nodes['.ft'].className, 'ft');
});
