// ===== 侧边栏交互 =====
const $ = (id) => document.getElementById(id);
const CFG_FIELDS = [
  'muskApiKey',
  'gptModel',
  'resumeText',
  'collectionSource',
  'keyword',
  'city',
  'count',
  'screeningMode',
  'followupScanMode',
  'followupConversationCount'
];
const DEFAULT_MODEL = 'gpt-5.6-terra';
let selectedResumeFile = null;
let deliverySubmitPending = false;
let processedJobs = {};
let keepAlivePort = null;
let keepAliveTimer = null;
let keepAliveReconnectTimer = null;
let keepAliveExpected = false;
let backendActiveSeen = false;
let backendLossReported = false;
let mobileFollowupDrafts = [];
let mobileFollowupSent = {};

// 折叠
document.querySelectorAll('.card-h[data-toggle]').forEach(h => {
  h.addEventListener('click', () => {
    const body = $(h.dataset.toggle);
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });
});

// 载入配置
chrome.storage.local.get(CFG_FIELDS.concat([
  'resumeImage',
  'resumeImages',
  'processed',
  'sw_screened',
  'mobileFollowupDrafts',
  'mobileFollowupSent'
]), (d) => {
  CFG_FIELDS.forEach(f => { if (d[f] !== undefined && $(f)) $(f).value = d[f]; });
  if (!d.gptModel) $('gptModel').value = DEFAULT_MODEL;
  if (!d.collectionSource) $('collectionSource').value = 'search';
  if (!d.screeningMode) $('screeningMode').value = 'bulk';
  updateCollectionSource();
  updateFollowupScanMode();
  processedJobs = d.processed || {};
  mobileFollowupDrafts = Array.isArray(d.mobileFollowupDrafts) ? d.mobileFollowupDrafts : [];
  mobileFollowupSent = d.mobileFollowupSent || {};
  const images = Array.isArray(d.resumeImages) && d.resumeImages.length
    ? d.resumeImages
    : (d.resumeImage ? [d.resumeImage] : []);
  if (images.length) showImages(images);
  if (Array.isArray(d.sw_screened) && d.sw_screened.length) renderReview(d.sw_screened);
  if (mobileFollowupDrafts.length) renderFollowupDrafts(mobileFollowupDrafts);
});

function localDateInput(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}
function localTimeInput(date) {
  return String(date.getHours()).padStart(2, '0') + ':' +
    String(date.getMinutes()).padStart(2, '0');
}
const followupNow = new Date();
const followupStartDefault = new Date(followupNow.getTime() - 10 * 60 * 1000);
$('followupDate').value = localDateInput(followupNow);
$('followupStart').value = localTimeInput(followupStartDefault);
$('followupEnd').value = localTimeInput(followupNow);
$('followupScanMode').value = 'count';
$('followupConversationCount').value = '28';

function updateFollowupScanMode() {
  const countMode = $('followupScanMode').value === 'count';
  $('followupCountWrap').hidden = !countMode;
  $('followupRangeFields').hidden = countMode;
  $('followupPrivacyNote').textContent = countMode
    ? '检查列表最前面的 N 条会话，逐条确认你发送过通用开场白，再读取 JD 并生成草稿，不会自动发送。'
    : '只扫描所选时间段内的通用开场白。列表只显示“昨天”时会点开确认准确分钟。先读取 JD 并生成草稿，不会自动发送。';
}

$('followupScanMode').addEventListener('change', () => {
  updateFollowupScanMode();
  setFollowupStatus(
    $('followupScanMode').value === 'count'
      ? '请输入要检查的列表会话数量（1–50）。'
      : '请填写手机端投递的准确日期和时间范围。'
  );
});
updateFollowupScanMode();

function updateScreeningMode() {
  const recommend = $('collectionSource').value === 'recommend';
  const bulk = $('screeningMode').value !== 'ai';
  $('btnCollect').textContent = recommend
    ? '收集首页推荐 + AI筛选'
    : bulk
    ? '开始收集 → 海投审核'
    : '开始收集 + AI筛选';
  $('screeningModeNote').textContent = recommend
    ? '首页推荐可能混入无关岗位，因此固定使用目标关键词和简历进行 AI 相关性筛选。'
    : bulk
    ? '全部有效岗位进入人工审核；投递时仍会依据 JD 生成专属招呼语。'
    : '先把简历文字和岗位信息发送 MuskAI，只让匹配岗位进入审核。';
}

$('screeningMode').addEventListener('change', updateScreeningMode);

function updateCollectionSource() {
  const recommend = $('collectionSource').value === 'recommend';
  if (recommend) $('screeningMode').value = 'ai';
  $('screeningMode').disabled = recommend;
  $('collectionSourceNote').textContent = recommend
    ? '从当前 BOSS 首页“精选职位”区域收集；城市可编辑或清空，但不参与首页推荐筛选。当前推荐不足时会自动刷新并去重收集新岗位。'
    : '按目标岗位关键词和城市打开 BOSS 搜索结果并收集岗位。';
  updateScreeningMode();
}

$('collectionSource').addEventListener('change', updateCollectionSource);
updateCollectionSource();

function showImages(images) {
  const preview = $('imgPrev');
  preview.innerHTML = '';
  (images || []).forEach((dataUrl, index) => {
    const item = document.createElement('div');
    item.className = 'resume-preview';
    const image = document.createElement('img');
    image.src = dataUrl;
    image.alt = '简历第 ' + (index + 1) + ' 页';
    const badge = document.createElement('span');
    badge.textContent = '第 ' + (index + 1) + ' 页';
    item.appendChild(image);
    item.appendChild(badge);
    preview.appendChild(item);
  });
  if (images && images.length) {
    const summary = document.createElement('div');
    summary.className = 'resume-image-summary';
    summary.textContent = '已准备 ' + images.length + ' 张投递图片，将按页依次发送。';
    preview.appendChild(summary);
  }
}

function saveResumeImages(images, sourceName) {
  return new Promise((resolve, reject) => {
    const normalized = (images || []).filter(item => typeof item === 'string' && item.startsWith('data:image/'));
    chrome.storage.local.set({
      resumeImages: normalized,
      resumeImage: normalized[0] || '',
      resumeImageSource: sourceName || ''
    }, () => {
      if (chrome.runtime.lastError) reject(new Error('投递图片保存失败：' + chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

$('resumeImg').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      await saveResumeImages([ev.target.result], file.name);
      showImages([ev.target.result]);
      addLog('已保存手动上传的投递图片', 'success');
    } catch (error) {
      addLog(error.message || '投递图片保存失败', 'error');
    }
  };
  reader.readAsDataURL(file);
});

function setParseStatus(text, level) {
  const status = $('resumeParseStatus');
  status.textContent = text;
  status.className = 'parse-status' + (level ? ' ' + level : '');
}

function setButtonBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
  }
}

$('resumeFile').addEventListener('change', (event) => {
  selectedResumeFile = event.target.files[0] || null;
  $('btnOcrResume').hidden = true;
  if (!selectedResumeFile) {
    setParseStatus('可在本机解析文字或生成投递图片；只有 OCR 会把扫描件发送 MuskAI。');
    return;
  }
  const kind = globalThis.ResumeParserCore
    ? globalThis.ResumeParserCore.fileKind(selectedResumeFile)
    : '';
  if (kind === 'image') {
    $('btnOcrResume').hidden = false;
    setParseStatus('可直接生成投递图片；如需提取文字，再确认使用 MuskAI OCR。', 'warn');
  } else {
    setParseStatus('已选择 ' + selectedResumeFile.name + '，可解析文字或在本机生成投递图片。');
  }
});

$('btnParseResume').addEventListener('click', async () => {
  if (!selectedResumeFile) return setParseStatus('请先选择简历文件', 'error');
  if (!globalThis.resumeParser) return setParseStatus('解析组件尚未就绪，请稍候或重新加载扩展', 'error');

  const button = $('btnParseResume');
  setButtonBusy(button, true, '解析中…');
  $('btnOcrResume').hidden = true;
  try {
    const result = await globalThis.resumeParser.parse(selectedResumeFile);
    if (result.needsOcr) {
      $('btnOcrResume').hidden = false;
      const label = result.format === 'pdf' ? '扫描版或文字过少的 PDF' : '图片简历';
      setParseStatus(label + ' 需要 MuskAI OCR。只有点击右侧按钮并确认后才会上传。', 'warn');
      return;
    }
    $('resumeText').value = result.text;
    const pageInfo = result.pageCount ? '，共 ' + result.pageCount + ' 页' : '';
    setParseStatus('本地解析成功' + pageInfo + '，已填入简历文字；请检查内容后保存。', 'success');
    addLog('简历已在本机解析：' + selectedResumeFile.name, 'success');
  } catch (error) {
    setParseStatus(error.message || '简历解析失败', 'error');
    addLog(error.message || '简历解析失败', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

$('btnGenerateResumeImages').addEventListener('click', async () => {
  if (!selectedResumeFile) return setParseStatus('请先选择简历文件', 'error');
  if (!globalThis.resumeParser) return setParseStatus('解析组件尚未就绪，请稍候或重新加载扩展', 'error');

  const button = $('btnGenerateResumeImages');
  setButtonBusy(button, true, '生成中…');
  try {
    setParseStatus('正在本机生成投递图片，不会上传文件…', 'warn');
    const images = await globalThis.resumeParser.prepareDeliveryImages(selectedResumeFile);
    await saveResumeImages(images, selectedResumeFile.name);
    showImages(images);
    const kind = globalThis.ResumeParserCore.fileKind(selectedResumeFile);
    const layoutNote = kind === 'docx' || kind === 'text' ? '（已按清晰模板重新排版）' : '（保留原页面）';
    setParseStatus('生成成功：' + images.length + ' 张投递图片' + layoutNote + '，投递时会按页依次发送。', 'success');
    addLog('已在本机生成 ' + images.length + ' 张投递图片：' + selectedResumeFile.name, 'success');
  } catch (error) {
    setParseStatus(error.message || '投递图片生成失败', 'error');
    addLog(error.message || '投递图片生成失败', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

$('btnOcrResume').addEventListener('click', async () => {
  if (!selectedResumeFile) return setParseStatus('请先选择扫描 PDF 或图片', 'error');
  if (!globalThis.resumeParser) return setParseStatus('解析组件尚未就绪，请稍候或重新加载扩展', 'error');
  if (!$('muskApiKey').value.trim()) return setParseStatus('请先填写 MuskAI API Key', 'error');
  if (!confirm('将把扫描 PDF 页面或图片发送到 MuskAI 进行文字识别，是否继续？')) return;

  await saveCfgSync();
  const button = $('btnOcrResume');
  setButtonBusy(button, true, 'OCR 识别中…');
  try {
    setParseStatus('正在本机渲染扫描件，随后发送 MuskAI 识别…', 'warn');
    const images = await globalThis.resumeParser.prepareOcrImages(selectedResumeFile);
    const result = await sendRuntimeMessage({ type: 'OCR_RESUME', images: images });
    if (!result || !result.ok) throw new Error((result && result.error) || 'MuskAI OCR 失败');
    $('resumeText').value = result.text;
    setParseStatus('MuskAI OCR 成功，已填入简历文字；请检查内容后保存。', 'success');
    addLog('简历 OCR 完成：' + result.model, 'success');
  } catch (error) {
    setParseStatus(error.message || 'MuskAI OCR 失败', 'error');
    addLog(error.message || 'MuskAI OCR 失败', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

function readFormCfg() {
  const obj = {};
  CFG_FIELDS.forEach(f => { obj[f] = $(f).value.trim ? $(f).value.trim() : $(f).value; });
  return obj;
}

$('saveCfg').addEventListener('click', () => {
  const obj = readFormCfg();
  chrome.storage.local.set(obj, () => { const s = $('saved'); s.style.display = 'inline'; setTimeout(() => s.style.display = 'none', 1500); });
});

function saveCfgSync() {
  return new Promise(res => {
    chrome.storage.local.set(readFormCfg(), res);
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

$('btnTestAI').addEventListener('click', async () => {
  await saveCfgSync();
  if (!$('muskApiKey').value.trim()) return addLog('请先填写 MuskAI API Key', 'error');

  const button = $('btnTestAI');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '测试中…';
  addLog('正在测试 MuskAI ' + $('gptModel').value + ' 连接…', 'info');
  try {
    const result = await sendRuntimeMessage({ type: 'TEST_AI' });
    if (!result || !result.ok) throw new Error((result && result.error) || '连接测试失败');
    addLog('AI 连接成功：' + result.model, 'success');
  } catch (error) {
    addLog(error.message || 'AI 连接测试失败', 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

function setFollowupStatus(text, level) {
  const status = $('followupStatus');
  status.textContent = text;
  status.className = 'parse-status' + (level ? ' ' + level : '');
}

function followupRecipient(draft) {
  return [draft.hrName, draft.company, draft.position].filter(Boolean).join(' · ') || draft.id;
}

function renderFollowupDrafts(drafts) {
  mobileFollowupDrafts = Array.isArray(drafts) ? drafts : [];
  const list = $('followupDraftList');
  let html = '';
  mobileFollowupDrafts.forEach(draft => {
    const sentState = mobileFollowupSent[draft.id];
    const unavailable = !draft.text || Boolean(draft.error) || Boolean(sentState);
    const statusText = sentState === 'uncertain'
      ? '发送结果待确认，已锁定，请在 BOSS 手动核实'
      : (sentState ? '已发送，本轮不会重复' : (draft.error || ''));
    html += '<div class="followup-draft' +
      (draft.error ? ' error' : '') +
      (sentState ? ' sent' : '') +
      '" data-id="' + esc(draft.id) + '">' +
      '<div class="followup-draft-head"><input class="followup-select" type="checkbox" ' +
      (unavailable ? 'disabled ' : 'checked ') +
      'data-id="' + esc(draft.id) + '"><span>' + esc(followupRecipient(draft)) + '</span></div>' +
      '<div class="followup-draft-meta">' + esc((draft.timeText || '') + '｜原消息：' + (draft.preview || '未获取')) + '</div>' +
      '<textarea class="followup-text" data-id="' + esc(draft.id) + '" ' +
      (unavailable ? 'disabled' : '') + '>' + esc(draft.text || '') + '</textarea>' +
      (statusText ? '<div class="followup-draft-status' + (sentState === 1 ? ' success' : '') + '">' +
        esc(statusText) + '</div>' : '') +
      '</div>';
  });
  list.innerHTML = html || '<div class="job-sub">暂无补充介绍草稿</div>';
  $('followupReview').hidden = false;
  const ready = mobileFollowupDrafts.filter(draft => draft.text && !draft.error && !mobileFollowupSent[draft.id]).length;
  setFollowupStatus('草稿 ' + mobileFollowupDrafts.length + ' 条，可发送 ' + ready + ' 条。请逐条检查并修改。', ready ? 'success' : 'warn');
}

$('btnBuildFollowups').addEventListener('click', async () => {
  await saveCfgSync();
  if (!$('muskApiKey').value.trim()) return setFollowupStatus('请先填写 MuskAI API Key', 'error');
  if (!$('resumeText').value.trim()) return setFollowupStatus('请先填写简历文字', 'error');
  const params = {
    mode: $('followupScanMode').value,
    count: Number($('followupConversationCount').value),
    date: $('followupDate').value,
    start: $('followupStart').value,
    end: $('followupEnd').value
  };
  mobileFollowupDrafts = [];
  $('followupDraftList').innerHTML = '';
  $('followupReview').hidden = true;
  setRunning(true);
  setFollowupStatus('正在只读扫描会话、读取岗位 JD 并生成草稿，不会发送消息…', 'warn');
  try {
    const result = await sendRuntimeMessage({
      type: 'START_MOBILE_FOLLOWUP_DRAFTS',
      params: params
    });
    if (!result || !result.ok) throw new Error((result && result.error) || '补充介绍草稿生成失败');
    mobileFollowupDrafts = result.drafts || [];
    renderFollowupDrafts(mobileFollowupDrafts);
  } catch (error) {
    setFollowupStatus(error.message || '补充介绍草稿生成失败', 'error');
    addLog(error.message || '补充介绍草稿生成失败', 'error');
  } finally {
    setRunning(false);
  }
});

$('selAllFollowups').addEventListener('change', event => {
  document.querySelectorAll('.followup-select:not(:disabled)').forEach(input => {
    input.checked = event.target.checked;
  });
});

$('btnSendFollowups').addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('.followup-select:checked:not(:disabled)'));
  const drafts = checked.map(input => {
    const text = Array.from(document.querySelectorAll('.followup-text'))
      .find(item => item.dataset.id === input.dataset.id);
    return { id: input.dataset.id, text: text ? text.value.trim() : '' };
  });
  if (!drafts.length) return setFollowupStatus('请至少选择一条补充介绍', 'error');
  const names = checked.map(input => {
    const draft = mobileFollowupDrafts.find(item => item.id === input.dataset.id);
    return '• ' + followupRecipient(draft || { id: input.dataset.id });
  });
  if (!confirm(
    '确认向以下 ' + drafts.length + ' 个现有会话发送补充介绍？\n\n' +
    names.join('\n') +
    '\n\n这是实际发送操作，确认后将逐条发送。'
  )) return;

  drafts.forEach(edited => {
    const draft = mobileFollowupDrafts.find(item => item.id === edited.id);
    if (draft) draft.text = edited.text;
  });
  chrome.storage.local.set({ mobileFollowupDrafts: mobileFollowupDrafts });
  setRunning(true);
  setFollowupStatus('正在发送选中的补充介绍，请保持侧边栏开启…', 'warn');
  try {
    const result = await sendRuntimeMessage({
      type: 'START_MOBILE_FOLLOWUP_SEND',
      drafts: drafts
    });
    if (!result || !result.ok) throw new Error((result && result.error) || '补充介绍发送失败');
    setFollowupStatus(
      '发送完成：成功 ' + result.sent + '，失败 ' + result.failed +
      (result.stopped ? '；已安全停止' : ''),
      result.failed ? 'warn' : 'success'
    );
  } catch (error) {
    setFollowupStatus(error.message || '补充介绍发送失败', 'error');
    addLog(error.message || '补充介绍发送失败', 'error');
  } finally {
    setRunning(false);
  }
});

// 运行控制
$('btnCollect').addEventListener('click', async () => {
  await saveCfgSync();
  const recommend = $('collectionSource').value === 'recommend';
  if (
    (recommend || $('screeningMode').value === 'ai') &&
    !$('muskApiKey').value.trim()
  ) return addLog('AI 精准筛选需要先填写 MuskAI API Key', 'error');
  if (
    (recommend || $('screeningMode').value === 'ai') &&
    !$('resumeText').value.trim()
  ) return addLog('AI 精准筛选需要先填写简历文字', 'error');
  if (!$('keyword').value.trim()) return addLog('请先填岗位关键词', 'error');
  $('reviewCard').style.display = 'none';
  setRunning(true);
  chrome.runtime.sendMessage({ type: 'START_COLLECT' });
});

$('btnDeliver').addEventListener('click', async () => {
  if (deliverySubmitPending) return addLog('投递请求正在确认，请勿重复点击', 'warn');
  const checked = Array.from(document.querySelectorAll('.job-item:not(.skip) input:checked'));
  const ids = checked.map(c => c.dataset.id);
  if (!ids.length) return addLog('请至少勾选一个岗位', 'error');
  if (new Set(ids).size !== ids.length) return addLog('检测到重复岗位 ID，请重新收集后再审核', 'error');
  const names = checked.map(input => {
    const title = input.closest('.job-item').querySelector('.job-title');
    return '• ' + (title ? title.textContent.trim() : input.dataset.id);
  });
  if (!confirm('确认只投递以下 ' + ids.length + ' 个 AI 匹配岗位？\n\n' + names.join('\n') + '\n\n确认后才会建立联系。')) return;

  deliverySubmitPending = true;
  setRunning(true);
  setDeliveryActive(true);
  let accepted = false;
  try {
    const result = await sendRuntimeMessage({ type: 'START_DELIVER', jobIds: ids });
    if (!result || !result.ok) throw new Error((result && result.error) || '后台未接受投递任务');
    if (result.count !== ids.length) {
      chrome.runtime.sendMessage({ type: 'STOP' });
      throw new Error('后台确认数量不一致，已发送停止请求');
    }
    accepted = true;
    addLog('后台确认：本轮只投递 ' + result.count + ' 个岗位', 'info');
  } catch (error) {
    addLog(error.message || '启动投递失败', 'error');
    setDeliveryActive(false);
  } finally {
    deliverySubmitPending = false;
    if (!accepted) setRunning(false);
  }
});

$('btnPause').addEventListener('click', () => {
  if ($('btnPause').textContent === '暂停') { $('btnPause').textContent = '继续'; chrome.runtime.sendMessage({ type: 'PAUSE' }); }
  else { $('btnPause').textContent = '暂停'; chrome.runtime.sendMessage({ type: 'RESUME' }); }
});
function stopDelivery() {
  chrome.runtime.sendMessage({ type: 'STOP' });
  addLog('已请求停止；当前正在执行的单个动作结束后不会再投下一个岗位', 'warn');
  setRunning(false);
  setDeliveryActive(false);
}
$('btnStop').addEventListener('click', stopDelivery);
$('btnReviewStop').addEventListener('click', stopDelivery);
$('btnReset').addEventListener('click', () => {
  processedJobs = {};
  chrome.runtime.sendMessage({ type: 'RESET' });
  $('reviewCard').style.display = 'none';
  setRunning(false);
});
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

$('selAll').addEventListener('change', (e) => {
  document.querySelectorAll('.job-item:not(.skip) input:not(:disabled)').forEach(c => c.checked = e.target.checked);
});

function isBackendRunning(phase, deliveryActive, followupActive) {
  return deliveryActive === true ||
    followupActive === true ||
    phase === 'collecting' ||
    phase === 'screening' ||
    phase === 'delivering' ||
    phase === 'drafting_followups' ||
    phase === 'sending_followups';
}
function stopKeepAlive() {
  keepAliveExpected = false;
  clearInterval(keepAliveTimer);
  clearTimeout(keepAliveReconnectTimer);
  keepAliveTimer = null;
  keepAliveReconnectTimer = null;
  if (keepAlivePort) {
    try { keepAlivePort.disconnect(); } catch (error) {}
    keepAlivePort = null;
  }
  backendActiveSeen = false;
}
function startKeepAlive() {
  keepAliveExpected = true;
  if (keepAlivePort) return;
  clearTimeout(keepAliveReconnectTimer);
  keepAliveReconnectTimer = null;
  try {
    const port = chrome.runtime.connect({ name: 'jobcopilot-run-keepalive' });
    keepAlivePort = port;
    const ping = () => {
      if (!keepAliveExpected || keepAlivePort !== port) return;
      try { port.postMessage({ type: 'PING', at: Date.now() }); } catch (error) {}
    };
    port.onMessage.addListener(message => {
      if (!message || message.type !== 'STATE') return;
      const active = isBackendRunning(message.phase, message.deliveryActive, message.followupActive);
      if (active) {
        backendActiveSeen = true;
        backendLossReported = false;
        $('btnPause').textContent = message.paused ? '继续' : '暂停';
      } else if (keepAliveExpected && backendActiveSeen && message.phase === 'idle') {
        if (!backendLossReported) {
          addLog('后台任务已中断；已投岗位记录仍保留，可重新确认剩余岗位', 'error');
          backendLossReported = true;
        }
        applyPhase('idle', false);
      }
    });
    port.onDisconnect.addListener(() => {
      if (keepAlivePort === port) keepAlivePort = null;
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      if (keepAliveExpected) {
        keepAliveReconnectTimer = setTimeout(startKeepAlive, 1000);
      }
    });
    keepAliveTimer = setInterval(ping, 15000);
    setTimeout(ping, 1500);
  } catch (error) {
    keepAliveReconnectTimer = setTimeout(startKeepAlive, 1500);
  }
}

function setRunning(running) {
  $('btnCollect').disabled = running;
  $('btnPause').disabled = !running;
  $('btnStop').disabled = !running;
  $('btnDeliver').disabled = running || deliverySubmitPending;
  $('btnBuildFollowups').disabled = running;
  $('btnSendFollowups').disabled = running;
  $('followupDate').disabled = running;
  $('followupStart').disabled = running;
  $('followupEnd').disabled = running;
  $('followupScanMode').disabled = running;
  $('followupConversationCount').disabled = running;
  $('collectionSource').disabled = running;
  $('screeningMode').disabled = running;
  $('city').disabled = running;
  if (!running) updateCollectionSource();
  if (!running) $('btnPause').textContent = '暂停';
  if (running) startKeepAlive();
  else stopKeepAlive();
}
function setDeliveryActive(active) {
  $('btnReviewStop').hidden = !active;
  $('btnDeliver').hidden = active;
}

// 渲染审核列表
function renderReview(screened) {
  const matched = screened.filter(j => j.match === true);
  const skipped = screened.filter(j => j.match !== true);
  const bulkMode = screened.some(j => j.screeningMode === 'bulk');
  $('reviewCount').textContent = (bulkMode ? '海投可投 ' : 'AI 匹配 ') + matched.length + ' / ' + screened.length;
  $('selAllLabel').textContent = bulkMode ? '全选可投' : '全选匹配';
  let html = '';
  matched.forEach(j => {
    const processedState = processedJobs[j.id];
    const processed = Boolean(processedState);
    const processedLabel = processedState === 'uncertain'
      ? '⚠ 上次操作结果待确认，已锁定防止重复'
      : '✓ 已投递，本轮不会重复';
    html += '<div class="job-item' + (processed ? ' processed' : '') + '"><input type="checkbox" ' +
      (processed ? 'disabled ' : 'checked ') + 'data-id="' + esc(j.id) + '">'
      + '<div class="job-main"><div class="job-title">' + esc(j.name) + '</div>'
      + renderJobMeta(j)
      + '<div class="job-reason m">' +
      (processed ? processedLabel : '✓ ' + esc(j.reason)) +
      '</div></div></div>';
  });
  skipped.forEach(j => {
    html += '<div class="job-item skip"><input type="checkbox" disabled data-id="' + esc(j.id) + '">'
      + '<div class="job-main"><div class="job-title">' + esc(j.name) + '</div>'
      + renderJobMeta(j)
      + '<div class="job-reason s">✗ ' + esc(j.reason) + '</div></div></div>';
  });
  $('reviewList').innerHTML = html || '<div class="job-sub">无岗位</div>';
  $('reviewCard').style.display = 'block';
}
function renderJobMeta(job) {
  const salaryFallback = job.salaryUnavailable ? '需在 BOSS 查看' : '未获取';
  const fields = [
    ['公司', job.company || '未获取', !job.company],
    ['薪资', job.salary || salaryFallback, !job.salary],
    ['地区', job.area || '未获取', !job.area]
  ];
  return '<div class="job-meta">' + fields.map(field => {
    return '<span class="' + (field[2] ? 'missing' : '') + '"><b>' +
      field[0] + '：</b>' + esc(field[1]) + '</span>';
  }).join('') + '</div>';
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 消息接收
function applyPhase(phase, deliveryActive, followupActive) {
  const map = {
    idle: '未开始',
    collecting: '收集中',
    screening: 'AI筛选中',
    review: '待审核',
    delivering: '投递中',
    drafting_followups: '生成补充草稿中',
    followup_review: '补充草稿待审核',
    sending_followups: '发送补充介绍中',
    done: '已完成'
  };
  $('phaseText').textContent = map[phase] || phase;
  const isDelivering = deliveryActive === true || phase === 'delivering';
  setDeliveryActive(isDelivering);
  setRunning(isBackendRunning(phase, deliveryActive, followupActive));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') addLog(msg.text, msg.level);
  if (msg.type === 'PROGRESS') $('progText').textContent = (msg.label ? msg.label + ' ' : '') + msg.cur + '/' + msg.total;
  if (msg.type === 'PHASE') applyPhase(msg.phase);
  if (msg.type === 'SCREENED') renderReview(msg.screened);
  if (msg.type === 'MOBILE_FOLLOWUP_DRAFTS') renderFollowupDrafts(msg.drafts || []);
  if (msg.type === 'MOBILE_FOLLOWUP_ITEM') {
    mobileFollowupSent[msg.id] = msg.status === 'uncertain' ? 'uncertain' : 1;
    renderFollowupDrafts(mobileFollowupDrafts);
  }
  if (msg.type === 'MOBILE_FOLLOWUP_DONE') {
    setRunning(false);
    setFollowupStatus(
      '发送完成：成功 ' + msg.ok + '，失败 ' + msg.fail + (msg.stopped ? '；已安全停止' : ''),
      msg.fail ? 'warn' : 'success'
    );
  }
  if (msg.type === 'DELIVERY_ITEM' && (msg.ok || msg.status === 'uncertain')) {
    const status = msg.status === 'uncertain' ? 'uncertain' : 1;
    processedJobs[msg.id] = status;
    const input = Array.from(document.querySelectorAll('.job-item input')).find(item => item.dataset.id === msg.id);
    if (input) {
      input.checked = false;
      input.disabled = true;
      const item = input.closest('.job-item');
      item.classList.add('processed');
      const reason = item.querySelector('.job-reason');
      if (reason) {
        reason.textContent = status === 'uncertain'
          ? '⚠ 上次操作结果待确认，已锁定防止重复'
          : '✓ 已投递，本轮不会重复';
      }
    }
  }
  if (msg.type === 'DONE') { setRunning(false); setDeliveryActive(false); $('progText').textContent = ''; }
});

sendRuntimeMessage({ type: 'GET_STATE' }).then(current => {
  if (!current) return;
  if (current.screened && current.screened.length) renderReview(current.screened);
  applyPhase(current.phase || 'idle', current.deliveryActive, current.followupActive);
  if (current.paused && isBackendRunning(current.phase, current.deliveryActive, current.followupActive)) {
    $('btnPause').textContent = '继续';
  }
}).catch(() => {});

function addLog(text, level) {
  level = level || 'info';
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const el = document.createElement('div');
  el.className = 'log-item ' + level;
  el.innerHTML = '<span class="log-time">[' + t + ']</span>' + esc(text);
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}
