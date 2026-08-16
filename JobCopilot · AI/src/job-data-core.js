(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobDataCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const PUA_PATTERN = /[\uE000-\uF8FF]/;
  const SEARCH_FILTER_KEYS = Object.freeze([
    'experience', 'payType', 'partTime', 'degree', 'industry', 'scale',
    'stage', 'position', 'jobType', 'salary', 'multiBusinessDistrict', 'multiSubway'
  ]);

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hasPrivateUseCharacters(value) {
    return PUA_PATTERN.test(String(value || ''));
  }

  function readableSalary(value) {
    const text = cleanText(value);
    return text && !hasPrivateUseCharacters(text) ? text : '';
  }

  function uniqueTexts(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const text = cleanText(value);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
    return result;
  }

  function parseCityNames(value) {
    const seen = new Set();
    const names = [];
    for (const rawName of String(value || '').split(/[\/、,，;；\s]+/)) {
      const name = rawName.trim().replace(/[市省]$/, '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  function resolveCitySearches(value, cityMap) {
    cityMap = cityMap || {};
    let requested = parseCityNames(value);
    if (requested.length === 1 && !cityMap[requested[0]]) {
      const connectorParts = requested[0].split(/[和跟与]/).map(function (name) {
        return name.trim().replace(/[市省]$/, '');
      }).filter(Boolean);
      if (connectorParts.length > 1 && connectorParts.every(function (name) { return Boolean(cityMap[name]); })) {
        requested = connectorParts;
      }
    }
    const cities = [];
    const unknown = [];
    const seenCodes = new Set();
    for (const name of requested) {
      const code = cleanText(cityMap[name]);
      if (!code) {
        unknown.push(name);
        continue;
      }
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);
      cities.push({ name: name, code: code });
    }
    const usedFallback = requested.length > 0 && cities.length === 0;
    if (!cities.length) {
      cities.push({
        name: '全国',
        code: cleanText(cityMap['全国']) || '100010000'
      });
    }
    return {
      cities: cities,
      unknown: unknown,
      usedFallback: usedFallback
    };
  }

  function allocateCityTargets(cityCount, totalCount) {
    const count = Math.max(1, Math.floor(Number(totalCount) || 1));
    const cities = Math.max(1, Math.floor(Number(cityCount) || 1));
    const effectiveTotal = Math.max(count, cities);
    const base = Math.floor(effectiveTotal / cities);
    const remainder = effectiveTotal % cities;
    return Array.from({ length: cities }, function (_, index) {
      return base + (index < remainder ? 1 : 0);
    });
  }

  function normalizeCollectionSource(value) {
    return cleanText(value) === 'recommend' ? 'recommend' : 'search';
  }

  function effectiveScreeningMode(collectionSource, screeningMode) {
    if (normalizeCollectionSource(collectionSource) === 'recommend') return 'ai';
    return cleanText(screeningMode) === 'ai' ? 'ai' : 'bulk';
  }

  function obviousRecommendationMismatch(targetKeyword, jobName) {
    const target = cleanText(targetKeyword).toLowerCase();
    const name = cleanText(jobName).toLowerCase();
    if (!target || !name) return false;
    const technicalTerms = [
      'ai', 'agent', '人工智能', '大模型', '算法', '开发', '工程师', '程序员',
      '全栈', '后端', '前端', '测试', '运维', 'python', 'java', 'rag', 'llm'
    ];
    const unrelatedServiceTerms = [
      '陪玩', '主播', '直播', '客服', '销售', '骑手', '服务员', '店员', '普工',
      '操作工', '保安', '保洁', '家政', '美容', '健身教练', '电话营销'
    ];
    const technicalTarget = technicalTerms.some(term => target.includes(term));
    const targetAllowsService = unrelatedServiceTerms.some(term => target.includes(term));
    const serviceJob = unrelatedServiceTerms.some(term => name.includes(term));
    return technicalTarget && !targetAllowsService && serviceJob;
  }

  function mergeUniqueJobs(existing, incoming, limit) {
    const jobs = [];
    const seen = new Set();
    const max = Math.max(1, Math.floor(Number(limit) || 1));
    for (const rawJob of [].concat(existing || [], incoming || [])) {
      const job = rawJob || {};
      const key = cleanText(job.id) || [
        cleanText(job.name),
        cleanText(job.company),
        cleanText(job.area)
      ].join('|');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
      if (jobs.length >= max) break;
    }
    return jobs;
  }

  function recommendationRefreshLimit(targetCount, firstBatchSize, absoluteMax) {
    const target = Math.max(1, Math.floor(Number(targetCount) || 1));
    const batch = Math.max(1, Math.floor(Number(firstBatchSize) || 1));
    const ceiling = Math.max(1, Math.floor(Number(absoluteMax) || 24));
    return Math.min(ceiling, Math.max(4, Math.ceil(target / batch) + 2));
  }

  function mergeCityJobResults(results, limit) {
    const jobs = [];
    const seen = new Set();
    const max = Math.max(1, Math.floor(Number(limit) || 1));
    for (const result of results || []) {
      for (const rawJob of (result && result.jobs) || []) {
        const job = rawJob || {};
        const key = cleanText(job.id) || [
          cleanText(job.name),
          cleanText(job.company),
          cleanText(job.area)
        ].join('|');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        jobs.push(Object.assign({}, job, {
          area: cleanText(job.area) || cleanText(result.cityName),
          sourceCityName: cleanText(result.cityName),
          sourceCityCode: cleanText(result.cityCode),
          sourceSearchUrl: cleanText(result.searchUrl)
        }));
        if (jobs.length >= max) return jobs;
      }
    }
    return jobs;
  }

  function normalizeArea(source) {
    source = source || {};
    const structured = uniqueTexts([
      source.cityName,
      source.areaDistrict,
      source.businessDistrict
    ]);
    if (structured.length) return structured.join('·');
    return cleanText(
      source.locationName || source.jobArea || source.areaName ||
      source.area || source.location || source.address
    );
  }

  function parseApiJob(raw, origin) {
    raw = raw || {};
    const id = cleanText(raw.encryptJobId || raw.jobId || raw.id || raw.securityId);
    const tagValues = [];
    for (const collection of [raw.jobLabels, raw.skills, raw.showSkills]) {
      if (Array.isArray(collection)) tagValues.push(...collection);
    }
    const explicitLink = cleanText(raw.jobUrl || raw.link || raw.url);
    const base = String(origin || '').replace(/\/$/, '');
    return {
      id: id,
      name: cleanText(raw.jobName || raw.name || raw.title),
      salary: readableSalary(raw.salaryDesc || raw.salary),
      company: cleanText(raw.brandName || raw.companyName || raw.company),
      area: normalizeArea(raw),
      tags: uniqueTexts(tagValues),
      link: explicitLink || (id && base ? base + '/job_detail/' + id + '.html' : ''),
      securityId: cleanText(raw.securityId),
      lid: cleanText(raw.lid)
    };
  }

  function extractApiJobs(payload, origin) {
    const zpData = payload && payload.zpData;
    const list = (zpData && (zpData.jobList || zpData.list)) ||
      (payload && payload.jobList) || [];
    if (!Array.isArray(list)) return [];
    return list.map(item => parseApiJob(item, origin)).filter(job => job.id || job.name);
  }

  function buildSearchParams(search, page, pageSize) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (!params.has('scene')) params.set('scene', '1');
    for (const key of SEARCH_FILTER_KEYS) {
      if (!params.has(key)) params.set(key, '');
    }
    params.set('page', String(Math.max(1, Number(page) || 1)));
    params.set('pageSize', String(Math.min(30, Math.max(1, Number(pageSize) || 30))));
    return params.toString();
  }

  function mergeJob(domJob, apiJob) {
    domJob = domJob || {};
    apiJob = apiJob || {};
    const rawDomSalary = domJob.salaryRaw || domJob.salary;
    const salary = readableSalary(apiJob.salary) || readableSalary(rawDomSalary);
    return Object.assign({}, domJob, {
      id: cleanText(domJob.id || apiJob.id),
      name: cleanText(apiJob.name || domJob.name) || '未知岗位',
      salary: salary,
      salaryUnavailable: !salary && (
        Boolean(domJob.salaryObfuscated) || hasPrivateUseCharacters(rawDomSalary)
      ),
      company: cleanText(apiJob.company || domJob.company),
      area: cleanText(apiJob.area || domJob.area),
      tags: uniqueTexts([].concat(apiJob.tags || [], domJob.tags || [])),
      link: cleanText(domJob.link || apiJob.link),
      securityId: cleanText(apiJob.securityId || domJob.securityId),
      lid: cleanText(apiJob.lid || domJob.lid)
    });
  }

  function mergeJobs(domJobs, apiJobs, limit) {
    const apiById = new Map();
    const apiByName = new Map();
    for (const job of apiJobs || []) {
      if (job.id) apiById.set(job.id, job);
      const name = cleanText(job.name);
      if (!name) continue;
      if (!apiByName.has(name)) apiByName.set(name, []);
      apiByName.get(name).push(job);
    }

    const used = new Set();
    const merged = [];
    for (const domJob of domJobs || []) {
      let apiJob = domJob.id ? apiById.get(cleanText(domJob.id)) : null;
      if (apiJob && used.has(apiJob)) apiJob = null;
      if (!apiJob) {
        const candidates = apiByName.get(cleanText(domJob.name)) || [];
        apiJob = candidates.find(candidate => {
          if (used.has(candidate)) return false;
          return !domJob.company || !candidate.company ||
            cleanText(domJob.company) === cleanText(candidate.company);
        }) || candidates.find(candidate => !used.has(candidate));
      }
      if (apiJob) used.add(apiJob);
      merged.push(mergeJob(domJob, apiJob));
      if (limit && merged.length >= limit) break;
    }
    return merged;
  }

  function approveJobsForBulk(jobs) {
    const seen = new Set();
    const approved = [];
    for (const job of jobs || []) {
      const id = cleanText(job && job.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      approved.push(Object.assign({}, job, {
        match: true,
        screeningMode: 'bulk',
        reason: '海投模式：已跳过 AI 前置筛选，请在投递前人工审核'
      }));
    }
    return approved;
  }

  function isExpectedNavigationDisconnect(value) {
    const message = cleanText(
      value && typeof value === 'object' ? value.message || value.error : value
    ).toLowerCase();
    return message.includes('back/forward cache') ||
      message.includes('message channel is closed') ||
      message.includes('message channel closed before a response was received') ||
      message.includes('message port closed before a response was received');
  }

  function prepareDeliveryBatch(requestedIds, jobs, screened, processed) {
    const normalizedIds = (requestedIds || []).map(cleanText).filter(Boolean);
    const uniqueIds = Array.from(new Set(normalizedIds));
    if (!normalizedIds.length) {
      return { ok: false, error: '没有收到待投递岗位', jobs: [], ids: [] };
    }
    if (uniqueIds.length !== normalizedIds.length) {
      return { ok: false, error: '检测到重复岗位，已阻止投递，请重新审核', jobs: [], ids: uniqueIds };
    }

    const jobsById = new Map((jobs || []).map(job => [cleanText(job && job.id), job]));
    const matchedIds = new Set(
      (screened || [])
        .filter(job => job && job.match === true)
        .map(job => cleanText(job.id))
        .filter(Boolean)
    );
    const approved = [];
    for (const id of uniqueIds) {
      if (!matchedIds.has(id)) {
        return { ok: false, error: '所选岗位中包含审核列表标记为不可投的岗位，已阻止本轮投递', jobs: [], ids: uniqueIds };
      }
      if (processed && processed[id]) {
        return { ok: false, error: '所选岗位中包含已投记录，已阻止重复投递', jobs: [], ids: uniqueIds };
      }
      const job = jobsById.get(id);
      if (!job) {
        return { ok: false, error: '所选岗位与本轮收集数据不一致，已阻止投递', jobs: [], ids: uniqueIds };
      }
      approved.push(job);
    }
    return { ok: true, error: '', jobs: approved, ids: uniqueIds };
  }

  function createDeliveryGate() {
    let active = false;
    return Object.freeze({
      tryStart: function () {
        if (active) return false;
        active = true;
        return true;
      },
      finish: function () { active = false; },
      isActive: function () { return active; }
    });
  }

  return Object.freeze({
    SEARCH_FILTER_KEYS: SEARCH_FILTER_KEYS,
    cleanText: cleanText,
    hasPrivateUseCharacters: hasPrivateUseCharacters,
    readableSalary: readableSalary,
    uniqueTexts: uniqueTexts,
    parseCityNames: parseCityNames,
    resolveCitySearches: resolveCitySearches,
    allocateCityTargets: allocateCityTargets,
    normalizeCollectionSource: normalizeCollectionSource,
    effectiveScreeningMode: effectiveScreeningMode,
    obviousRecommendationMismatch: obviousRecommendationMismatch,
    mergeUniqueJobs: mergeUniqueJobs,
    recommendationRefreshLimit: recommendationRefreshLimit,
    mergeCityJobResults: mergeCityJobResults,
    normalizeArea: normalizeArea,
    parseApiJob: parseApiJob,
    extractApiJobs: extractApiJobs,
    buildSearchParams: buildSearchParams,
    mergeJob: mergeJob,
    mergeJobs: mergeJobs,
    approveJobsForBulk: approveJobsForBulk,
    isExpectedNavigationDisconnect: isExpectedNavigationDisconnect,
    prepareDeliveryBatch: prepareDeliveryBatch,
    createDeliveryGate: createDeliveryGate
  });
});
