// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }
  function getJobId(url) {
    const match = (url || '').match(/\/job_detail\/([^/?]+)\.html/);
    return (match && match[1]) || '';
  }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const id = (m && m[1]) || ((nameEl ? nameEl.textContent.trim() : '') + '|' + (salEl ? salEl.textContent.trim() : ''));
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    let company = '';
    const compEl = card.querySelector('.company-name a, .company-name, [class*="company-name"], .boss-info .company-name, .company-info a, [class*="company"] a');
    if (compEl) company = compEl.textContent.trim();
    return {
      id: id,
      name: nameEl ? nameEl.textContent.trim() : '未知岗位',
      salary: salEl ? salEl.textContent.trim() : '',
      tags: tags,
      company: company,
      link: link
    };
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
    return jobs.slice(0, count);
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    return null;
  }

  function readJD() {
    let jd = '';
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (det) jd = (det.innerText || '').trim();
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => (s.innerText || '').trim()).filter(Boolean).join('\n');
    }
    return jd.slice(0, 1800);
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

  // 确认当前页面就是已选岗位，再读取完整 JD
  async function openJD(job) {
    const currentId = getJobId(window.location.href);
    if (currentId) {
      if (!job || !job.id || currentId !== job.id) return { success: false, error: '当前详情与已选岗位不一致' };
      return { success: true, jobId: currentId, jd: readJD() };
    }

    const card = findCardByJob(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
    const cardJob = parseCard(card);
    if (!job || !job.id || cardJob.id !== job.id) return { success: false, error: '岗位卡片与已选岗位不一致' };
    card.scrollIntoView({ block: 'center' });
    await sleep(400);
    card.click();
    await sleep(1600);
    return { success: true, jobId: cardJob.id, jd: readJD() };
  }

  // 只有当前详情页与已选岗位 ID 一致时，才允许建立联系
  async function goChat(job) {
    const currentId = getJobId(window.location.href);
    if (!job || !job.id || currentId !== job.id) return { success: false, error: '当前详情与已选岗位不一致' };
    let btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!btn) {
      const all = document.querySelectorAll('a, button, span');
      for (const el of all) { const tx = (el.textContent || '').trim(); if (tx === '立即沟通' || tx === '继续沟通') { btn = el; break; } }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { go.click(); return { success: true, navigated: true, jobId: currentId }; }
    return { success: true, navigated: false, jobId: currentId };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20).then(jobs => sendResponse({ success: true, jobs: jobs })).catch(e => sendResponse({ success: false, error: e.message }));
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
