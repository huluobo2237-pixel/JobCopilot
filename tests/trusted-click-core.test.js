const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchTrustedClick
} = require('../JobCopilot · AI/src/trusted-click-core.js');

function fakeDebugger(options) {
  options = options || {};
  const calls = [];
  return {
    calls,
    async attach(target, version) {
      calls.push(['attach', target, version]);
      if (options.attachError) throw new Error(options.attachError);
    },
    async sendCommand(target, method, params) {
      calls.push(['sendCommand', target, method, params]);
      if (options.commandError && params.type === options.commandError.type) {
        throw new Error(options.commandError.message);
      }
    },
    async detach(target) {
      calls.push(['detach', target]);
    }
  };
}

test('dispatches exactly one trusted left click and detaches immediately', async () => {
  const debuggerApi = fakeDebugger();
  const result = await dispatchTrustedClick({
    debuggerApi,
    tabId: 42,
    x: 320.5,
    y: 180.25
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    debuggerApi.calls.map(call => call[0] === 'sendCommand' ? call[3].type : call[0]),
    ['attach', 'mouseMoved', 'mousePressed', 'mouseReleased', 'detach']
  );
  assert.equal(debuggerApi.calls[2][3].button, 'left');
  assert.equal(debuggerApi.calls[2][3].clickCount, 1);
});

test('detaches after a dispatch failure and returns a safe error', async () => {
  const debuggerApi = fakeDebugger({
    commandError: { type: 'mousePressed', message: 'dispatch failed' }
  });
  const result = await dispatchTrustedClick({
    debuggerApi,
    tabId: 7,
    x: 10,
    y: 20
  });
  assert.equal(result.success, false);
  assert.match(result.error, /无法对“查看职位”执行浏览器级点击/);
  assert.equal(debuggerApi.calls.at(-1)[0], 'detach');
});

test('rejects invalid coordinates without attaching', async () => {
  const debuggerApi = fakeDebugger();
  const result = await dispatchTrustedClick({
    debuggerApi,
    tabId: 7,
    x: Number.NaN,
    y: 20
  });
  assert.equal(result.success, false);
  assert.equal(debuggerApi.calls.length, 0);
});
