const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(
  path.join(__dirname, '..', 'JobCopilot · AI', 'src', 'background.js'),
  'utf8'
);

function createDeliveryHarness({ openJobResult, activeJobId = 'job-b', selectedJob: jobOverrides = {} }) {
  const selectedJob = Object.assign({
    id: 'job-a',
    name: '前端工程师',
    company: '甲公司',
    link: 'https://www.zhipin.com/job_detail/job-a.html'
  }, jobOverrides);
  const stored = {
    dsKey: 'test-key',
    resumeText: '测试简历',
    keyword: '前端工程师',
    city: '北京',
    count: '20',
    sw_jobs: [selectedJob],
    sw_greetings: {},
    processed: {}
  };
  const contactedJobIds = [];
  const sentGreetings = [];
  const visitedUrls = [];
  let tab = {
    id: 1,
    status: 'complete',
    url: 'https://www.zhipin.com/web/geek/jobs?query=frontend'
  };

  function storageGet(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    return Promise.resolve(Object.fromEntries(names.map(key => [key, stored[key]])));
  }

  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} },
      sendMessage() { return Promise.resolve(); }
    },
    sidePanel: {
      setPanelBehavior() { return Promise.resolve(); }
    },
    scripting: {
      executeScript() { return Promise.resolve(); }
    },
    storage: {
      local: {
        get: storageGet,
        set(values) {
          Object.assign(stored, values);
          return Promise.resolve();
        }
      }
    },
    tabs: {
      query() { return Promise.resolve([tab]); },
      create({ url }) {
        tab = { id: 1, status: 'complete', url };
        return Promise.resolve(tab);
      },
      update(id, { url }) {
        visitedUrls.push(url);
        tab.url = url;
        tab.status = 'complete';
        return Promise.resolve(tab);
      },
      get(id, callback) { callback(tab); },
      onUpdated: {
        addListener() {},
        removeListener() {}
      },
      sendMessage(id, message, callback) {
        if (message.type === 'OPEN_JD') {
          callback(openJobResult);
          return;
        }
        if (message.type === 'GO_CHAT') {
          const match = tab.url.match(/\/job_detail\/([^/?]+)\.html/);
          contactedJobIds.push(match ? match[1] : activeJobId);
          tab.url = 'https://www.zhipin.com/web/geek/chat';
          callback({ success: true, navigated: true });
          return;
        }
        if (message.type === 'SEND_ACTIVE') {
          sentGreetings.push(message.greeting);
          callback({ success: true });
          return;
        }
        callback({ success: false, error: 'unexpected message' });
      }
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    fetch: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '熟悉前端开发，做过测试项目。' } }] })
    }),
    importScripts() {},
    URL,
    URLSearchParams,
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {}
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  return {
    contactedJobIds,
    sentGreetings,
    visitedUrls,
    run: () => vm.runInContext("runDeliver(['job-a'])", context)
  };
}

test('does not contact a different job when the reviewed card cannot be opened', async () => {
  const harness = createDeliveryHarness({
    openJobResult: { success: false, error: '未找到岗位卡片' },
    activeJobId: 'job-b'
  });

  await harness.run();

  assert.deepEqual(harness.contactedJobIds, []);
  assert.deepEqual(harness.sentGreetings, []);
});

test('opens and contacts the exact reviewed job URL', async () => {
  const harness = createDeliveryHarness({
    openJobResult: { success: true, jobId: 'job-a', jd: '目标岗位 JD' }
  });

  await harness.run();

  assert.equal(harness.visitedUrls[0], 'https://www.zhipin.com/job_detail/job-a.html');
  assert.deepEqual(harness.contactedJobIds, ['job-a']);
  assert.equal(harness.sentGreetings.length, 1);
});

test('does not contact when the opened detail belongs to another job', async () => {
  const harness = createDeliveryHarness({
    openJobResult: { success: true, jobId: 'job-b', jd: '其他岗位 JD' }
  });

  await harness.run();

  assert.deepEqual(harness.contactedJobIds, []);
  assert.deepEqual(harness.sentGreetings, []);
});

test('rejects a stored link whose job id differs from the reviewed id', async () => {
  const harness = createDeliveryHarness({
    openJobResult: { success: true, jobId: 'job-b', jd: '其他岗位 JD' },
    selectedJob: { link: 'https://www.zhipin.com/job_detail/job-b.html' }
  });

  await harness.run();

  assert.deepEqual(harness.contactedJobIds, []);
  assert.deepEqual(harness.sentGreetings, []);
});
