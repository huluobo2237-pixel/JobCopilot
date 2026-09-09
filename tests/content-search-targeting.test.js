const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentSource = fs.readFileSync(
  path.join(__dirname, '..', 'JobCopilot · AI', 'src', 'content-search.js'),
  'utf8'
);

function createContentHarness(url) {
  let listener;
  let chatClicks = 0;
  let continueClicks = 0;
  const detail = { innerText: '精确岗位 JD' };
  const chatButton = {
    offsetParent: {},
    textContent: '立即沟通',
    click() { chatClicks++; }
  };
  const continueButton = {
    offsetParent: {},
    textContent: '继续沟通',
    click() { continueClicks++; }
  };
  const document = {
    querySelector(selector) {
      if (selector === 'a.op-btn-chat') return chatButton;
      if (selector.includes('job-detail')) return detail;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a, button, span, div') return [continueButton];
      return [];
    }
  };
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } }
      }
    },
    console,
    document,
    SELECTORS: {
      jobs: {
        jobCard: 'li.job-card-box',
        jobName: '.job-name',
        jobSalary: '.job-salary',
        tagList: '.tag-list li',
        immediateChatBtn: 'a.op-btn-chat'
      }
    },
    location: { href: url },
    setInterval(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearInterval() {},
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    }
  };
  sandbox.window = sandbox;
  vm.runInContext(contentSource, vm.createContext(sandbox), { filename: 'content-search.js' });

  return {
    get chatClicks() { return chatClicks; },
    get continueClicks() { return continueClicks; },
    send(message) {
      return new Promise(resolve => listener(message, {}, resolve));
    }
  };
}

test('reports the exact job id from a matching detail page', async () => {
  const harness = createContentHarness('https://www.zhipin.com/job_detail/job-a.html');

  const result = await harness.send({ type: 'OPEN_JD', job: { id: 'job-a' } });

  assert.equal(result.success, true);
  assert.equal(result.jobId, 'job-a');
  assert.equal(result.jd, '精确岗位 JD');
});

test('rejects a detail page whose job id does not match the reviewed job', async () => {
  const harness = createContentHarness('https://www.zhipin.com/job_detail/job-b.html');

  const result = await harness.send({ type: 'OPEN_JD', job: { id: 'job-a' } });

  assert.equal(result.success, false);
  assert.equal(harness.chatClicks, 0);
});

test('checks the detail job id again immediately before contacting', async () => {
  const harness = createContentHarness('https://www.zhipin.com/job_detail/job-b.html');

  const result = await harness.send({ type: 'GO_CHAT', job: { id: 'job-a' } });

  assert.equal(result.success, false);
  assert.equal(harness.chatClicks, 0);
  assert.equal(harness.continueClicks, 0);
});

test('contacts only when the detail page id matches the reviewed job', async () => {
  const harness = createContentHarness('https://www.zhipin.com/job_detail/job-a.html');

  const result = await harness.send({ type: 'GO_CHAT', job: { id: 'job-a' } });

  assert.equal(result.success, true);
  assert.equal(result.jobId, 'job-a');
  assert.equal(harness.chatClicks, 1);
  assert.equal(harness.continueClicks, 1);
});
