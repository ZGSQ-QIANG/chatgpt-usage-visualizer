import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/widget.js', import.meta.url), 'utf8')
  .replace(/\}\)\(\);\s*$/, `globalThis.popupTest = { togglePop, onDocClick, onKey, ensureMounted,
    setNodes(h, r) { host = h; root = r; } }; })();`);
function fixture() {
  const pop = { hidden: true, opened: false, offsetHeight: 280, offsetWidth: 240, style: {},
    matches() { return this.opened; },
    showPopover() { this.opened = true; }, hidePopover() { this.opened = false; } };
  const host = { isConnected: true, getBoundingClientRect: () => ({ right: 48, bottom: 650 }) };
  const context = vm.createContext({
    window: {}, document: { readyState: 'loading', addEventListener() {}, querySelector: () => ({ parentElement: { before() { host.isConnected = true; } } }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    localStorage: { getItem() {} }, innerWidth: 900, innerHeight: 720,
  });
  vm.runInContext(source, context);
  context.popupTest.setNodes(host, { querySelector: () => pop });
  return { api: context.popupTest, pop, host, context };
}
test('details enter the top layer and remain anchored outside the clipped rail', () => {
  const { api, pop } = fixture();
  api.togglePop();
  assert.equal(pop.hidden, false);
  assert.equal(pop.opened, true);
  assert.equal(pop.style.left, '58px');
  api.togglePop();
  assert.equal(pop.opened, false);
  assert.equal(pop.hidden, true);
});
test('Escape and outside clicks close details; internal clicks do not', () => {
  const { api, pop, host } = fixture();
  api.togglePop(true);
  api.onDocClick({ composedPath: () => [host] });
  assert.equal(pop.opened, true);
  api.onDocClick({ composedPath: () => [] });
  assert.equal(pop.opened, false);
  api.togglePop(true);
  api.onKey({ key: 'Escape' });
  assert.equal(pop.opened, false);
});
test('first click after sidebar remount reopens a natively dismissed popover', () => {
  const { api, pop, host } = fixture();
  api.togglePop(true);
  host.isConnected = false;
  pop.opened = false;
  api.ensureMounted();
  api.togglePop();
  assert.equal(pop.opened, true);
  assert.equal(pop.hidden, false);
});
test('details fit inside a narrow window', () => {
  const { api, pop, context } = fixture();
  context.innerWidth = 300;
  api.togglePop(true);
  assert.equal(pop.style.left, '52px');
});
