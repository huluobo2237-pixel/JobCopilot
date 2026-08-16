const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureJobDetailUrlInPage
} = require('../JobCopilot · AI/src/job-detail-popup-capture.js');

async function withPageFixture(click, run) {
  const originalGlobals = {
    document: global.document,
    window: global.window,
    location: global.location,
    getComputedStyle: global.getComputedStyle,
    Node: global.Node,
    HTMLAnchorElement: global.HTMLAnchorElement
  };
  const outerCard = {
    offsetParent: {},
    attributes: [],
    matches: () => false,
    querySelector: () => null,
    closest: () => outerCard,
    click() {
      throw new Error('outer job card must not be clicked when right-content exists');
    }
  };
  const rightContent = {
    offsetParent: {},
    attributes: [],
    matches: () => false,
    querySelector: () => null,
    closest: selector => selector.includes('geek_chat_job_detail') ||
      selector.includes('position-content') ||
      selector.includes('chat-position-content')
      ? outerCard
      : null,
    click
  };
  const pageRoot = {
    querySelector(selector) {
      if (selector.includes('.right-content')) return rightContent;
      if (selector === '[ka="geek_chat_job_detail"]') return outerCard;
      return null;
    }
  };

  global.document = {
    querySelector(selector) {
      return selector === '.chat-conversation' ? pageRoot : null;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  global.window = { open() { return null; } };
  global.location = { origin: 'https://www.zhipin.com' };
  global.getComputedStyle = () => ({ position: 'static' });
  global.Node = function Node() {};
  global.HTMLAnchorElement = class HTMLAnchorElement {
    constructor(href) {
      this.href = href;
      this.originalClicks = 0;
    }

    click() {
      this.originalClicks++;
    }
  };

  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(originalGlobals)) {
      if (typeof value === 'undefined') delete global[name];
      else global[name] = value;
    }
  }
}

test('clicks the inner BOSS right-content and captures a direct window.open URL', async () => {
  await withPageFixture(
    () => global.window.open('/job_detail/directJob123.html?lid=chat', '_blank'),
    async () => {
      const result = await captureJobDetailUrlInPage({
        interceptWindowOpen: true,
        captureDelayMs: 0
      });
      assert.equal(result.triggerFound, true);
      assert.equal(result.url, '/job_detail/directJob123.html?lid=chat');
      assert.equal(result.source, 'window.open');
    }
  );
});

test('captures a delayed URL assigned after window.open about:blank', async () => {
  await withPageFixture(
    () => {
      const popup = global.window.open('about:blank', '_blank');
      popup.location.href = 'https://www.zhipin.com/job_detail/assignedJob123.html';
    },
    async () => {
      const result = await captureJobDetailUrlInPage({
        interceptWindowOpen: true,
        captureDelayMs: 0
      });
      assert.equal(result.triggerFound, true);
      assert.equal(result.url, 'https://www.zhipin.com/job_detail/assignedJob123.html');
      assert.equal(result.source, 'window.open.location.href');
    }
  );
});

test('captures a generated job-detail anchor without opening it', async () => {
  let anchor;
  await withPageFixture(
    () => {
      anchor = new global.HTMLAnchorElement(
        'https://www.zhipin.com/job_detail/anchorJob123.html?lid=chat'
      );
      anchor.click();
    },
    async () => {
      const result = await captureJobDetailUrlInPage({
        interceptWindowOpen: true,
        captureDelayMs: 0
      });
      assert.equal(result.triggerFound, true);
      assert.equal(result.url, 'https://www.zhipin.com/job_detail/anchorJob123.html?lid=chat');
      assert.equal(result.source, 'anchor.click');
      assert.equal(anchor.originalClicks, 0);
    }
  );
});
