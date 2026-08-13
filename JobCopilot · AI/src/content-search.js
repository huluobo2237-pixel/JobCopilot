// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 接收 MAIN world 钩子脚本（hook-api.js）截获的 BOSS 搜索接口明文数据
  const apiCache = [];
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'zp-hook' || !ev.data.payload) return;
    const p = ev.data.payload;
    if (!p || !Array.isArray(p.list) || !p.list.length) return;
    if (apiCache.some(x => x.url === p.url && x.list.length === p.list.length)) return;
    apiCache.push(p);
  });

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  // 依次尝试多个选择器，取第一个非空文本（去空白），避免单个选择器失效就抓空
  function pickText(root, sels) {
    for (const sel of sels) {
      const el = root.querySelector(sel);
      if (el) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }
    return '';
  }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const id = (m && m[1]) || ((nameEl ? nameEl.textContent.trim() : '') + '|' + (salEl ? salEl.textContent.trim() : ''));
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    // 当前版卡片：公司名在 .boss-name（链接 /gongsi/ 公司页）；旧版在 .company-name
    const company = pickText(card, [
      '.boss-info .boss-name',
      '.boss-name',
      '.company-info .company-name a, .company-info .company-name',
      '.job-card-footer .company-info .name a, .job-card-footer .company-info .name',
      '.company-text .name a, .company-text .name',
      '.company-name',
      '[class*="company-name"]'
    ]);
    const coLinkEl = card.querySelector('a[href*="/gongsi/"]') || card.querySelector('a[href*="/company_detail/"]');
    const companyLink = coLinkEl ? coLinkEl.href : '';
    // 当前版卡片不再显示 HR 名字（.boss-name 是公司名），HR 名留到详情面板/聊天页再读
    const hrName = '';
    const area = pickText(card, [SELECTORS.jobs.jobArea]);
    // 卡片文本里抓 HR 活跃度（刚刚活跃/今日活跃/3日内活跃/本周活跃/本月活跃）
    const actM = (card.textContent || '').match(/(刚刚活跃|今日活跃|\d+日内活跃|本周活跃|本月活跃|几乎不活跃)/);
    const activity = actM ? actM[1] : '';
    return {
      id: id,
      name: nameEl ? nameEl.textContent.trim() : '未知岗位',
      salary: salEl ? salEl.textContent.trim() : '',
      tags: tags,
      company: company,
      companyLink: companyLink,
      hrName: hrName,
      area: area,
      activity: activity,
      link: link
    };
  }

  // BOSS 用动态字体加密薪资数字（DOM 拿到的是乱码），改从页面自己的搜索 API 拿明文
  // salaryDesc / brandName / bossName，一并回填公司全名和 HR 名
  async function enrichFromApi(jobs) {
    let hit = 0;
    try {
      // 1) 优先用钩子截获的页面原始接口数据（带全量风控参数，最可靠）
      document.dispatchEvent(new CustomEvent('zp-hook-request'));
      await sleep(400);
      const byId = {};
      for (const p of apiCache) {
        for (const it of p.list) {
          if (it.encryptJobId) byId[it.encryptJobId] = it;
          if (it.jobId) byId[it.jobId] = it;
        }
      }
      const applyApi = (it, job) => {
        if (it.salaryDesc) job.salary = it.salaryDesc;
        if (it.brandName) job.company = it.brandName;
        if (it.bossName) job.hrName = it.bossName;
        if (it.bossAvatar) job.bossAvatar = it.bossAvatar;
        if (typeof it.bossOnline !== 'undefined') job.bossOnline = it.bossOnline;
        // 不管字段名叫什么，只要值里带活跃度文本就抓下来
        if (!job.activity) {
          for (const k in it) {
            const v = it[k];
            if (typeof v === 'string' && /(刚刚活跃|今日活跃|\d+日内活跃|本周活跃|本月活跃|几乎不活跃)/.test(v)) {
              job.activity = v;
              break;
            }
          }
        }
      };
      for (const job of jobs) {
        const it = byId[job.id];
        if (!it) continue;
        hit++;
        applyApi(it, job);
      }
      // 2) 兜底：id 对不上时，按 岗位名 + 公司名 匹配（名称组合足够唯一）
      if (!hit) {
        const allItems = [];
        for (const p of apiCache) allItems.push.apply(allItems, p.list);
        for (const job of jobs) {
          const it = allItems.find(x => x.jobName === job.name && x.brandName && job.company
            && (x.brandName.indexOf(job.company) >= 0 || job.company.indexOf(x.brandName) >= 0));
          if (!it) continue;
          hit++;
          applyApi(it, job);
        }
      }
      if (hit) return hit;

      // 3) 再兜底：按已知路径直接请求（可能因缺风控参数失败）
      let apiUrl = '';
      const resources = performance.getEntriesByType('resource').map(e => e.name);
      apiUrl = resources.find(u => u.indexOf('/wapi/zpgeek/') >= 0 && u.indexOf('joblist') >= 0) || '';
      if (!apiUrl) {
        const u = new URL(location.href);
        const p = new URLSearchParams({ scene: 1, query: u.searchParams.get('query') || '', city: u.searchParams.get('city') || '100010000', page: 1, pageSize: 30 });
        apiUrl = location.origin + '/wapi/zpgeek/search/joblist.json?' + p.toString();
      }
      const pages = Math.min(Math.ceil(jobs.length / 30), 2) || 1;
      for (let pg = 1; pg <= pages; pg++) {
        const url = new URL(apiUrl);
        url.searchParams.set('page', pg);
        const resp = await fetch(url.href, { credentials: 'include' });
        if (!resp.ok) continue;
        const data = await resp.json();
        const list = (data && data.zpData && Array.isArray(data.zpData.jobList)) ? data.zpData.jobList : [];
        for (const it of list) {
          if (it.encryptJobId) byId[it.encryptJobId] = it;
          if (it.jobId) byId[it.jobId] = it;
        }
        if (list.length < 30) break;
      }
      for (const job of jobs) {
        const it = byId[job.id];
        if (!it) continue;
        hit++;
        applyApi(it, job);
      }
      return hit;
    } catch (e) {
      console.error('enrichFromApi:', e);
      return 0;
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
    // API 补全：明文薪资 + 公司全名 + HR 名
    await enrichFromApi(jobs);
    // 收集统计：便于核对抓取质量
    if (jobs.length) {
      chrome.runtime.sendMessage({
        type: 'LOG',
        text: '收集完成：' + jobs.length + ' 个岗位（公司名 ' + jobs.filter(j => j.company).length
          + '、薪资 ' + jobs.filter(j => /\d/.test(j.salary || '')).length
          + '、活跃度 ' + jobs.filter(j => j.activity).length + '）',
        level: 'info'
      }).catch(() => {});
    }
    return jobs.slice(0, count);
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    for (const c of cards) { const j = parseCard(c); if (j.name === job.name && (!job.company || j.company === job.company)) return c; }
    return null;
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
    const card = findCardByJob(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
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
    // 详情面板通常也有公司名，作为卡片抓取失败的兜底
    let company = pickText(document, [
      '.job-detail-box .company-info .name, .job-detail-box .company-info a',
      '.job-detail-box [class*="company-name"]',
      '.job-detail-box .company-info',
      '[class*="job-detail"] [class*="company"]'
    ]);
    if (company && (company.match(/·/g) || []).length >= 2) company = '';
    const hrName = pickText(document, ['.job-detail-box .boss-name', '.job-detail-box [class*="boss-name"]']);
    const coLinkEl = document.querySelector('.job-detail-box a[href*="/gongsi/"], .job-detail-box a[href*="/company_detail/"]');
    return { success: true, jd: jd.slice(0, 1800), company: company, companyLink: coLinkEl ? coLinkEl.href : '', hrName: hrName };
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）
  async function goChat(job) {
    let btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!btn) {
      const all = document.querySelectorAll('a, button, span');
      for (const el of all) { const tx = (el.textContent || '').trim(); if (tx === '立即沟通' || tx === '继续沟通') { btn = el; break; } }
    }
    if (!btn) { // 面板可能关了，重新点卡片
      const card = findCardByJob(job);
      if (card) { card.click(); await sleep(1200); btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 4000); }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { go.click(); return { success: true, navigated: true }; }
    return { success: true, navigated: false };
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
