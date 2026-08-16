// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jobData = globalThis.JobDataCore;

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function visible(element) {
    return Boolean(element && (element.offsetParent !== null || getComputedStyle(element).position === 'fixed'));
  }

  function jobDetailLinks(root) {
    return Array.from((root || document).querySelectorAll('a[href*="/job_detail/"]'))
      .filter(link => visible(link) && /\/job_detail\/[^/?#]+\.html/i.test(link.href || ''));
  }

  function recommendationRoot() {
    const candidates = document.querySelectorAll('h1, h2, h3, h4, div, span');
    let heading = null;
    for (const element of candidates) {
      if (visible(element) && (element.textContent || '').trim() === '精选职位') {
        heading = element;
        break;
      }
    }
    if (!heading) return null;
    let root = heading.parentElement;
    for (let depth = 0; root && depth < 8; depth++, root = root.parentElement) {
      if (jobDetailLinks(root).length >= 2) return root;
    }
    return null;
  }

  function recommendationCardForLink(link, root) {
    let card = link;
    let current = link;
    for (let depth = 0; current && depth < 8; depth++) {
      const parent = current.parentElement;
      if (!parent || parent === root || parent === document.body) break;
      const linkCount = parent.querySelectorAll('a[href*="/job_detail/"]').length;
      if (linkCount > 1) break;
      card = parent;
      current = parent;
    }
    return card;
  }

  function getRecommendationCards() {
    const root = recommendationRoot();
    if (!root) return [];
    const seen = new Set();
    const cards = [];
    for (const link of jobDetailLinks(root)) {
      const match = link.href.match(/\/job_detail\/([^.?/]+)\.html/i);
      const id = match && match[1];
      if (!id || seen.has(id)) continue;
      const card = recommendationCardForLink(link, root);
      if (!card || (card.innerText || card.textContent || '').trim().length < 4) continue;
      seen.add(id);
      cards.push({ card: card, link: link });
    }
    return cards;
  }

  function readElementText(element, attributes) {
    if (!element) return '';
    for (const attribute of attributes || []) {
      const value = element.getAttribute && element.getAttribute(attribute);
      if (value && String(value).trim()) return String(value).trim();
    }
    return (element.innerText || element.textContent || '').trim();
  }

  function parseCard(card, preferredLink) {
    const linkEl = preferredLink || card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const nameEl = card.querySelector(SELECTORS.jobs.jobName) || linkEl;
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const compEl = card.querySelector(SELECTORS.jobs.company);
    const areaEl = card.querySelector(SELECTORS.jobs.area);
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const id = (m && m[1]) || ((nameEl ? nameEl.textContent.trim() : '') + '|' + (salEl ? salEl.textContent.trim() : ''));
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    const salaryRaw = readElementText(salEl, ['aria-label', 'title', 'data-salary', 'data-value']);
    const salaryObfuscated = jobData ? jobData.hasPrivateUseCharacters(salaryRaw) : false;
    return {
      id: id,
      name: readElementText(nameEl, ['aria-label', 'title']) || '未知岗位',
      salary: jobData ? jobData.readableSalary(salaryRaw) : salaryRaw,
      salaryRaw: salaryRaw,
      salaryObfuscated: salaryObfuscated,
      tags: tags,
      company: readElementText(compEl, ['aria-label', 'title', 'data-name', 'data-company']),
      area: readElementText(areaEl, ['aria-label', 'title', 'data-area', 'data-location']),
      link: link
    };
  }

  async function fetchApiJobs(count) {
    if (!jobData) return { jobs: [], warning: '岗位字段解析组件未加载，已回退到页面文字' };
    const pageSize = 30;
    const pageCount = Math.max(1, Math.ceil(Math.min(200, count || 20) / pageSize));
    const jobs = [];
    const seen = new Set();
    try {
      for (let page = 1; page <= pageCount; page++) {
        const query = jobData.buildSearchParams(location.search, page, pageSize);
        const response = await fetch('/wapi/zpgeek/search/joblist.json?' + query, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        if (payload.code !== 0) throw new Error(payload.message || payload.msg || ('code ' + payload.code));
        const pageJobs = jobData.extractApiJobs(payload, location.origin);
        for (const job of pageJobs) {
          const key = job.id || (job.name + '|' + job.company);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          jobs.push(job);
        }
        const hasMore = payload.zpData && payload.zpData.hasMore;
        if (!pageJobs.length || hasMore === false || jobs.length >= count) break;
        await sleep(180);
      }
      return { jobs: jobs, warning: '' };
    } catch (error) {
      return {
        jobs: jobs,
        warning: 'BOSS 明文薪资接口暂不可用（' + (error.message || '未知错误') + '），已回退到页面字段'
      };
    }
  }

  async function scrape(count) {
    const seen = {};
    const jobs = [];
    let stall = 0;
    for (let loop = 0; loop < 40 && jobs.length < count && stall < 4; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        const j = parseCard(c);
        if (j.id && !seen[j.id]) { seen[j.id] = 1; jobs.push(j); added++; if (jobs.length >= count) break; }
      }
      if (added === 0) stall++; else stall = 0;
      if (jobs.length >= count) break;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await sleep(1200);
    }
    const apiResult = await fetchApiJobs(count);
    const merged = jobData
      ? jobData.mergeJobs(jobs, apiResult.jobs, count)
      : jobs.slice(0, count);
    return { jobs: merged, warning: apiResult.warning };
  }

  async function scrapeRecommendations(count) {
    if (!recommendationRoot()) {
      return {
        jobs: [],
        warning: '当前页面不是包含“精选职位”的 BOSS 首页'
      };
    }
    const seen = new Set();
    const jobs = [];
    let stall = 0;
    for (let loop = 0; loop < 30 && jobs.length < count && stall < 4; loop++) {
      let added = 0;
      for (const item of getRecommendationCards()) {
        const job = parseCard(item.card, item.link);
        if (!job.id || seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
        added++;
        if (jobs.length >= count) break;
      }
      if (added) stall = 0;
      else stall++;
      if (jobs.length >= count) break;
      window.scrollTo(0, document.body.scrollHeight);
      const root = recommendationRoot();
      if (root && root.scrollHeight > root.clientHeight) {
        root.scrollTop = root.scrollHeight;
      }
      await sleep(1000);
    }
    return {
      jobs: jobs.slice(0, count),
      warning: jobs.length
        ? ''
        : '未在当前 BOSS 首页找到“精选职位”岗位卡片，请先确认首页已正常显示推荐岗位'
    };
  }

  function findLoadedCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    if (job.id) return null;
    for (const c of cards) {
      const j = parseCard(c);
      if (j.name === job.name && job.company && j.company === job.company) return c;
    }
    return null;
  }

  function getScrollableJobLists() {
    const selectors = [
      '.job-list-container',
      '.job-list-box',
      '.job-list',
      '[class*="job-list"]'
    ];
    const seen = new Set();
    const lists = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (element.scrollHeight > element.clientHeight + 80) lists.push(element);
      }
    }
    return lists;
  }

  function cardBatchSignature() {
    return getCards().map(card => parseCard(card).id).filter(Boolean).join('|');
  }

  function resetJobListScroll() {
    window.scrollTo(0, 0);
    const root = document.scrollingElement;
    if (root) root.scrollTop = 0;
    for (const list of getScrollableJobLists()) list.scrollTop = 0;
  }

  function advanceJobListScroll() {
    window.scrollTo(0, document.body.scrollHeight);
    const root = document.scrollingElement;
    if (root) root.scrollTop = root.scrollHeight;
    for (const list of getScrollableJobLists()) list.scrollTop = list.scrollHeight;
  }

  // BOSS 的搜索结果会懒加载/虚拟化。收集时见过的岗位，重新打开搜索页后
  // 不一定在首批 DOM 中，因此必须逐批滚动并始终用岗位 ID 精确匹配。
  async function findCardByJob(job) {
    let card = findLoadedCardByJob(job);
    if (card) return { card: card, batches: 0 };

    resetJobListScroll();
    await sleep(500);
    card = findLoadedCardByJob(job);
    if (card) return { card: card, batches: 0 };

    let unchanged = 0;
    let previous = cardBatchSignature();
    for (let batch = 1; batch <= 16 && unchanged < 4; batch++) {
      advanceJobListScroll();
      await sleep(1000);
      card = findLoadedCardByJob(job);
      if (card) return { card: card, batches: batch };

      const current = cardBatchSignature();
      if (current && current !== previous) unchanged = 0;
      else unchanged++;
      previous = current;
    }
    return { card: null, batches: 0 };
  }

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 等待出现文字完全匹配的可见元素（用于弹窗"继续沟通"按钮）
  function waitForText(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const els = document.querySelectorAll('a, button, span, div');
        for (const el of els) {
          const tx = (el.textContent || '').trim();
          if (texts.indexOf(tx) >= 0 && el.offsetParent !== null) { clearInterval(iv); resolve(el); return; }
        }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD
  async function openJD(job) {
    const found = await findCardByJob(job);
    const card = found.card;
    if (!card) {
      return {
        success: false,
        code: 'JOB_CARD_NOT_FOUND',
        error: '滚动加载后仍未找到精确岗位卡片'
      };
    }
    card.scrollIntoView({ block: 'center' });
    await sleep(400);
    card.click();
    await sleep(1600);
    let jd = '';
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (det) jd = (det.innerText || '').trim();
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => (s.innerText || '').trim()).filter(Boolean).join('\n');
    }
    return { success: true, jd: jd.slice(0, 1800), cardBatches: found.batches };
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）
  async function goChat(job) {
    const found = await findCardByJob(job);
    const card = found.card;
    if (!card) {
      return {
        success: false,
        code: 'JOB_CARD_NOT_FOUND',
        error: '滚动加载后仍未找到本轮精确岗位卡片'
      };
    }
    const current = parseCard(card);
    if (!job.id || current.id !== job.id) return { success: false, error: '岗位 ID 校验失败' };
    card.scrollIntoView({ block: 'center' });
    await sleep(350);
    card.click();
    await sleep(1400);

    let btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!btn) {
      const all = document.querySelectorAll('a, button, span');
      for (const el of all) {
        const tx = (el.textContent || '').trim();
        if (tx === '立即沟通' && el.offsetParent !== null) { btn = el; break; }
      }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) {
      // 先让消息响应送达后台，再触发会使本页进入 BFCache 的导航。
      setTimeout(() => go.click(), 80);
      return { success: true, navigated: true };
    }
    return { success: true, navigated: false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20)
        .then(result => sendResponse({ success: true, jobs: result.jobs, warning: result.warning }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SCRAPE_RECOMMEND') {
      scrapeRecommendations(msg.count || 20)
        .then(result => sendResponse({ success: true, jobs: result.jobs, warning: result.warning }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
