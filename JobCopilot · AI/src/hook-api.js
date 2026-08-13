// MAIN world 脚本（document_start 注入，在页面自身脚本之前运行）：
// 钩住页面自己的 fetch / XHR，截获 BOSS 搜索接口返回的明文岗位数据
// （薪资在 DOM 里被字体反爬加密成乱码，但接口返回的 salaryDesc 是明文），
// 通过 postMessage 交给 content script 使用。
(function () {
  if (window.__zpApiHooked) return;
  window.__zpApiHooked = true;

  var cache = [];

  function capture(url, text) {
    try {
      if (!url || !text) return;
      var hit = false;
      try { hit = /zpgeek|joblist|wapi/i.test(url) || /salaryDesc/.test(text); } catch (e) {}
      if (!hit) return;
      var data = JSON.parse(text);
      var list = data && data.zpData && Array.isArray(data.zpData.jobList) ? data.zpData.jobList : [];
      if (!list.length) return;
      cache.push({ url: url, list: list });
      if (cache.length > 8) cache.shift();
      window.postMessage({ source: 'zp-hook', payload: { url: url, list: list } }, '*');
    } catch (e) {}
  }

  // 包一层 fetch
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      return origFetch.apply(this, arguments).then(function (resp) {
        try {
          if (resp && resp.ok && resp.clone) {
            var ct = (resp.headers && resp.headers.get('content-type')) || '';
            if (/json/i.test(ct) || /zpgeek|joblist|wapi/i.test(url)) {
              resp.clone().text().then(function (t) { capture(url, t); }).catch(function () {});
            }
          }
        } catch (e) {}
        return resp;
      });
    };
  }

  // 包一层 XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__zpUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      xhr.addEventListener('load', function () {
        var txt = xhr.responseText || (typeof xhr.response === 'string' ? xhr.response : (xhr.response ? JSON.stringify(xhr.response) : ''));
        capture(xhr.__zpUrl || '', txt);
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // content script 请求已缓存的数据
  document.addEventListener('zp-hook-request', function () {
    for (var i = 0; i < cache.length; i++) {
      try { window.postMessage({ source: 'zp-hook', payload: cache[i] }, '*'); } catch (e) {}
    }
  });
})();
