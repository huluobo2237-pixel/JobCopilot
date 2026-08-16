// ===== 岗位详情页 content script：读取 JD，并从精确详情页建立联系 =====
(function () {
  if (window.__jobCopilotDetailReader) return;
  window.__jobCopilotDetailReader = true;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function visible(element) {
    return Boolean(element && (element.offsetParent !== null || getComputedStyle(element).position === 'fixed'));
  }

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = clean(element.innerText || element.textContent);
        if (visible(element) && text) return text;
      }
    }
    return '';
  }

  function collectDescription() {
    const selectors = [
      '.job-sec-text',
      '.job-detail-section .text',
      '.job-detail-section',
      '.job-description',
      '[class*="job-description"]',
      '[class*="job-desc"]',
      '[class*="job-detail"] [class*="text"]'
    ];
    const blocks = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const text = clean(element.innerText || element.textContent);
        if (text.length < 40 || seen.has(text)) continue;
        seen.add(text);
        blocks.push(text);
      }
    }
    if (blocks.length) {
      blocks.sort((left, right) => right.length - left.length);
      return blocks[0].slice(0, 5000);
    }

    const bodyText = clean(document.body && document.body.innerText);
    const marker = bodyText.search(/职位描述|岗位职责|任职要求/);
    if (marker >= 0) return bodyText.slice(marker, marker + 5000);
    return '';
  }

  function readDetail() {
    return {
      success: true,
      title: firstText(['h1', '.job-name', '[class*="job-name"]', '.name']),
      company: firstText(['.company-info .name', '.company-name', '[class*="company-name"]']),
      jd: collectDescription(),
      url: location.href
    };
  }

  function currentJobId() {
    const match = location.pathname.match(/^\/job_detail\/([^/?#]+)\.html$/i);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return match[1];
    }
  }

  function exactJobMatches(job) {
    const expected = clean(job && job.id);
    return Boolean(expected && currentJobId() === expected);
  }

  function clickableByText(texts) {
    const candidates = document.querySelectorAll('a, button, [role="button"]');
    for (const element of candidates) {
      if (!visible(element)) continue;
      const text = clean(element.innerText || element.textContent);
      if (texts.includes(text)) return element;
    }
    return null;
  }

  async function waitForClickable(texts, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const element = clickableByText(texts);
      if (element) return element;
      await sleep(200);
    }
    return null;
  }

  async function startChat(job) {
    if (!exactJobMatches(job)) {
      return {
        success: false,
        code: 'JOB_ID_MISMATCH',
        error: '岗位详情页 ID 校验失败，已阻止联系'
      };
    }

    let button = document.querySelector(
      'a.op-btn-chat, a.btn-startchat, button.btn-startchat, ' +
      'a[class*="op-btn-chat"], button[class*="op-btn-chat"], ' +
      'a[class*="start-chat"], button[class*="start-chat"]'
    );
    if (!visible(button)) button = await waitForClickable(['立即沟通', '继续沟通'], 5000);
    if (!button) {
      return {
        success: false,
        code: 'CHAT_BUTTON_NOT_FOUND',
        error: '精确岗位详情页未找到立即沟通按钮'
      };
    }

    const initialText = clean(button.innerText || button.textContent);
    button.click();
    if (initialText === '继续沟通') {
      return { success: true, navigated: true, source: 'job_detail' };
    }

    await sleep(1200);
    const continueButton = await waitForClickable(['继续沟通'], 4000);
    if (continueButton) {
      // 先将结果返回给后台，再触发可能把详情页放入 BFCache 的导航。
      setTimeout(() => continueButton.click(), 80);
      return { success: true, navigated: true, source: 'job_detail' };
    }
    return { success: true, navigated: false, source: 'job_detail' };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'READ_JOB_DETAIL') {
      try {
        const result = readDetail();
        if (message.job && !exactJobMatches(message.job)) {
          sendResponse({
            success: false,
            code: 'JOB_ID_MISMATCH',
            error: '岗位详情页 ID 校验失败',
            title: result.title,
            url: result.url
          });
        } else if (!result.jd) {
          sendResponse({ success: false, error: '岗位详情页未读取到 JD', title: result.title, url: result.url });
        } else {
          sendResponse(result);
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message || '岗位详情读取失败' });
      }
      return;
    }
    if (message.type === 'START_JOB_CHAT') {
      startChat(message.job)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error.message || '岗位详情页建立联系失败' }));
      return true;
    }
  });
})();
