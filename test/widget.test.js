import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const original = fs.readFileSync(new URL('../src/widget.js', import.meta.url), 'utf8');
// Expose closure functions in the VM only; production keeps its existing API.
const source = original.replace(/\}\)\(\);\s*$/, `
  globalThis.widgetTest = {
    preferences: () => ({ style, timeMode, label: railLabel() }),
    renderStructure, tick, togglePop, onDocClick, onKey, ensureMounted,
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
    document: { readyState: 'loading', addEventListener() {}, querySelector: () => ({ parentElement: { before: () => { host.isConnected = true; } } }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    localStorage: {
      getItem(key) {
        if (storageError) throw new Error('Storage unavailable');
        return stored[key.split(':').at(-1)] ?? null;
      },
    },
    Date: Clock,
    getComputedStyle: () => ({ color: 'rgb(0, 0, 0)' }),
    innerWidth: 900, innerHeight: 720,
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
  const pop = { hidden: true, offsetWidth: 240, offsetHeight: 280, style: {}, topLayer: false,
    showCount: 0, hideCount: 0,
    showPopover() { this.topLayer = true; this.showCount++; },
    hidePopover() { this.topLayer = false; this.hideCount++; },
    matches(selector) { return selector === ':popover-open' && this.topLayer; },
  };
  const nodes = { '.rail': rail, '.rail .cd': cd, '.body': {}, '.ft': {}, '.rf': {}, '.pop': pop };
  const host = { isConnected: true, setAttribute() {}, getBoundingClientRect: () => ({ right: 48, bottom: 650 }) };
  api.setNodes(host, {
    querySelector: (selector) => nodes[selector] ?? null,
    querySelectorAll: () => [],
  });
  return { api, nodes, cd, host, update: context.window.__codexUsageCountdown.update,
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


test('opening details promotes the popup to the top layer outside a clipped sidebar', () => {
  const { api, nodes } = widget();
  api.togglePop(true);
  assert.equal(nodes['.pop'].hidden, false);
  assert.equal(nodes['.pop'].topLayer, true);
  assert.equal(nodes['.pop'].showCount, 1);
  assert.equal(nodes['.pop'].style.left, '58px');
});

test('closing details removes it from the top layer and reopening works', () => {
  const { api, nodes } = widget();
  api.togglePop(true);
  api.togglePop(false);
  assert.equal(nodes['.pop'].hidden, true);
  assert.equal(nodes['.pop'].topLayer, false);
  assert.equal(nodes['.pop'].hideCount, 1);
  api.togglePop(true);
  assert.equal(nodes['.pop'].showCount, 2);
});

test('outside click and Escape close the top-layer popup without closing on internal clicks', () => {
  const { api, nodes, host } = widget();
  api.togglePop(true);
  api.onDocClick({ composedPath: () => [host] });
  assert.equal(nodes['.pop'].topLayer, true);
  api.onDocClick({ composedPath: () => [] });
  assert.equal(nodes['.pop'].topLayer, false);
  api.togglePop(true);
  api.onKey({ key: 'Escape' });
  assert.equal(nodes['.pop'].topLayer, false);
});


test('remount after native popup dismissal lets the first click reopen details', () => {
  const { api, nodes, host } = widget();
  api.togglePop(true);
  // Browsers automatically remove a native popover from the top layer on detachment.
  host.isConnected = false;
  nodes['.pop'].topLayer = false;
  api.ensureMounted();
  api.togglePop();
  assert.equal(nodes['.pop'].hidden, false);
  assert.equal(nodes['.pop'].topLayer, true);
});
