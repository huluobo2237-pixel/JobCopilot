(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobDetailTabCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  function normalizeBossJobDetailUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const hostname = url.hostname.toLowerCase();
      if (hostname !== 'zhipin.com' && !hostname.endsWith('.zhipin.com')) return '';
      if (!/^\/job_detail\/[^/?#]+\.html$/i.test(url.pathname)) return '';
      url.hash = '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function captureNewJobDetailTab(options) {
    options = options || {};
    const tabs = options.tabs;
    const openerTabId = Number(options.openerTabId);
    const openerWindowId = Number(options.openerWindowId);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
    const click = options.click;
    if (
      !tabs ||
      !tabs.onCreated ||
      !tabs.onUpdated ||
      !Number.isInteger(openerTabId) ||
      typeof click !== 'function'
    ) {
      return Promise.resolve({
        success: false,
        url: '',
        tabId: null,
        cleanupTabIds: [],
        error: '岗位标签页捕获参数无效'
      });
    }

    return new Promise(resolve => {
      let finished = false;
      let started = false;
      const eligibleIds = new Set();
      const strictCleanupIds = new Set();

      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        tabs.onCreated.removeListener(onCreated);
        tabs.onUpdated.removeListener(onUpdated);
        resolve(Object.assign({
          success: false,
          url: '',
          tabId: null,
          cleanupTabIds: Array.from(strictCleanupIds),
          error: ''
        }, result || {}));
      };

      const consider = tab => {
        if (!tab || !Number.isInteger(tab.id) || tab.id === openerTabId) return;
        const url = normalizeBossJobDetailUrl(tab.pendingUrl || tab.url);
        if (url) {
          finish({
            success: true,
            url: url,
            tabId: tab.id,
            cleanupTabIds: Array.from(strictCleanupIds),
            error: ''
          });
        }
      };

      const isSameWindow = tab => !Number.isInteger(openerWindowId) ||
        tab.windowId === openerWindowId;

      function onCreated(tab) {
        if (!started || !tab || !Number.isInteger(tab.id) || !isSameWindow(tab)) return;
        if (tab.openerTabId === openerTabId) {
          eligibleIds.add(tab.id);
          strictCleanupIds.add(tab.id);
          consider(tab);
          return;
        }
        // Some BOSS/Edge combinations omit openerTabId. Track the new tab only
        // after the controlled click, and accept it only once it becomes an
        // exact BOSS job-detail URL.
        if (!Number.isInteger(tab.openerTabId)) {
          eligibleIds.add(tab.id);
          consider(tab);
        }
      }

      function onUpdated(tabId, changeInfo, tab) {
        if (!started || !eligibleIds.has(tabId)) return;
        consider(Object.assign({}, tab || {}, {
          id: tabId,
          pendingUrl: (changeInfo && changeInfo.url) || (tab && tab.pendingUrl),
          url: (changeInfo && changeInfo.url) || (tab && tab.url)
        }));
      }

      tabs.onCreated.addListener(onCreated);
      tabs.onUpdated.addListener(onUpdated);
      const timer = setTimeout(() => {
        finish({ error: '点击“查看职位”后未捕获到岗位详情标签页' });
      }, timeoutMs);

      started = true;
      Promise.resolve()
        .then(() => click())
        .then(result => {
          if (result && result.triggerFound === false) {
            finish({ error: '当前会话没有可点击的“查看职位”入口' });
          } else if (result && result.clicked === false) {
            finish({ error: '“查看职位”入口点击失败' });
          }
        })
        .catch(error => {
          finish({ error: (error && error.message) || '“查看职位”入口点击失败' });
        });
    });
  }

  return Object.freeze({
    normalizeBossJobDetailUrl: normalizeBossJobDetailUrl,
    captureNewJobDetailTab: captureNewJobDetailTab
  });
});
