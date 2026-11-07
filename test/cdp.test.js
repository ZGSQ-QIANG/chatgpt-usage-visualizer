import test from 'node:test';
import assert from 'node:assert/strict';
import { Injector, isPortOpen, listTargets } from '../src/cdp.js';

const port = 9222;
const target = (webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/page/window`) => ({
  id: 'window', type: 'page', url: 'app://desktop/main', title: 'Fixture', webSocketDebuggerUrl,
});

function mockNetwork(t, targets = [target()]) {
  const requests = [];
  const sockets = [];
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => targets };
  });
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      sockets.push(url);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data) {
      const message = JSON.parse(data);
      messages.push(message);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: message.id, result: { result: { value: null } } }),
      })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  t.mock.method(globalThis, 'WebSocket', function (url) { return new FakeWebSocket(url); });
  const injector = new Injector({
    port,
    filter: { urlPrefix: 'app://desktop/', excludeUrlIncludes: [] },
    widgetSource: 'void 0', getPayload: () => ({}), log: () => {},
  });
  return { requests, sockets, messages, injector };
}

for (const endpoint of [
  `ws://example.invalid:${port}/devtools/page/window`,
  `ws://127.0.0.1.example.invalid:${port}/devtools/page/window`,
  `ws://127.0.0.2:${port}/devtools/page/window`,
  `ws://localhost:${port}/devtools/page/window`,
  `ws://127.1:${port}/devtools/page/window`,
  `ws://2130706433:${port}/devtools/page/window`,
  `ws://user:password@127.0.0.1:${port}/devtools/page/window`,
  'ws://127.0.0.1:9223/devtools/page/window',
  `wss://127.0.0.1:${port}/devtools/page/window`,
  `http://127.0.0.1:${port}/devtools/page/window`,
  'not a URL',
]) {
  test(`scan never connects or sends to an untrusted endpoint: ${endpoint}`, async (t) => {
    const { injector, sockets, messages } = mockNetwork(t, [target(endpoint)]);
    assert.equal(await injector.scan(), 0);
    assert.deepEqual(sockets, []);
    assert.deepEqual(messages, []);
  });
}

for (const endpoint of [
  `ws://127.0.0.1:${port}/devtools/page/window`,
  `ws://[::1]:${port}/devtools/page/window`,
]) {
  test(`scan still injects a literal loopback endpoint: ${endpoint}`, async (t) => {
    const { injector, sockets, messages } = mockNetwork(t, [target(endpoint)]);
    assert.equal(await injector.scan(), 1);
    assert.deepEqual(sockets, [endpoint]);
    assert.ok(messages.some((message) => message.method === 'Runtime.evaluate'));
  });
}

test('discovery requests disable redirects and have a bounded timeout', async (t) => {
  const { requests } = mockNetwork(t);
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  assert.equal((await listTargets(port)).length, 1);
  assert.equal(await isPortOpen(port), true);
  assert.deepEqual(requests.map(({ url }) => url), [
    `http://127.0.0.1:${port}/json/list`, `http://127.0.0.1:${port}/json/version`,
  ]);
  for (const { options } of requests) {
    assert.equal(options?.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
  }
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts.every((milliseconds) => milliseconds > 0 && milliseconds <= 2000));
});

test('discovery rejects HTTP redirects before processing targets', async (t) => {
  const { injector, sockets, messages } = mockNetwork(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options?.redirect === 'error') throw new TypeError('redirect rejected');
    return { ok: true, json: async () => [target()] };
  });
  await assert.rejects(listTargets(port), /redirect/);
  assert.equal(await isPortOpen(port), false);
  assert.equal(await injector.scan(), 0);
  assert.deepEqual(sockets, []);
  assert.deepEqual(messages, []);
});

for (const invalidPort of [0, 65536, -1, 1.5, NaN, Infinity, undefined, null, {}, '9222/path', ' 9222 ', '']) {
  test(`invalid port is rejected before discovery: ${String(invalidPort)}`, async (t) => {
    const { injector, requests, sockets, messages } = mockNetwork(t);
    injector.port = invalidPort;
    await assert.rejects(listTargets(invalidPort));
    assert.equal(await isPortOpen(invalidPort), false);
    assert.equal(await injector.scan(), 0);
    assert.deepEqual(requests, []);
    assert.deepEqual(sockets, []);
    assert.deepEqual(messages, []);
  });
}

test('decimal string ports retain compatibility', async (t) => {
  const { injector } = mockNetwork(t);
  injector.port = String(port);
  assert.equal(await injector.scan(), 1);
});

for (const targets of [null, {}, 'invalid', [null], [1], [{ ...target(), id: null }], [{ ...target(), webSocketDebuggerUrl: {} }]]) {
  test(`malformed target list is rejected safely: ${JSON.stringify(targets)}`, async (t) => {
    const { injector, sockets, messages } = mockNetwork(t, targets);
    await assert.rejects(listTargets(port));
    assert.equal(await injector.scan(), 0);
    assert.deepEqual(sockets, []);
    assert.deepEqual(messages, []);
  });
}

test('discovery failures never create a connection', async (t) => {
  const { injector, sockets } = mockNetwork(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture timeout'); });
  await assert.rejects(listTargets(port), /timeout/);
  assert.equal(await isPortOpen(port), false);
  assert.equal(await injector.scan(), 0);
  assert.deepEqual(sockets, []);
});
