(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrustedClickCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  async function dispatchTrustedClick(options) {
    options = options || {};
    const debuggerApi = options.debuggerApi;
    const tabId = Number(options.tabId);
    const x = Number(options.x);
    const y = Number(options.y);
    if (
      !debuggerApi ||
      !Number.isInteger(tabId) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0
    ) {
      return {
        success: false,
        error: '可信职位入口点击参数无效'
      };
    }

    const target = { tabId: tabId };
    let attached = false;
    try {
      await debuggerApi.attach(target, '1.3');
      attached = true;
      await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x,
        y: y
      });
      await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x,
        y: y,
        button: 'left',
        buttons: 1,
        clickCount: 1
      });
      await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x,
        y: y,
        button: 'left',
        buttons: 0,
        clickCount: 1
      });
      return { success: true, error: '' };
    } catch (error) {
      const detail = error && error.message ? String(error.message) : '';
      return {
        success: false,
        error: detail.includes('Another debugger')
          ? 'BOSS 页面正在被开发者工具占用，请关闭该页面的开发者工具后重试'
          : '无法对“查看职位”执行浏览器级点击' + (detail ? '：' + detail : '')
      };
    } finally {
      if (attached) {
        try { await debuggerApi.detach(target); } catch (error) { /* ignore */ }
      }
    }
  }

  return Object.freeze({
    dispatchTrustedClick: dispatchTrustedClick
  });
});
