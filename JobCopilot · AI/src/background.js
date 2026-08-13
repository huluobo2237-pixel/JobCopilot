// ===== BOSS自动投递 Service Worker：编排 收集→筛选→审核→投递 + DeepSeek =====
importScripts('/src/selectors.js'); // 让 SW 也能用 CITY_MAP（否则城市永远是全国）
const DS_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const DS_MODEL = 'deepseek-chat';

const RESUME_TEXT = ''; // 不内置任何个人简历，由用户在设置页"简历文字"填写

let state = {
  phase: 'idle', paused: false, aborted: false,
  jobs: [], screened: [], greetings: {}, results: [], processed: {}
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// ── 小工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
function log(text, level) { chrome.runtime.sendMessage({ type: 'LOG', text: text, level: level || 'info' }).catch(() => {}); }
function pushPhase() { chrome.runtime.sendMessage({ type: 'PHASE', phase: state.phase }).catch(() => {}); }
function progress(cur, total, label) { chrome.runtime.sendMessage({ type: 'PROGRESS', cur: cur, total: total, label: label || '' }).catch(() => {}); }
async function waitIfPaused() { while (state.paused && !state.aborted) await sleep(400); }
function getCfg() { return chrome.storage.local.get(['dsKey', 'resumeText', 'resumeImage', 'city', 'keyword', 'count', 'outKeywords', 'activeFilter']); }
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
function jobInfo(j) { return '岗位：' + (j.name || '') + '\n技能标签：' + ((j.tags || []).join('、')) + '\n薪资：' + (j.salary || '') + '\n公司：' + (j.company || ''); }
function findJob(id) { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === id) return state.jobs[i]; return null; }

// 本地黑名单过滤：公司名/岗位名/标签命中排除词，直接判不匹配，不消耗 AI
function localOutsourceFilter(cfg, job) {
  const words = (cfg.outKeywords || '').split(/[,，;；\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return null;
  const text = [job.company || '', job.name || '', (job.tags || []).join(' ')].join(' ').toLowerCase();
  for (const w of words) {
    if (text.indexOf(w) >= 0) return { match: false, reason: '命中排除词「' + w + '」' };
  }
  return null;
}

// 活跃度等级：刚刚活跃=5 > 今日=4 > 3日内=3 > 本周=2 > 本月=1 > 几乎不活跃=0；未知=-1
function activityLevel(s) {
  s = s || '';
  if (s.indexOf('刚刚活跃') >= 0) return 5;
  if (s.indexOf('在线') >= 0) return 5;
  if (s.indexOf('今日活跃') >= 0) return 4;
  const m = s.match(/(\d+)日内活跃/);
  if (m) return 3;
  if (s.indexOf('本周活跃') >= 0) return 2;
  if (s.indexOf('本月活跃') >= 0) return 1;
  if (s.indexOf('几乎不活跃') >= 0) return 0;
  return -1;
}

// 活跃度筛选：要求等级以上的保留；未知不拦截（避免误杀）
function localActivityFilter(cfg, job) {
  const req = parseInt(cfg.activeFilter, 10);
  if (!req) return null;
  let lv = activityLevel(job.activity);
  if (job.bossOnline === true && lv < 5) lv = 5; // 在线视同高活跃
  if (lv < 0) return null;
  if (lv < req) return { match: false, reason: 'HR活跃度不足：' + (job.activity || '离线') + '（要求' + reqLabel(req) + '）' };
  return null;
}
function reqLabel(req) {
  return { 5: '刚刚活跃', 4: '今日活跃', 3: '3日内活跃', 2: '本周活跃', 1: '本月活跃' }[req] || String(req);
}

// ── DeepSeek ──
async function callDS(messages, maxTokens) {
  const cfg = await getCfg();
  if (!cfg.dsKey) throw new Error('未配置DeepSeek API Key');
  const resp = await fetch(DS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.dsKey },
    body: JSON.stringify({ model: DS_MODEL, messages: messages, max_tokens: maxTokens || 500, temperature: 0.5 })
  });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error('DeepSeek ' + resp.status + ': ' + t.slice(0, 120)); }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// 筛选：只判断是否值得投（用岗位标签快速判断，不生成招呼语）
async function screenJob(cfg, job) {
  const sys = '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·适中】保留(match=true)：岗位方向与求职者简历的专业/技能/经历相关，且求职者的经验年限、学历、级别够得着该岗位（不超纲）。剔除(match=false)：方向与简历明显无关；岗位要求的经验/学历/硬技能明显超出简历；岗位级别明显高于求职者当前水平；公司为外包/劳务派遣/人力资源外包性质（包括公司名含"外包、人力、派遣、众包"等字样，或岗位明确要求"外派、驻场"，或属于知名外包企业如中软国际、软通动力、博彦科技、京北方等）。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"reason":"一句话理由"}';
  const user = '求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  const raw = await callDS([{ role: 'system', content: sys }, { role: 'user', content: user }], 200);
  let p = null;
  try { p = JSON.parse(raw); } catch (e) { const m = raw && raw.match(/\{[\s\S]*\}/); if (m) { try { p = JSON.parse(m[0]); } catch (e2) {} } }
  if (!p) return { match: false, reason: 'AI解析失败' };
  return { match: p.match === true, reason: p.reason || '' };
}

// 常见复姓（保守起见复姓不自动加称呼，避免"欧姐/欧哥"式尴尬）
const COMPOUND_SURNAMES = ['欧阳', '司马', '诸葛', '上官', '东方', '慕容', '独孤', '夏侯', '尉迟', '公孙', '皇甫', '南宫', '端木', '轩辕', '令狐', '闻人', '司徒', '司空', '长孙', '申屠', '公冶', '宗政', '濮阳', '淳于', '单于', '太叔'];
// 强性别倾向用字（名中命中即推断，宁缺毋滥，中性字一律不收）
const MALE_CHARS = '伟强磊军杰涛斌勇超浩鹏峰飞亮刚建东志波辉凯鑫博俊林海富坤铭勋腾翔健威锋岩松毅晨豪康宏泽轩然昊睿天翼航硕辰启瑞鸿达庆权汉彬彪帅迪帆舟';
const FEMALE_CHARS = '芳敏静丽娟燕婷雪梅红霞英玉秀兰慧洁怡淑妍丹娜媛萍玲凤美琴云珍蓉虹颖珊琪瑶萌婉蕾莉薇萱诺欣梦佳月秋露晶甜艺蕊芸';

function nameGender(name) {
  if (!name) return null;
  let male = 0, female = 0;
  for (const ch of name) {
    if (MALE_CHARS.indexOf(ch) >= 0) male++;
    if (FEMALE_CHARS.indexOf(ch) >= 0) female++;
  }
  if (male && !female) return '男';
  if (female && !male) return '女';
  return null; // 都命中或都没命中 → 不确定
}

// 从 HR 名字推导称呼：先生/女士后缀最可靠；没有后缀时按姓名用字性别偏好推断；
// 仍不确定一律返回 null（不硬叫，避免叫错性别）
function deriveGreeting(job) {
  const n = (job.hrName || '').trim();
  if (!n) return null;
  // 1) 姓+先生/女士（如 李女士、王先生）
  const m = n.match(/^([\u4e00-\u9fa5]{1,2})(先生|女士)$/);
  if (m) {
    if (COMPOUND_SURNAMES.indexOf(m[1]) >= 0) return null; // 复姓，保守不称呼
    const surname = m[1].charAt(0);
    return m[2] === '先生' ? surname + '哥' : surname + '姐';
  }
  // 2) 纯中文姓名（如 张伟、李静）按名推断性别
  const pure = (n.match(/[\u4e00-\u9fa5]{2,4}/) || [''])[0];
  if (pure.length < 2) return null;
  let surname = pure.charAt(0);
  for (const cs of COMPOUND_SURNAMES) {
    if (pure.indexOf(cs) === 0) { surname = cs; break; }
  }
  const given = pure.slice(surname.length);
  const g = nameGender(given);
  if (!g) return null;
  return g === '男' ? surname + '哥' : surname + '姐';
}

// 投递时：结合该岗位的【完整JD】+ 简历，现场生成专属招呼语
async function genGreetingFromJD(cfg, job, jd, callName) {
  const callRule = callName
    ? '开头第一句必须先写称呼「' + callName + '，您好！」，例如：「' + callName + '，您好！我熟悉…」'
    : '开头第一句必须先写「您好！」问候，例如：「您好！我熟悉…」';
  const sys = '你是求职者本人，在BOSS直聘给HR发招呼语。回复会原样发给HR，严禁任何注释、说明、括号备注、字数统计或引导语。\n【格式】1.' + callRule + '。2.紧接"做过XXX"说明简历里与该岗位相关的具体项目/经历。3.全文80-120字，真诚自然。';
  const jdText = (jd && jd.trim()) ? jd.trim() : ('技能标签：' + (job.tags || []).join('、'));
  const user = '我的简历：\n' + resumeFull(cfg) + '\n\n目标岗位：' + (job.name || '') + (job.company ? ('（' + job.company + '）') : '') + '\n该岗位JD：\n' + jdText + '\n\n请按格式生成一段招呼语' + (callName ? '（HR姓' + callName.charAt(0) + '，开头必须称呼' + callName + '）' : '（开头必须先写"您好！"问候，再接"我熟悉…"）') + '，直接输出招呼语本身，不要任何多余内容。';
  const raw = await callDS([{ role: 'system', content: sys }, { role: 'user', content: user }], 300);
  return (raw || '').trim();
}

// ── tab 注入 + 发消息 ──
async function ensureInjected(tabId, file) {
  try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/selectors.js', file] }); } catch (e) {}
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'no response' });
    });
  });
}
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    function lis(id, info) { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } }
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } });
  });
}
function resolveCity(cfg) {
  const firstCity = (cfg.city || '').split(/[\/、,，\s]+/)[0].replace(/[市省]$/, '') || '';
  const code = (typeof CITY_MAP !== 'undefined' && CITY_MAP[firstCity]) || '100010000';
  return { name: firstCity, code: code, found: code !== '100010000' || firstCity === '全国' };
}
function buildSearchUrl(cfg) {
  const c = resolveCity(cfg);
  const params = new URLSearchParams({ query: cfg.keyword || '', city: c.code });
  // 行业/规模：BOSS 代码不确定，暂不加入（错误代码会导致搜不到任何岗位）
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
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
async function getSearchTab(cfg) { return ensureTab(buildSearchUrl(cfg)); }
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false;
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
  state.phase = 'collecting'; pushPhase();
  const cfg = await getCfg();
  if (!cfg.dsKey) { log('请先填写 DeepSeek API Key', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!cfg.keyword) { log('请先填写岗位关键词', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!(cfg.resumeText || '').trim()) { log('请先在设置里填写"简历文字"（AI筛选和招呼语都需要它）', 'error'); state.phase = 'idle'; pushPhase(); return; }

  const _c = resolveCity(cfg);
  log('打开搜索页：' + cfg.keyword + ' | 城市：' + (_c.found ? _c.name : '全国'));
  if (cfg.city && !_c.found) log('城市"' + cfg.city + '"未识别，已按全国搜索', 'warn');
  const tab = await getSearchTab(cfg);
  const count = parseInt(cfg.count) || 20;

  log('收集岗位中（目标 ' + count + ' 个）...');
  await ensureInjected(tab.id, 'src/content-search.js');
  const r = await sendToTab(tab.id, { type: 'SCRAPE', count: count });
  if (!r || !r.success) { log('收集失败：' + (r && r.error), 'error'); state.phase = 'idle'; pushPhase(); return; }
  state.jobs = r.jobs || [];
  log('收集到 ' + state.jobs.length + ' 个岗位', 'success');
  if (!state.jobs.length) { state.phase = 'idle'; pushPhase(); return; }

  // 筛选（并发3）
  state.phase = 'screening'; pushPhase();
  log('AI 筛选中（DeepSeek）...');
  let done = 0; const total = state.jobs.length;
  progress(0, total, '筛选');
  const CONC = 3;
  for (let i = 0; i < state.jobs.length; i += CONC) {
    if (state.aborted) break; await waitIfPaused();
    const batch = state.jobs.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      // 本地规则：黑名单 → 活跃度 → AI
      const local = localOutsourceFilter(cfg, job);
      const act = local ? null : localActivityFilter(cfg, job);
      let res = local || act;
      if (!res) {
        try { res = await screenJob(cfg, job); }
        catch (e) { res = { match: false, reason: '筛选异常:' + e.message }; }
      }
      state.screened.push(Object.assign({}, job, { match: res.match, reason: res.reason }));
      done++; progress(done, total, '筛选');
    }));
  }
  const matched = state.screened.filter(j => j.match).length;
  log('筛选完成：匹配 ' + matched + ' / ' + total, 'success');
  // 存盘：SW 可能在审核期间被浏览器回收，投递时需从存储读回
  await chrome.storage.local.set({ sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened });
  state.phase = 'review'; pushPhase();
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}

// ── 流程：投递（单个闭环：建联→进聊天页→发图片+招呼语→回搜索页→下一个）──
async function runDeliver(jobIds) {
  state.aborted = false; state.paused = false; state.results = [];
  state.phase = 'delivering'; pushPhase();
  // SW 可能在审核期间被回收，内存丢了就从存储读回
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  const cfg = await getCfg();
  if (!cfg.resumeImage) log('未上传简历图片，将只发招呼语', 'warn');

  const ids = (jobIds || []).filter(id => !state.processed[id]);
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }
  const searchUrl = buildSearchUrl(cfg);

  for (let k = 0; k < ids.length; k++) {
    if (state.aborted) break; await waitIfPaused();
    const job = findJob(ids[k]);
    if (!job) { log('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); continue; }
    log('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));

    // 1. 回搜索页，点开卡片读取该岗位完整JD
    const tab = await ensureTab(searchUrl);
    await ensureInjected(tab.id, 'src/content-search.js');
    log('  读取岗位JD...');
    const jdr = await sendToTab(tab.id, { type: 'OPEN_JD', job: job });
    const jd = (jdr && jdr.jd) || '';
    // 卡片上没抓到公司名时，用详情面板的兜底
    if (jdr && jdr.company && !job.company) job.company = jdr.company;
    if (jdr && jdr.companyLink && !job.companyLink) job.companyLink = jdr.companyLink;
    if (jdr && jdr.hrName && !job.hrName) job.hrName = jdr.hrName;

    // 2. 用【完整JD + 简历】现场生成这个岗位专属的招呼语
    log('  AI生成专属招呼语...');
    let greeting = '';
    const callName = deriveGreeting(job);
    if (callName) log('  称呼：' + callName);
    try { greeting = await genGreetingFromJD(cfg, job, jd, callName); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (!greeting) { recordFail(job, '招呼语生成失败'); log('  招呼语为空，跳过', 'warn'); progress(k + 1, ids.length, '投递'); continue; }

    // 3. 点立即沟通 → 继续沟通（跳聊天页）
    log('  建立联系（立即沟通 → 继续沟通）...');
    await sendToTab(tab.id, { type: 'GO_CHAT', job: job });
    await waitTabComplete(tab.id); await sleep(2500);

    // 4. 聊天页当前打开的即该岗位会话，先发图片再发招呼语（无需匹配）
    const u = await curUrl(tab.id);
    if (u.indexOf('/web/geek/chat') < 0) { recordFail(job, '未跳转聊天页'); log('  未进入聊天页，跳过', 'error'); progress(k + 1, ids.length, '投递'); continue; }
    await ensureInjected(tab.id, 'src/content-chat.js');
    log('  发简历图片 + 招呼语...');
    const r = await sendToTab(tab.id, { type: 'SEND_ACTIVE', image: cfg.resumeImage || '', greeting: greeting });
    if (r && r.success) { recordOk(job); state.processed[job.id] = 1; await chrome.storage.local.set({ processed: state.processed }); log('  ✓ 投递成功', 'success'); }
    else { recordFail(job, (r && r.error) || '发送失败'); log('  失败：' + (r && r.error), 'error'); }
    progress(k + 1, ids.length, '投递');
    await rand(2500, 4500);
  }
  finishDeliver();
}
function recordOk(job) { state.results.push({ id: job.id, name: job.name, ok: true }); }
function recordFail(job, msg) { state.results.push({ id: job.id, name: job.name, ok: false, msg: msg }); }
function finishDeliver() {
  const ok = state.results.filter(r => r.ok).length;
  const fail = state.results.length - ok;
  state.phase = 'done'; pushPhase();
  log('投递完成：成功 ' + ok + ' | 失败 ' + fail, 'success');
  chrome.runtime.sendMessage({ type: 'DONE', ok: ok, fail: fail }).catch(() => {});
}

// ── 消息入口 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_COLLECT') { runCollect(); sendResponse({ ok: true }); return; }
  if (msg.type === 'START_DELIVER') { runDeliver(msg.jobIds); sendResponse({ ok: true }); return; }
  if (msg.type === 'PAUSE') { state.paused = true; log('已暂停', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESUME') { state.paused = false; log('继续', 'info'); sendResponse({ ok: true }); return; }
  if (msg.type === 'STOP') { state.aborted = true; state.paused = false; log('已停止', 'warn'); state.phase = 'idle'; pushPhase(); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESET') { state.processed = {}; chrome.storage.local.set({ processed: {} }); state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; state.phase = 'idle'; pushPhase(); log('已重置（清空已投记录）', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'GET_STATE') { sendResponse({ phase: state.phase, screened: state.screened }); return; }
});

chrome.storage.local.get('processed').then(r => { if (r.processed) state.processed = r.processed; });
