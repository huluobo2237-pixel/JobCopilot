const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBossJobDetailUrl,
  captureNewJobDetailTab
} = require('../JobCopilot · AI/src/job-detail-tab-capture.js');

class FakeEvent {
  constructor() {
    this.listeners = new Set();
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(...args) {
    for (const listener of Array.from(this.listeners)) listener(...args);
  }
}

function fakeTabs() {
  return {
    onCreated: new FakeEvent(),
    onUpdated: new FakeEvent()
  };
}

test('accepts only exact BOSS job-detail tab URLs', () => {
  assert.equal(
    normalizeBossJobDetailUrl('https://www.zhipin.com/job_detail/abcXYZ123.html?lid=chat#top'),
    'https://www.zhipin.com/job_detail/abcXYZ123.html?lid=chat'
  );
  assert.equal(normalizeBossJobDetailUrl('https://www.zhipin.com/web/geek/chat'), '');
  assert.equal(normalizeBossJobDetailUrl('https://example.com/job_detail/abcXYZ123.html'), '');
});

test('captures an about:blank popup after it navigates to the exact BOSS job URL', async () => {
  const tabs = fakeTabs();
  const resultPromise = captureNewJobDetailTab({
    tabs,
    openerTabId: 10,
    openerWindowId: 3,
    timeoutMs: 100,
    click: async () => {
      tabs.onCreated.emit({
        id: 11,
        openerTabId: 10,
        windowId: 3,
        url: 'about:blank'
      });
      queueMicrotask(() => {
        tabs.onUpdated.emit(11, {
          url: 'https://www.zhipin.com/job_detail/secureJob123.html?lid=chat'
        }, {
          id: 11,
          openerTabId: 10,
          windowId: 3
        });
      });
      return { triggerFound: true, clicked: true };
    }
  });
  const result = await resultPromise;
  assert.equal(result.success, true);
  assert.equal(result.tabId, 11);
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/secureJob123.html?lid=chat');
  assert.deepEqual(result.cleanupTabIds, [11]);
  assert.equal(tabs.onCreated.listeners.size, 0);
  assert.equal(tabs.onUpdated.listeners.size, 0);
});

test('accepts an exact same-window BOSS tab when Edge omits openerTabId', async () => {
  const tabs = fakeTabs();
  const result = await captureNewJobDetailTab({
    tabs,
    openerTabId: 20,
    openerWindowId: 4,
    timeoutMs: 100,
    click: async () => {
      tabs.onCreated.emit({
        id: 21,
        windowId: 4,
        url: 'https://www.zhipin.com/job_detail/noOpener123.html'
      });
      return { triggerFound: true, clicked: true };
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.tabId, 21);
  assert.deepEqual(result.cleanupTabIds, []);
});

test('times out safely and reports strict popup tabs for cleanup', async () => {
  const tabs = fakeTabs();
  const result = await captureNewJobDetailTab({
    tabs,
    openerTabId: 30,
    openerWindowId: 5,
    timeoutMs: 10,
    click: async () => {
      tabs.onCreated.emit({
        id: 31,
        openerTabId: 30,
        windowId: 5,
        url: 'about:blank'
      });
      return { triggerFound: true, clicked: true };
    }
  });
  assert.equal(result.success, false);
  assert.match(result.error, /未捕获到岗位详情标签页/);
  assert.deepEqual(result.cleanupTabIds, [31]);
  assert.equal(tabs.onCreated.listeners.size, 0);
  assert.equal(tabs.onUpdated.listeners.size, 0);
});
