// ===== BOSS自动投递 Service Worker：编排 收集→筛选→审核→投递 + MuskAI GPT-5.6 =====
importScripts('/src/selectors.js', '/src/job-data-core.js', '/src/greeting-core.js', '/src/mobile-followup-core.js', '/src/job-detail-popup-capture.js', '/src/job-detail-tab-capture.js', '/src/trusted-click-core.js', '/src/muskapi-client.js'); // 让 SW 使用城市、岗位、招呼语与 AI 客户端
const aiClient = MuskAIClient.createClient();
const deliveryGate = JobDataCore.createDeliveryGate();
const followupGate = JobDataCore.createDeliveryGate();
const MAX_OCR_IMAGES = 5;
const MAX_OCR_DATA_LENGTH = 12 * 1024 * 1024;
const MAX_RECOMMEND_REFRESHES = 24;
const SCREEN_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'job_screening',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        match: { type: 'boolean' },
        reason: { type: 'string' }
      },
      required: ['match', 'reason'],
      additionalProperties: false
    }
  }
};
const GREETING_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'boss_greeting',
    strict: true,
    schema: {
      type: 'object',
      properties: { greeting: { type: 'string' } },
      required: ['greeting'],
      additionalProperties: false
    }
  }
};

let state = {
  phase: 'idle', paused: false, aborted: false,
  jobs: [], screened: [], greetings: {}, results: [], processed: {},
  lastActivityAt: Date.now()
};

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  try {
    await chrome.storage.local.remove('dsKey');
    const cfg = await chrome.storage.local.get(['gptModel']);
    if (!cfg.gptModel) {
      await chrome.storage.local.set({ gptModel: MuskAIClient.DEFAULT_MODEL });
    }
  } catch (error) {}
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// ── 小工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
function touchActivity() { state.lastActivityAt = Date.now(); }
function isTaskRunning() {
  return state.phase === 'collecting' ||
    state.phase === 'screening' ||
    state.phase === 'delivering' ||
    state.phase === 'drafting_followups' ||
    state.phase === 'sending_followups';
}
function log(text, level) { touchActivity(); chrome.runtime.sendMessage({ type: 'LOG', text: text, level: level || 'info' }).catch(() => {}); }
function pushPhase() { touchActivity(); chrome.runtime.sendMessage({ type: 'PHASE', phase: state.phase }).catch(() => {}); }
function progress(cur, total, label) { touchActivity(); chrome.runtime.sendMessage({ type: 'PROGRESS', cur: cur, total: total, label: label || '' }).catch(() => {}); }
async function waitIfPaused() { while (state.paused && !state.aborted) await sleep(400); }
function getCfg() { return chrome.storage.local.get(['muskApiKey', 'gptModel', 'resumeText', 'resumeImage', 'resumeImages', 'collectionSource', 'screeningMode', 'city', 'keyword', 'count']); }
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
function jobInfo(j) { return '岗位：' + (j.name || '') + '\n技能标签：' + ((j.tags || []).join('、')) + '\n薪资：' + (j.salary || '') + '\n公司：' + (j.company || '') + '\n地区：' + (j.area || ''); }
function findJob(id) { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === id) return state.jobs[i]; return null; }
// ── MuskAI GPT-5.6 ──
function selectedModel(cfg) {
  return MuskAIClient.normalizeModel(cfg.gptModel);
}
async function callAI(cfg, messages, maxCompletionTokens, responseFormat) {
  return aiClient.chat({
    apiKey: cfg.muskApiKey,
    model: selectedModel(cfg),
    messages: messages,
    maxCompletionTokens: maxCompletionTokens,
    responseFormat: responseFormat
  });
}

// 筛选：只判断是否值得投（用岗位标签快速判断，不生成招呼语）
async function screenJob(cfg, job) {
  if (
    JobDataCore.normalizeCollectionSource(cfg.collectionSource) === 'recommend' &&
    JobDataCore.obviousRecommendationMismatch(cfg.keyword, job && job.name)
  ) {
    return { match: false, reason: '岗位名称与目标技术方向明显无关，已在 AI 请求前剔除' };
  }
  const recommendationRule = JobDataCore.normalizeCollectionSource(cfg.collectionSource) === 'recommend'
    ? '\n【首页推荐严格规则】推荐流会混入噪声岗位。岗位名称或工作方向只要与目标岗位关键词明显无关，就必须返回 match=false；不得因为“学历可达”“薪资合适”或公司看起来正常而保留。'
    : '';
  const sys = '你是资深求职助手。请依据【目标岗位关键词】和【求职者简历】，判断某个岗位是否值得投递。\n【判断标准·适中】保留(match=true)：岗位方向与目标关键词一致或高度相关，且与求职者专业/技能/经历相关，经验年限、学历、级别够得着。剔除(match=false)：岗位方向与目标关键词明显无关；工作内容与简历明显无关；经验/学历/硬技能明显超出简历；岗位级别明显过高。' + recommendationRule + '\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"reason":"一句话理由"}';
  const user = '目标岗位关键词：' + (cfg.keyword || '') + '\n\n求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  const raw = await callAI(
    cfg,
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    300,
    SCREEN_RESPONSE_FORMAT
  );
  const parsed = MuskAIClient.extractJsonObject(raw);
  if (!parsed || typeof parsed.match !== 'boolean') {
    return { match: false, reason: 'AI 返回内容无法解析' };
  }
  return {
    match: parsed.match,
    reason: typeof parsed.reason === 'string' ? parsed.reason : ''
  };
}

// 投递时：结合该岗位的【完整JD】+ 简历，现场生成专属招呼语
async function genGreetingFromJD(cfg, job, jd) {
  const jdText = (jd && jd.trim()) ? jd.trim() : ('技能标签：' + (job.tags || []).join('、'));
  const firstRaw = await callAI(
    cfg,
    GreetingCore.buildMessages({ resumeText: resumeFull(cfg), job: job, jd: jdText }),
    800,
    GREETING_RESPONSE_FORMAT
  );
  const firstParsed = MuskAIClient.extractJsonObject(firstRaw);
  const first = GreetingCore.sanitizeGreeting(firstParsed && firstParsed.greeting ? firstParsed.greeting : firstRaw);
  const assessment = GreetingCore.assessGreeting(first);
  if (assessment.ok) return first;

  const retryRaw = await callAI(
    cfg,
    GreetingCore.buildMessages({
      resumeText: resumeFull(cfg),
      job: job,
      jd: jdText,
      previousDraft: first,
      issues: assessment.issues
    }),
    800,
    GREETING_RESPONSE_FORMAT
  );
  const retryParsed = MuskAIClient.extractJsonObject(retryRaw);
  const retry = GreetingCore.sanitizeGreeting(retryParsed && retryParsed.greeting ? retryParsed.greeting : retryRaw);
  return GreetingCore.chooseBetterGreeting(first, retry);
}

async function genSupplementFromJD(cfg, conversation, job, jd) {
  const sys = '你是求职者本人。你已经在BOSS直聘给HR发送过一条通用自我介绍，现在要补发一条基于岗位JD的具体说明。回复会原样发给HR，严禁注释、标题、括号备注、字数统计或任何引导语。\n要求：1.不要重复“您好，我是某学校学生”等身份开场；2.从JD中选择2-3个与你简历真实匹配的技能或职责；3.明确提到简历中对应的项目、实践或成果，不得虚构；4.用“补充一下”或自然衔接开头；5.全文60-120字，语气真诚简洁，不要求HR立即回复。';
  const user = '我的简历：\n' + resumeFull(cfg) +
    '\n\n目标公司：' + (conversation.company || job.company || '未获取') +
    '\n目标岗位：' + (job.name || conversation.position || '未获取') +
    '\n岗位JD：\n' + String(jd || '').slice(0, 5000) +
    '\n\n请直接输出一条可补发给该HR的具体介绍。';
  const raw = await callAI(
    cfg,
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    500
  );
  return (raw || '').trim();
}

async function testAIConnection() {
  const cfg = await getCfg();
  const model = selectedModel(cfg);
  const reply = await callAI(
    cfg,
    [
      { role: 'system', content: '这是连接测试。只回复 OK，不要输出其他内容。' },
      { role: 'user', content: '请确认连接正常。' }
    ],
    128
  );
  if (!reply.trim()) throw new Error('MuskAI 连接成功，但模型没有返回内容');
  return { model: model, reply: reply.trim() };
}

function cleanOcrText(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

async function ocrResumeImages(images) {
  if (!Array.isArray(images) || !images.length || images.length > MAX_OCR_IMAGES) {
    throw new Error('OCR 仅支持 1-' + MAX_OCR_IMAGES + ' 页简历');
  }
  let totalLength = 0;
  for (const image of images) {
    if (typeof image !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,/i.test(image)) {
      throw new Error('OCR 图片格式无效');
    }
    totalLength += image.length;
  }
  if (totalLength > MAX_OCR_DATA_LENGTH) {
    throw new Error('OCR 图片总大小过大，请压缩或减少页数');
  }

  const cfg = await getCfg();
  const model = selectedModel(cfg);
  const content = [
    {
      type: 'text',
      text: '请按页面顺序准确转写这份中文或英文简历。保留姓名、联系方式、标题、时间、公司、学校、项目、技能和项目符号的文字层级；不要总结、润色、评价、推测或补写。只输出可直接粘贴到纯文本框的简历全文。'
    }
  ];
  images.forEach(image => {
    content.push({
      type: 'image_url',
      image_url: { url: image, detail: 'high' }
    });
  });

  const raw = await callAI(
    cfg,
    [
      {
        role: 'system',
        content: '你是只做忠实转写的简历 OCR 助手。不得虚构原图中不存在的经历或信息。'
      },
      { role: 'user', content: content }
    ],
    6000
  );
  const text = cleanOcrText(raw);
  if (!text) throw new Error('MuskAI 未返回可用的简历文字');
  return { text: text, model: model };
}

function ocrErrorMessage(error) {
  if (error && (error.status === 400 || error.status === 422)) {
    return 'MuskAI 中转站或所选模型可能不支持图片识别，请改用本地可解析的 PDF、DOCX 或 TXT';
  }
  return error && error.message ? error.message : 'MuskAI OCR 失败';
}

// ── tab 注入 + 发消息 ──
async function ensureInjected(tabId, file) {
  const files = ['src/selectors.js'];
  if (file === 'src/content-search.js') files.push('src/job-data-core.js');
  if (file === 'src/content-chat.js') files.push('src/mobile-followup-core.js');
  files.push(file);
  try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: files }); } catch (e) {}
}
function sendToTab(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      touchActivity();
      resolve(response);
    };
    const timer = setTimeout(() => {
      finish({
        success: false,
        timedOut: true,
        error: 'BOSS 页面操作超时，请保持侧边栏开启后重试'
      });
    }, timeoutMs || 60000);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) finish({ success: false, error: chrome.runtime.lastError.message });
      else finish(resp || { success: false, error: 'no response' });
    });
  });
}
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = loaded => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(lis);
      setTimeout(() => resolve(loaded), 1200);
    };
    function lis(id, info) { if (id === tabId && info.status === 'complete') finish(true); }
    const timer = setTimeout(() => finish(false), timeoutMs || 30000);
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) finish(false);
      else if (t && t.status === 'complete') finish(true);
    });
  });
}
function resolveCities(cfg) {
  return JobDataCore.resolveCitySearches(
    cfg.city || '',
    typeof CITY_MAP !== 'undefined' ? CITY_MAP : {}
  );
}
function buildSearchUrl(cfg, city) {
  const selectedCity = city || resolveCities(cfg).cities[0];
  const params = new URLSearchParams({ query: cfg.keyword || '', city: selectedCity.code });
  // 行业/规模：BOSS 代码不确定，暂不加入（错误代码会导致搜不到任何岗位）
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
}
function buildRecommendationUrl() {
  return 'https://www.zhipin.com/';
}
async function ensureTab(url) {
  let tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  let tab = tabs[0];
  if (!tab) tab = await chrome.tabs.create({ url: url });
  else await chrome.tabs.update(tab.id, { url: url });
  await waitTabComplete(tab.id);
  await sleep(2000);
  return tab;
}
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false;
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
  state.phase = 'collecting'; pushPhase();
  const cfg = await getCfg();
  const collectionSource = JobDataCore.normalizeCollectionSource(cfg.collectionSource);
  const screeningMode = JobDataCore.effectiveScreeningMode(collectionSource, cfg.screeningMode);
  if (screeningMode === 'ai' && !cfg.muskApiKey) { log('AI 精准筛选需要 MuskAI API Key', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!cfg.keyword) { log('请先填写岗位关键词', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (screeningMode === 'ai' && !(cfg.resumeText || '').trim()) { log('AI 精准筛选需要先填写“简历文字”', 'error'); state.phase = 'idle'; pushPhase(); return; }

  const count = Math.min(200, Math.max(1, parseInt(cfg.count) || 20));
  if (collectionSource === 'recommend') {
    log('开始读取 BOSS 首页“精选职位”，目标 ' + count + ' 个；本模式固定执行 AI 相关性筛选');
    try {
      const collected = await scrapeHomepageRecommendations(count);
      const response = collected.response;
      if (!response || !response.success) {
        log('首页推荐收集失败：' + ((response && response.error) || '页面无响应'), 'error');
      } else {
        if (response.warning) log(response.warning, 'warn');
        const sourceUrl = (collected.tab && collected.tab.url) || buildRecommendationUrl();
        state.jobs = (response.jobs || []).map(job => Object.assign({}, job, {
          collectionSource: 'recommend',
          sourceSearchUrl: sourceUrl
        }));
        if (response.refreshCount) {
          log('首页推荐已自动刷新 ' + response.refreshCount + ' 次，并按岗位 ID 去重', 'success');
        }
        log('首页推荐收集到 ' + state.jobs.length + ' 个岗位，准备按目标方向筛除无关岗位', 'success');
      }
    } catch (error) {
      log('首页推荐收集失败：' + (error.message || '页面导航异常'), 'error');
    }
  } else {
    const cityResolution = resolveCities(cfg);
    const cities = cityResolution.cities;
    const targets = JobDataCore.allocateCityTargets(cities.length, count);
    const effectiveTarget = targets.reduce((sum, value) => sum + value, 0);
    const cityResults = [];

    if (cityResolution.unknown.length) {
      const action = cityResolution.usedFallback ? '未识别任何城市，已按全国搜索' : '已忽略';
      log('未识别城市：' + cityResolution.unknown.join('、') + '；' + action, 'warn');
    }
    if (effectiveTarget !== count) {
      log('收集数量少于城市数，已调整为每个城市至少 1 个岗位', 'warn');
    }
    log('开始多城市收集：' + cities.map(city => city.name).join('、') + ' | 总目标 ' + effectiveTarget + ' 个');

    for (let index = 0; index < cities.length; index++) {
      if (state.aborted) break;
      await waitIfPaused();
      if (state.aborted) break;
      const city = cities[index];
      const cityTarget = targets[index];
      const searchUrl = buildSearchUrl(cfg, city);
      log('[' + (index + 1) + '/' + cities.length + '] 打开 ' + city.name + ' 搜索页，目标 ' + cityTarget + ' 个岗位');
      try {
        const tab = await ensureTab(searchUrl);
        await ensureInjected(tab.id, 'src/content-search.js');
        const r = await sendToTab(tab.id, { type: 'SCRAPE', count: cityTarget }, 120000);
        if (!r || !r.success) {
          log(city.name + '收集失败：' + ((r && r.error) || '页面无响应'), 'error');
          continue;
        }
        if (r.warning) log(city.name + '：' + r.warning, 'warn');
        cityResults.push({
          cityName: city.name,
          cityCode: city.code,
          searchUrl: searchUrl,
          jobs: r.jobs || []
        });
        log(city.name + '收集到 ' + ((r.jobs && r.jobs.length) || 0) + ' 个岗位', 'success');
      } catch (error) {
        log(city.name + '收集失败：' + (error.message || '页面导航异常'), 'error');
      }
    }

    state.jobs = JobDataCore.mergeCityJobResults(cityResults, effectiveTarget);
    log('多城市合并去重后共 ' + state.jobs.length + ' 个岗位', 'success');
  }
  if (!state.jobs.length) { state.phase = 'idle'; pushPhase(); return; }

  if (screeningMode === 'bulk') {
    state.screened = JobDataCore.approveJobsForBulk(state.jobs);
    progress(state.screened.length, state.screened.length, '海投审核');
    log(
      '海投模式：已跳过 AI 前置筛选，' +
      state.screened.length +
      ' / ' +
      state.jobs.length +
      ' 个有效岗位进入人工审核',
      'success'
    );
    await chrome.storage.local.set({
      sw_jobs: state.jobs,
      sw_greetings: state.greetings,
      sw_screened: state.screened
    });
    state.phase = 'review'; pushPhase();
    chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
    return;
  }

  // 筛选（并发3）
  state.phase = 'screening'; pushPhase();
  log('AI 筛选中（MuskAI ' + selectedModel(cfg) + '）...');
  let done = 0; const total = state.jobs.length;
  progress(0, total, '筛选');
  const CONC = 3;
  for (let i = 0; i < state.jobs.length; i += CONC) {
    if (state.aborted) break; await waitIfPaused();
    const batch = state.jobs.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      let res;
      try { res = await screenJob(cfg, job); }
      catch (e) { res = { match: false, reason: '筛选异常:' + e.message }; }
      state.screened.push(Object.assign({}, job, { match: res.match, reason: res.reason }));
      done++; progress(done, total, '筛选');
    }));
  }
  const matched = state.screened.filter(j => j.match === true).length;
  log('筛选完成：匹配 ' + matched + ' / ' + total, 'success');
  // 存盘：SW 可能在审核期间被浏览器回收，投递时需从存储读回
  await chrome.storage.local.set({ sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened });
  state.phase = 'review'; pushPhase();
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}

async function scrapeHomepageRecommendations(count) {
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  const candidates = tabs.slice().sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)));
  for (const candidate of candidates) {
    try {
      if (candidate.status !== 'complete') await waitTabComplete(candidate.id, 15000);
      await ensureInjected(candidate.id, 'src/content-search.js');
      const response = await sendToTab(candidate.id, { type: 'SCRAPE_RECOMMEND', count: count }, 120000);
      if (response && response.success && Array.isArray(response.jobs) && response.jobs.length) {
        return collectRecommendationRefreshRounds(candidate, count, response);
      }
    } catch (error) {}
  }

  const tab = await ensureTab(buildRecommendationUrl());
  return collectRecommendationRefreshRounds(tab, count, null);
}

async function collectRecommendationRefreshRounds(tab, count, initialResponse) {
  let jobs = [];
  let response = initialResponse;
  let refreshCount = 0;
  let refreshLimit = 4;
  let noNewJobRounds = 0;
  const warnings = [];

  while (jobs.length < count && refreshCount <= MAX_RECOMMEND_REFRESHES) {
    if (state.aborted) break;
    await waitIfPaused();
    if (state.aborted) break;

    if (!response) {
      await ensureInjected(tab.id, 'src/content-search.js');
      response = await sendToTab(tab.id, { type: 'SCRAPE_RECOMMEND', count: count }, 120000);
    }
    if (response && response.success && Array.isArray(response.jobs)) {
      const beforeMerge = jobs.length;
      jobs = JobDataCore.mergeUniqueJobs(jobs, response.jobs, count);
      if (beforeMerge === 0) {
        refreshLimit = JobDataCore.recommendationRefreshLimit(count, response.jobs.length, MAX_RECOMMEND_REFRESHES);
      }
      if (refreshCount > 0) {
        if (jobs.length === beforeMerge) noNewJobRounds++;
        else noNewJobRounds = 0;
      }
      if (response.warning) warnings.push(response.warning);
    } else if (response && response.error) {
      warnings.push(response.error);
      if (refreshCount > 0) noNewJobRounds++;
    }

    if (
      jobs.length >= count ||
      refreshCount >= refreshLimit ||
      noNewJobRounds >= 2 ||
      state.aborted
    ) break;
    log('当前推荐去重后 ' + jobs.length + '/' + count + '，正在刷新 BOSS 首页获取新推荐（' + (refreshCount + 1) + '/' + refreshLimit + '）...');
    await chrome.tabs.reload(tab.id);
    const loaded = await waitTabComplete(tab.id, 30000);
    if (!loaded) {
      warnings.push('刷新 BOSS 首页后等待加载超时');
      break;
    }
    await sleep(2000);
    refreshCount++;
    response = null;
  }

  if (jobs.length < count && !state.aborted) {
    const suffix = noNewJobRounds >= 2 ? '；连续两轮没有新岗位，已停止刷新' : '';
    warnings.push('自动刷新 ' + refreshCount + ' 次后，共收集到 ' + jobs.length + '/' + count + ' 个不重复推荐岗位' + suffix);
  }
  return {
    tab: tab,
    response: {
      success: jobs.length > 0,
      jobs: jobs,
      refreshCount: refreshCount,
      warning: Array.from(new Set(warnings.filter(Boolean))).join('；'),
      error: jobs.length ? '' : '未在 BOSS 首页找到可读取的“精选职位”岗位卡片'
    }
  };
}

// ── 流程：为手机端刚投递的会话生成并审核补充介绍 ──
function exactJobDetailUrl(job) {
  job = job || {};
  const id = String(job.id || '').trim();
  if (!id) return '';
  const saved = MobileFollowupCore.normalizeExactJobDetailUrl(String(job.link || '').trim(), id);
  if (saved) return saved;

  const url = new URL('/job_detail/' + encodeURIComponent(id) + '.html', 'https://www.zhipin.com/');
  if (job.lid) url.searchParams.set('lid', String(job.lid));
  if (job.securityId) url.searchParams.set('securityId', String(job.securityId));
  return MobileFollowupCore.normalizeExactJobDetailUrl(url.href, id);
}

async function readJobDetailInTab(tabId, jobUrl, expectedJob) {
  const safeUrl = MobileFollowupCore.normalizeJobDetailUrl(jobUrl);
  if (!safeUrl) return { success: false, error: '岗位详情链接无效或不属于 BOSS' };
  const tab = await chrome.tabs.update(tabId, { url: safeUrl });
  const loaded = await waitTabComplete(tab.id, 30000);
  if (!loaded) return { success: false, error: '岗位详情页加载超时' };
  await ensureInjected(tab.id, 'src/content-job-detail.js');
  return sendToTab(tab.id, { type: 'READ_JOB_DETAIL', job: expectedJob || null }, 20000);
}

async function captureActiveJobDetailUrl(tabId) {
  let inspected = {};
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: JobDetailPopupCapture.captureJobDetailUrlInPage,
      args: [{ interceptWindowOpen: false }]
    });
    inspected = results && results[0] && results[0].result ? results[0].result : {};
    const url = MobileFollowupCore.normalizeJobDetailUrl(inspected.url);
    if (url) {
      return {
        success: true,
        triggerFound: Boolean(inspected.triggerFound),
        url: url,
        source: inspected.source || '',
        error: ''
      };
    }
  } catch (error) {
    inspected = { triggerFound: false, inspectError: error.message || '岗位详情入口检查失败' };
  }

  if (inspected.triggerFound === false) {
    return {
      success: false,
      triggerFound: false,
      url: '',
      source: '',
      error: inspected.inspectError || '当前会话没有可读取的“查看职位”入口'
    };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: JobDetailPopupCapture.captureJobDetailUrlInPage,
      args: [{ interceptWindowOpen: true, captureDelayMs: 1800 }]
    });
    const intercepted = results && results[0] && results[0].result ? results[0].result : {};
    const url = MobileFollowupCore.normalizeJobDetailUrl(intercepted.url);
    if (url) {
      return {
        success: true,
        triggerFound: true,
        url: url,
        source: intercepted.source || 'window.open',
        error: ''
      };
    }
    if (intercepted.triggerFound === false) {
      return {
        success: false,
        triggerFound: false,
        url: '',
        source: '',
        error: '当前会话没有可点击的“查看职位”入口'
      };
    }
  } catch (error) {
    // A real new-tab listener remains as the final compatibility fallback.
  }

  try {
    const openerTab = await chrome.tabs.get(tabId);
    const captured = await JobDetailTabCapture.captureNewJobDetailTab({
      tabs: chrome.tabs,
      openerTabId: tabId,
      openerWindowId: openerTab.windowId,
      timeoutMs: 8000,
      click: async () => {
        const pointResults = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: JobDetailPopupCapture.getJobDetailClickPointInPage
        });
        const point = pointResults && pointResults[0] ? pointResults[0].result : {};
        if (!point || point.triggerFound === false) {
          return { triggerFound: false, clicked: false };
        }
        const trusted = await TrustedClickCore.dispatchTrustedClick({
          debuggerApi: chrome.debugger,
          tabId: tabId,
          x: point.x,
          y: point.y
        });
        if (trusted.success) {
          return { triggerFound: true, clicked: true, method: 'trusted-input' };
        }

        const fallbackResults = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: JobDetailPopupCapture.clickJobDetailTriggerInPage
        });
        const fallback = fallbackResults && fallbackResults[0] ? fallbackResults[0].result : {};
        if (fallback && fallback.clicked) return fallback;
        throw new Error(trusted.error || '“查看职位”入口点击失败');
      }
    });
    const closeIds = new Set(captured.cleanupTabIds || []);
    if (Number.isInteger(captured.tabId)) closeIds.add(captured.tabId);
    await Promise.all(Array.from(closeIds).map(id => chrome.tabs.remove(id).catch(() => {})));
    const url = MobileFollowupCore.normalizeJobDetailUrl(captured.url);
    return {
      success: Boolean(url),
      triggerFound: true,
      url: url,
      source: url ? 'created-tab' : '',
      error: url ? '' : (captured.error || '点击“查看职位”后未读取到准确岗位链接')
    };
  } catch (error) {
    return {
      success: false,
      triggerFound: true,
      url: '',
      source: '',
      error: error.message || '岗位详情标签页捕获失败'
    };
  }
}

async function runFollowupDrafting(params) {
  if (!followupGate.tryStart()) return { ok: false, error: '已有手机投递补充任务正在运行' };
  let detailTabId = null;
  try {
    const scanConfig = MobileFollowupCore.validateScanParams(params);
    if (!scanConfig.ok) return { ok: false, error: scanConfig.error };
    const cfg = await getCfg();
    if (!cfg.muskApiKey) return { ok: false, error: '请先填写 MuskAI API Key' };
    if (!resumeFull(cfg)) return { ok: false, error: '请先填写简历文字' };

    state.aborted = false;
    state.paused = false;
    state.phase = 'drafting_followups';
    pushPhase();
    if (scanConfig.mode === 'count') {
      log('扫描会话列表最前面的 ' + scanConfig.count + ' 条会话');
    } else {
      log('扫描手机投递会话：' + scanConfig.date + ' ' + params.start + '–' + params.end);
    }

    const chatTab = await ensureTab('https://www.zhipin.com/web/geek/chat');
    await ensureInjected(chatTab.id, 'src/content-chat.js');
    const scan = await sendToTab(
      chatTab.id,
      { type: 'SCAN_MOBILE_CONVERSATIONS', params: params },
      90000
    );
    if (!scan || !scan.success) throw new Error((scan && scan.error) || '会话扫描失败');

    const candidates = (scan.conversations || []).slice(0, 50);
    if (scanConfig.mode === 'count') {
      log('聊天列表读取 ' + (scan.scannedCount || 0) + ' 条，将检查最前面的 ' +
        (scan.inspectedCount || 0) + ' 条');
    } else {
      log('聊天列表读取 ' + (scan.scannedCount || 0) + ' 条，日期/时间候选 ' +
        (scan.rangeCount || 0) + ' 条（需点开确认分钟 ' + (scan.dateOnlyCount || 0) +
        ' 条），通用开场白候选 ' + candidates.length + ' 条');
    }
    if (!candidates.length) {
      state.phase = 'idle';
      pushPhase();
      if (!(scan.scannedCount || 0)) {
        return { ok: false, error: '没有读取到 BOSS 会话列表，请刷新聊天页后重试' };
      }
      if (scanConfig.mode === 'count') {
        return { ok: false, error: '没有读取到可检查的最近会话' };
      }
      if (!(scan.rangeCount || 0)) {
        return { ok: false, error: '已读取会话，但没有找到所选日期的会话' };
      }
      return { ok: false, error: '所选日期有会话，但预览不是“您好，我是…”格式的通用开场白' };
    }

    const drafts = [];
    let dateOnlyOutsideRange = 0;
    progress(0, candidates.length, '生成补充草稿');
    for (let index = 0; index < candidates.length; index++) {
      if (state.aborted) break;
      await waitIfPaused();
      if (state.aborted) break;
      const conversation = candidates[index];
      log('[' + (index + 1) + '/' + candidates.length + '] ' +
        (conversation.hrName || '未知 HR') + ' - ' +
        (conversation.company || conversation.position || '岗位待识别'));

      if (conversation.scanError) {
        drafts.push(Object.assign({}, conversation, { text: '', error: conversation.scanError }));
        progress(index + 1, candidates.length, '生成补充草稿');
        continue;
      }

      const selection = await sendToTab(chatTab.id, {
        type: 'SELECT_MOBILE_CONVERSATION',
        target: conversation
      }, 20000);
      if (!selection || !selection.success) {
        drafts.push(Object.assign({}, conversation, {
          text: '',
          error: (selection && selection.error) || '当前会话定位失败'
        }));
        progress(index + 1, candidates.length, '生成补充草稿');
        continue;
      }

      const context = selection.context || {};
      conversation.hrName = context.hrName || conversation.hrName;
      conversation.position = context.position || conversation.position;
      conversation.company = context.company || conversation.company;
      const matchingIntro = conversation.timeMatchMode === 'count'
        ? MobileFollowupCore.findRecentOutgoingGenericIntro(context.recentSelfMessages)
        : MobileFollowupCore.findMatchingOutgoingGenericIntro(
          conversation.preview,
          context.recentSelfMessages
        );
      if (conversation.timeMatchMode === 'count' && !matchingIntro) {
        drafts.push(Object.assign({}, conversation, {
          text: '',
          error: '该会话最近记录中未找到你发送的通用开场白，已跳过'
        }));
        progress(index + 1, candidates.length, '生成补充草稿');
        continue;
      }
      if (conversation.timeMatchMode === 'count' && matchingIntro.text) {
        conversation.preview = matchingIntro.text;
      }
      if (conversation.timeMatchMode !== 'count' && !MobileFollowupCore.confirmOutgoingGenericIntro(
        conversation.preview,
        context.recentSelfMessages
      )) {
        drafts.push(Object.assign({}, conversation, {
          text: '',
          error: '无法确认该通用开场白是由你发送的消息，已阻止生成和发送'
        }));
        progress(index + 1, candidates.length, '生成补充草稿');
        continue;
      }
      if (conversation.timeMatchMode === 'count' && matchingIntro.timeText) {
        const listTime = String(conversation.timeText || '').trim();
        const messageTime = String(matchingIntro.timeText || '').trim();
        conversation.timeText = listTime && !listTime.includes(messageTime)
          ? listTime + ' ' + messageTime
          : (listTime || messageTime);
      }
      if (conversation.timeMatchMode === 'date_only') {
        if (!matchingIntro || !matchingIntro.timeText) {
          drafts.push(Object.assign({}, conversation, {
            text: '',
            error: '会话列表只显示“昨天”，且聊天记录未显示该开场白的准确时间，已阻止生成和发送'
          }));
          progress(index + 1, candidates.length, '生成补充草稿');
          continue;
        }
        const resolvedTime = MobileFollowupCore.resolveMessageDateTime(
          matchingIntro.timeText,
          conversation.timeText,
          new Date()
        );
        if (!resolvedTime) {
          drafts.push(Object.assign({}, conversation, {
            text: '',
            error: '无法解析聊天记录中该开场白的准确时间，已阻止生成和发送'
          }));
          progress(index + 1, candidates.length, '生成补充草稿');
          continue;
        }
        if (!MobileFollowupCore.isMessageWithinRange(
          matchingIntro.timeText,
          params,
          conversation.timeText,
          new Date()
        )) {
          dateOnlyOutsideRange++;
          log('  开场白准确时间为 ' + resolvedTime.clock + '，不在所选范围内，已跳过', 'info');
          progress(index + 1, candidates.length, '生成补充草稿');
          continue;
        }
        conversation.timeText = resolvedTime.date + ' ' + resolvedTime.clock;
        conversation.timeMatchMode = 'confirmed_exact';
        log('  已从聊天记录确认准确发送时间 ' + resolvedTime.clock, 'success');
      }
      conversation.jobUrl = MobileFollowupCore.normalizeJobDetailUrl(
        context.jobUrl || conversation.jobUrl
      );
      let jobLinkError = '';
      if (!conversation.jobUrl && context.hasJobDetailTrigger) {
        const captured = await captureActiveJobDetailUrl(chatTab.id);
        if (captured.success) {
          conversation.jobUrl = captured.url;
          log('  已从 BOSS“查看职位”入口读取岗位链接', 'success');
        } else {
          jobLinkError = captured.error || '';
        }
      }

      if (!conversation.jobUrl) {
        drafts.push(Object.assign({}, conversation, {
          text: '',
          error: context.hasJobDetailTrigger
            ? (jobLinkError || '已找到“查看职位”，但未能解析准确岗位链接')
            : '当前会话没有可读取的“查看职位”入口，请在 BOSS 手动查看'
        }));
        progress(index + 1, candidates.length, '生成补充草稿');
        continue;
      }

      if (!detailTabId) {
        const detailTab = await chrome.tabs.create({ url: 'about:blank', active: false });
        detailTabId = detailTab.id;
      }
      let detail;
      try {
        detail = await readJobDetailInTab(detailTabId, conversation.jobUrl);
      } catch (error) {
        detail = { success: false, error: error.message || '岗位详情读取失败' };
      }
      if (!detail || !detail.success || !detail.jd) {
        drafts.push(Object.assign({}, conversation, {
          text: '',
          error: (detail && detail.error) || '岗位详情读取失败'
        }));
        progress(index + 1, candidates.length, '生成补充草稿');
        continue;
      }

      const job = {
        name: detail.title || conversation.position || '目标岗位',
        company: detail.company || conversation.company || ''
      };
      try {
        const text = await genSupplementFromJD(cfg, conversation, job, detail.jd);
        drafts.push(Object.assign({}, conversation, {
          position: job.name,
          company: job.company,
          text: text,
          error: ''
        }));
      } catch (error) {
        drafts.push(Object.assign({}, conversation, {
          position: job.name,
          company: job.company,
          text: '',
          error: '生成失败：' + (error.message || '未知错误')
        }));
      }
      progress(index + 1, candidates.length, '生成补充草稿');
    }

    if (!drafts.length && dateOnlyOutsideRange) {
      await chrome.storage.local.set({
        mobileFollowupCandidates: [],
        mobileFollowupDrafts: []
      });
      state.phase = 'idle';
      pushPhase();
      return {
        ok: false,
        error: '已检查“昨天”的通用开场白，但准确发送时间均不在所选范围内'
      };
    }

    await chrome.storage.local.set({
      mobileFollowupCandidates: candidates,
      mobileFollowupDrafts: drafts
    });
    state.phase = 'followup_review';
    pushPhase();
    chrome.runtime.sendMessage({ type: 'MOBILE_FOLLOWUP_DRAFTS', drafts: drafts }).catch(() => {});
    const ready = drafts.filter(item => item.text).length;
    log('补充介绍草稿完成：可审核 ' + ready + ' / ' + drafts.length, ready ? 'success' : 'warn');
    return { ok: true, count: ready, total: drafts.length, drafts: drafts };
  } catch (error) {
    state.phase = 'idle';
    pushPhase();
    return { ok: false, error: error.message || '补充介绍草稿生成失败' };
  } finally {
    if (detailTabId) chrome.tabs.remove(detailTabId).catch(() => {});
    followupGate.finish();
  }
}

async function runFollowupSend(selectedDrafts) {
  if (!followupGate.tryStart()) return { ok: false, error: '已有手机投递补充任务正在运行' };
  try {
    const stored = await chrome.storage.local.get([
      'mobileFollowupCandidates',
      'mobileFollowupDrafts',
      'mobileFollowupSent'
    ]);
    const candidates = stored.mobileFollowupCandidates || [];
    const generatedDrafts = stored.mobileFollowupDrafts || [];
    const sent = stored.mobileFollowupSent || {};
    const validation = MobileFollowupCore.validateDraftSelection(
      selectedDrafts,
      candidates,
      sent,
      generatedDrafts
    );
    if (!validation.ok) return { ok: false, error: validation.error };

    state.aborted = false;
    state.paused = false;
    state.phase = 'sending_followups';
    pushPhase();
    const chatTab = await ensureTab('https://www.zhipin.com/web/geek/chat');
    await ensureInjected(chatTab.id, 'src/content-chat.js');
    let successCount = 0;
    let failCount = 0;
    progress(0, validation.drafts.length, '发送补充介绍');

    for (let index = 0; index < validation.drafts.length; index++) {
      if (state.aborted) break;
      await waitIfPaused();
      if (state.aborted) break;
      const draft = validation.drafts[index];
      const target = candidates.find(item => item.id === draft.id);
      log('[' + (index + 1) + '/' + validation.drafts.length + '] 补充给 ' +
        ((target && target.hrName) || '未知 HR') + '...');
      const result = await sendToTab(chatTab.id, {
        type: 'SEND_MOBILE_FOLLOWUP',
        target: target,
        text: draft.text
      }, 45000);

      if (result && result.success) {
        sent[draft.id] = 1;
        successCount++;
        await chrome.storage.local.set({ mobileFollowupSent: sent });
        chrome.runtime.sendMessage({
          type: 'MOBILE_FOLLOWUP_ITEM',
          id: draft.id,
          status: 'sent'
        }).catch(() => {});
        log('  ✓ 补充介绍已发送', 'success');
      } else {
        failCount++;
        const uncertain = Boolean(result && (result.uncertain || result.timedOut));
        if (uncertain) {
          sent[draft.id] = 'uncertain';
          await chrome.storage.local.set({ mobileFollowupSent: sent });
          chrome.runtime.sendMessage({
            type: 'MOBILE_FOLLOWUP_ITEM',
            id: draft.id,
            status: 'uncertain'
          }).catch(() => {});
          state.aborted = true;
          log('  发送结果待确认，已锁定当前会话并停止本轮', 'error');
        } else {
          log('  发送失败：' + ((result && result.error) || '未知错误'), 'error');
        }
      }
      progress(index + 1, validation.drafts.length, '发送补充介绍');
      if (state.aborted) break;
      await rand(2500, 4200);
    }

    state.phase = 'followup_review';
    pushPhase();
    chrome.runtime.sendMessage({
      type: 'MOBILE_FOLLOWUP_DONE',
      ok: successCount,
      fail: failCount,
      stopped: state.aborted
    }).catch(() => {});
    return { ok: true, sent: successCount, failed: failCount, stopped: state.aborted };
  } catch (error) {
    state.phase = 'followup_review';
    pushPhase();
    return { ok: false, error: error.message || '补充介绍发送失败' };
  } finally {
    followupGate.finish();
  }
}

// ── 流程：投递（只允许一个任务；后台重新校验精确选择）──
async function startDelivery(jobIds) {
  if (followupGate.isActive()) return { ok: false, error: '手机投递补充任务正在运行，请先停止' };
  if (!deliveryGate.tryStart()) return { ok: false, error: '已有投递任务正在运行，已阻止重复启动' };
  try {
    const cfg = await getCfg();
    if (!cfg.muskApiKey) {
      deliveryGate.finish();
      return { ok: false, error: '投递时生成专属招呼语需要 MuskAI API Key，请先保存配置' };
    }
    if (!(cfg.resumeText || '').trim()) {
      deliveryGate.finish();
      return { ok: false, error: '投递时生成专属招呼语需要简历文字，请先解析或填写简历' };
    }
    const stored = await chrome.storage.local.get(['sw_jobs', 'sw_greetings', 'sw_screened', 'processed']);
    if (!state.jobs.length) state.jobs = stored.sw_jobs || [];
    if (!state.screened.length) state.screened = stored.sw_screened || [];
    if (!Object.keys(state.greetings).length) state.greetings = stored.sw_greetings || {};
    if (stored.processed) state.processed = stored.processed;

    const batch = JobDataCore.prepareDeliveryBatch(jobIds, state.jobs, state.screened, state.processed);
    if (!batch.ok) {
      deliveryGate.finish();
      return { ok: false, error: batch.error };
    }
    runDeliver(batch.ids)
      .catch(error => { log('投递任务异常：' + error.message, 'error'); finishDeliver(); })
      .finally(() => deliveryGate.finish());
    return { ok: true, count: batch.ids.length, ids: batch.ids };
  } catch (error) {
    deliveryGate.finish();
    return { ok: false, error: '启动投递失败：' + (error.message || '未知错误') };
  }
}

async function runDeliver(jobIds) {
  state.aborted = false; state.paused = false; state.results = [];
  state.phase = 'delivering'; pushPhase();
  // SW 可能在审核期间被回收，内存丢了就从存储读回
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  const cfg = await getCfg();
  const resumeImages = Array.isArray(cfg.resumeImages) && cfg.resumeImages.length
    ? cfg.resumeImages
    : (cfg.resumeImage ? [cfg.resumeImage] : []);
  if (!resumeImages.length) log('未准备投递图片，将只发招呼语', 'warn');

  const ids = (jobIds || []).filter(id => !state.processed[id]);
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }
  log('后台已锁定本轮投递：仅 ' + ids.length + ' 个已勾选且审核可投的岗位', 'info');
  for (let k = 0; k < ids.length; k++) {
    if (state.aborted) break;
    await waitIfPaused();
    if (state.aborted) break;
    const job = findJob(ids[k]);
    if (!job) { log('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); continue; }
    log('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));

    // 1. 搜索结果岗位回原列表精确定位；首页推荐岗位直接使用已保存的精确详情链接
    const searchUrl = job.sourceSearchUrl || buildSearchUrl(cfg);
    const tab = await ensureTab(searchUrl);
    log('  读取岗位JD...');
    let detailSource = job.collectionSource === 'recommend' ? 'job_detail' : 'search_card';
    let jdr;
    if (detailSource === 'job_detail') {
      const detailUrl = exactJobDetailUrl(job);
      jdr = detailUrl
        ? await readJobDetailInTab(tab.id, detailUrl, job)
        : { success: false, error: '首页推荐岗位缺少可核验的精确详情链接' };
    } else {
      await ensureInjected(tab.id, 'src/content-search.js');
      jdr = await sendToTab(tab.id, { type: 'OPEN_JD', job: job }, 30000);
      if (jdr && jdr.success && Number(jdr.cardBatches) > 0) {
        log('  滚动加载第 ' + Number(jdr.cardBatches) + ' 批后找到精确岗位卡片', 'success');
      }
      if (jdr && !jdr.success && jdr.code === 'JOB_CARD_NOT_FOUND') {
        const detailUrl = exactJobDetailUrl(job);
        if (detailUrl) {
          log('  当前搜索批次未显示该卡片，改用已保存的精确岗位链接...');
          jdr = await readJobDetailInTab(tab.id, detailUrl, job);
          if (jdr && jdr.success) detailSource = 'job_detail';
        }
      }
    }
    if (!jdr || !jdr.success) {
      const error = (jdr && jdr.error) || '岗位卡片校验失败';
      recordFail(job, error); log('  ' + error + '，安全跳过', 'error');
      progress(k + 1, ids.length, '投递');
      if (jdr && jdr.timedOut) {
        state.aborted = true;
        log('  页面响应异常，本轮已停止，避免后续岗位状态错位', 'error');
        break;
      }
      continue;
    }
    const jd = (jdr && jdr.jd) || '';
    if (state.aborted) break;

    // 2. 用【完整JD + 简历】现场生成这个岗位专属的招呼语
    log('  AI生成专属招呼语...');
    let greeting = '';
    try { greeting = await genGreetingFromJD(cfg, job, jd); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (!greeting) { recordFail(job, '招呼语生成失败'); log('  招呼语为空，跳过', 'warn'); progress(k + 1, ids.length, '投递'); continue; }
    if (state.aborted) break; await waitIfPaused(); if (state.aborted) break;

    // 3. 点立即沟通 → 继续沟通（跳聊天页）
    log('  建立联系（立即沟通 → 继续沟通）...');
    const chatStart = await sendToTab(tab.id, {
      type: detailSource === 'job_detail' ? 'START_JOB_CHAT' : 'GO_CHAT',
      job: job
    }, 30000);
    const navigationDisconnect = Boolean(
      chatStart &&
      !chatStart.success &&
      JobDataCore.isExpectedNavigationDisconnect(chatStart.error)
    );
    if ((!chatStart || !chatStart.success) && !navigationDisconnect) {
      const error = (chatStart && chatStart.error) || '建立联系失败';
      recordFail(job, error); log('  ' + error + '，安全跳过', 'error');
      progress(k + 1, ids.length, '投递');
      if (chatStart && chatStart.timedOut) {
        await lockUncertainJob(job);
        state.aborted = true;
        log('  当前岗位状态待确认，已锁定并停止本轮，防止重复联系', 'error');
        break;
      }
      continue;
    }
    if (navigationDisconnect) {
      log('  BOSS 页面已开始跳转，旧页面消息通道关闭；正在验证聊天页...', 'info');
    }
    const chatLoaded = await waitTabComplete(tab.id, 30000); await sleep(2500);
    if (!chatLoaded) {
      await lockUncertainJob(job);
      state.aborted = true;
      recordFail(job, '聊天页加载超时');
      log('  聊天页加载超时，当前岗位已锁定并停止本轮，请手动确认', 'error');
      progress(k + 1, ids.length, '投递');
      break;
    }
    if (state.aborted) {
      await lockUncertainJob(job);
      log('  建立联系后任务被停止，当前岗位已锁定，请手动确认', 'warn');
      break;
    }
    await waitIfPaused();
    if (state.aborted) {
      await lockUncertainJob(job);
      log('  建立联系后任务被停止，当前岗位已锁定，请手动确认', 'warn');
      break;
    }

    // 4. 聊天页当前打开的即该岗位会话，先发图片再发招呼语（无需匹配）
    const u = await curUrl(tab.id);
    if (u.indexOf('/web/geek/chat') < 0) {
      await lockUncertainJob(job);
      state.aborted = true;
      recordFail(job, '未确认跳转聊天页');
      log('  未确认进入聊天页，当前岗位已锁定并停止本轮，请手动确认', 'error');
      progress(k + 1, ids.length, '投递');
      break;
    }
    await ensureInjected(tab.id, 'src/content-chat.js');
    log(resumeImages.length
      ? '  发 ' + resumeImages.length + ' 张简历图片 + 招呼语...'
      : '  只发招呼语...');
    const r = await sendToTab(tab.id, { type: 'SEND_ACTIVE', images: resumeImages, greeting: greeting }, 60000);
    if (r && r.success) {
      recordOk(job);
      state.processed[job.id] = 1;
      await chrome.storage.local.set({ processed: state.processed });
      chrome.runtime.sendMessage({ type: 'DELIVERY_ITEM', id: job.id, ok: true }).catch(() => {});
      log('  ✓ 投递成功', 'success');
    }
    else {
      const sendError = (r && r.error) || '发送失败';
      recordFail(job, sendError);
      log('  失败：' + sendError, 'error');
      if (r && (r.timedOut || r.uncertain)) {
        await lockUncertainJob(job);
        state.aborted = true;
        log('  发送结果待确认，当前岗位已锁定并停止本轮，防止重复发送', 'error');
      }
    }
    progress(k + 1, ids.length, '投递');
    if (state.aborted) break;
    await rand(2500, 4500);
  }
  finishDeliver();
}
function recordOk(job) { state.results.push({ id: job.id, name: job.name, ok: true }); }
function recordFail(job, msg) { state.results.push({ id: job.id, name: job.name, ok: false, msg: msg }); }
async function lockUncertainJob(job) {
  state.processed[job.id] = 'uncertain';
  await chrome.storage.local.set({ processed: state.processed });
  chrome.runtime.sendMessage({
    type: 'DELIVERY_ITEM',
    id: job.id,
    ok: false,
    status: 'uncertain'
  }).catch(() => {});
}
function finishDeliver() {
  const ok = state.results.filter(r => r.ok).length;
  const fail = state.results.length - ok;
  const stopped = state.aborted;
  state.phase = stopped ? 'idle' : 'done'; pushPhase();
  log((stopped ? '投递已停止：' : '投递完成：') + '成功 ' + ok + ' | 失败 ' + fail, stopped ? 'warn' : 'success');
  chrome.runtime.sendMessage({ type: 'DONE', ok: ok, fail: fail }).catch(() => {});
}

// ── 消息入口 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TEST_AI') {
    testAIConnection()
      .then(result => sendResponse({ ok: true, model: result.model, reply: result.reply }))
      .catch(error => sendResponse({ ok: false, error: error && error.message ? error.message : 'MuskAI 连接测试失败' }));
    return true;
  }
  if (msg.type === 'OCR_RESUME') {
    ocrResumeImages(msg.images)
      .then(result => sendResponse({ ok: true, text: result.text, model: result.model }))
      .catch(error => sendResponse({ ok: false, error: ocrErrorMessage(error) }));
    return true;
  }
  if (msg.type === 'START_COLLECT') {
    if (deliveryGate.isActive() || followupGate.isActive()) { sendResponse({ ok: false, error: '发送任务仍在运行，请先停止' }); return; }
    runCollect(); sendResponse({ ok: true }); return;
  }
  if (msg.type === 'START_MOBILE_FOLLOWUP_DRAFTS') {
    if (deliveryGate.isActive() || isTaskRunning()) {
      sendResponse({ ok: false, error: '已有收集或发送任务正在运行，请先停止' });
      return;
    }
    runFollowupDrafting(msg.params || {}).then(sendResponse);
    return true;
  }
  if (msg.type === 'START_MOBILE_FOLLOWUP_SEND') {
    if (deliveryGate.isActive() || isTaskRunning()) {
      sendResponse({ ok: false, error: '已有收集或发送任务正在运行，请先停止' });
      return;
    }
    runFollowupSend(msg.drafts || []).then(sendResponse);
    return true;
  }
  if (msg.type === 'START_DELIVER') {
    startDelivery(msg.jobIds).then(sendResponse);
    return true;
  }
  if (msg.type === 'PAUSE') { state.paused = true; log('已暂停', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESUME') { state.paused = false; log('继续', 'info'); sendResponse({ ok: true }); return; }
  if (msg.type === 'STOP') { state.aborted = true; state.paused = false; log('已停止', 'warn'); state.phase = 'idle'; pushPhase(); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESET') {
    if (deliveryGate.isActive() || followupGate.isActive()) { sendResponse({ ok: false, error: '发送任务仍在运行，不能重置' }); return; }
    state.processed = {};
    chrome.storage.local.set({ processed: {} });
    chrome.storage.local.remove(['sw_jobs', 'sw_greetings', 'sw_screened']);
    state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; state.phase = 'idle'; pushPhase(); log('已重置（清空已投记录）', 'warn'); sendResponse({ ok: true }); return;
  }
  if (msg.type === 'GET_STATE') {
    touchActivity();
    sendResponse({
      phase: state.phase,
      paused: state.paused,
      screened: state.screened,
      deliveryActive: deliveryGate.isActive(),
      followupActive: followupGate.isActive(),
      lastActivityAt: state.lastActivityAt
    });
    return;
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'jobcopilot-run-keepalive') return;
  port.onMessage.addListener(message => {
    if (!message || message.type !== 'PING') return;
    touchActivity();
    try {
      port.postMessage({
        type: 'STATE',
        phase: state.phase,
        paused: state.paused,
        deliveryActive: deliveryGate.isActive(),
        followupActive: followupGate.isActive(),
        lastActivityAt: state.lastActivityAt
      });
    } catch (error) {}
  });
  port.onDisconnect.addListener(() => {
    if (!isTaskRunning()) return;
    state.aborted = true;
    state.paused = false;
    log('侧边栏已关闭，当前动作结束后将安全停止', 'warn');
  });
});

chrome.storage.local.get('processed').then(r => { if (r.processed) state.processed = r.processed; });
