(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MobileFollowupCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function localDateKey(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function clockMinutes(value) {
    const match = cleanText(value).match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return -1;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return -1;
    return hours * 60 + minutes;
  }

  function parseConversationDateKey(timeText, now) {
    const text = cleanText(timeText);
    now = now instanceof Date ? now : new Date();
    let date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const fullDate = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
    const shortDate = text.match(/(?:^|\s)(\d{1,2})[-/.](\d{1,2})(?:\s|$)/);
    const chineseDate = text.match(/(\d{1,2})月(\d{1,2})日/);
    if (fullDate) {
      date = new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3]));
    } else if (chineseDate) {
      date = new Date(now.getFullYear(), Number(chineseDate[1]) - 1, Number(chineseDate[2]));
    } else if (shortDate) {
      date = new Date(now.getFullYear(), Number(shortDate[1]) - 1, Number(shortDate[2]));
    } else if (text.includes('昨天')) {
      date.setDate(date.getDate() - 1);
    } else if (!text.includes('今天') && !/(?:^|\s)\d{1,2}:\d{2}(?:\s|$)/.test(text)) {
      return '';
    }
    return localDateKey(date);
  }

  function parseConversationDateTime(timeText, now) {
    const text = cleanText(timeText);
    const clock = text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/);
    if (!clock) return null;
    const minutes = clockMinutes(clock[1] + ':' + clock[2]);
    if (minutes < 0) return null;
    const date = parseConversationDateKey(text, now);
    if (!date) return null;
    return {
      date: date,
      minutes: minutes,
      clock: pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60)
    };
  }

  function validateRange(params) {
    params = params || {};
    const date = cleanText(params.date);
    const start = clockMinutes(params.start);
    const end = clockMinutes(params.end);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: '请选择有效日期' };
    }
    const parts = date.split('-').map(Number);
    const parsedDate = new Date(parts[0], parts[1] - 1, parts[2]);
    if (
      parsedDate.getFullYear() !== parts[0] ||
      parsedDate.getMonth() !== parts[1] - 1 ||
      parsedDate.getDate() !== parts[2]
    ) {
      return { ok: false, error: '请选择有效日期' };
    }
    if (start < 0 || end < 0) {
      return { ok: false, error: '请输入有效的开始和结束时间' };
    }
    if (end < start) {
      return { ok: false, error: '结束时间不能早于开始时间' };
    }
    if (end - start > 180) {
      return { ok: false, error: '单次扫描时间范围不能超过 3 小时' };
    }
    return { ok: true, date: date, start: start, end: end };
  }

  function validateScanParams(params) {
    params = params || {};
    const mode = cleanText(params.mode) === 'count' ? 'count' : 'range';
    if (mode === 'count') {
      const count = Number(params.count);
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        return { ok: false, mode: mode, error: '会话数量需为 1–50 的整数' };
      }
      return { ok: true, mode: mode, count: count };
    }
    const range = validateRange(params);
    return Object.assign({ mode: mode }, range);
  }

  function isWithinRange(timeText, params, now) {
    const range = validateRange(params);
    if (!range.ok) return false;
    const parsed = parseConversationDateTime(timeText, now);
    return Boolean(
      parsed &&
      parsed.date === range.date &&
      parsed.minutes >= range.start &&
      parsed.minutes <= range.end
    );
  }

  function classifyConversationTime(timeText, params, now) {
    const range = validateRange(params);
    if (!range.ok) return 'none';
    if (isWithinRange(timeText, params, now)) return 'exact';
    const hasClock = /(?:^|\s)\d{1,2}:\d{2}(?:\s|$)/.test(cleanText(timeText));
    if (!hasClock && parseConversationDateKey(timeText, now) === range.date) return 'date_only';
    return 'none';
  }

  function hasDeliveredMarker(preview) {
    return /[\[【]\s*送达\s*[\]】]/.test(cleanText(preview));
  }

  function isGenericIntroText(preview) {
    const text = cleanText(preview);
    if (!text) return false;
    return /您好[，,]?\s*我是|我叫|希望有机会|对(?:贵公司|这个岗位|该岗位).*感兴趣/.test(text);
  }

  function isLikelyGenericIntro(preview) {
    return hasDeliveredMarker(preview) && isGenericIntroText(preview);
  }

  function comparableIntro(value) {
    return cleanText(value)
      .replace(/[\[【]\s*送达\s*[\]】]/g, '')
      .replace(/[.…]{2,}$/g, '')
      .replace(/[\s，,。！？!?:：；;、"'“”‘’（）()【】[\]]+/g, '')
      .trim();
  }

  function textsOverlap(left, right) {
    const a = comparableIntro(left);
    const b = comparableIntro(right);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 8;
    const limit = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < limit && a[prefix] === b[prefix]) prefix++;
    return prefix >= 8;
  }

  function findMatchingOutgoingGenericIntro(preview, recentSelfMessages) {
    if (!isGenericIntroText(preview)) return null;
    const messages = (recentSelfMessages || []).slice().reverse();
    return messages.find(function (message) {
      const text = cleanText(message && (message.text || message));
      return isGenericIntroText(text) && textsOverlap(preview, text);
    }) || null;
  }

  function findRecentOutgoingGenericIntro(recentSelfMessages) {
    return (recentSelfMessages || []).slice().reverse().find(function (message) {
      return isGenericIntroText(message && (message.text || message));
    }) || null;
  }

  function confirmOutgoingGenericIntro(preview, recentSelfMessages) {
    if (!isGenericIntroText(preview)) return false;
    if (hasDeliveredMarker(preview)) return true;
    return Boolean(findMatchingOutgoingGenericIntro(preview, recentSelfMessages));
  }

  function hasExplicitDateLabel(value) {
    const text = cleanText(value);
    return /(?:昨天|今天)/.test(text) ||
      /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.test(text) ||
      /(\d{1,2})月(\d{1,2})日/.test(text) ||
      /(?:^|\s)(\d{1,2})[-/.](\d{1,2})(?:\s|$)/.test(text);
  }

  function resolveMessageDateTime(timeText, conversationTimeText, now) {
    const parsed = parseConversationDateTime(timeText, now);
    if (!parsed) return null;
    if (hasExplicitDateLabel(timeText)) return parsed;
    const conversationDate = parseConversationDateKey(conversationTimeText, now);
    if (!conversationDate) return parsed;
    return {
      date: conversationDate,
      minutes: parsed.minutes,
      clock: parsed.clock
    };
  }

  function isMessageWithinRange(timeText, params, conversationTimeText, now) {
    const range = validateRange(params);
    if (!range.ok) return false;
    const parsed = resolveMessageDateTime(timeText, conversationTimeText, now);
    return Boolean(
      parsed &&
      parsed.date === range.date &&
      parsed.minutes >= range.start &&
      parsed.minutes <= range.end
    );
  }

  function normalizeJobDetailUrl(value, baseUrl) {
    const text = cleanText(value);
    if (!text) return '';
    try {
      const url = new URL(text, baseUrl || 'https://www.zhipin.com/');
      const hostname = url.hostname.toLowerCase();
      if (hostname !== 'zhipin.com' && !hostname.endsWith('.zhipin.com')) return '';
      if (!/^\/job_detail\/[^/?#]+\.html$/i.test(url.pathname)) return '';
      url.hash = '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function jobIdFromDetailUrl(value, baseUrl) {
    const normalized = normalizeJobDetailUrl(value, baseUrl);
    if (!normalized) return '';
    try {
      const match = new URL(normalized).pathname.match(/^\/job_detail\/([^/?#]+)\.html$/i);
      if (!match) return '';
      return decodeURIComponent(match[1]);
    } catch (error) {
      return '';
    }
  }

  function normalizeExactJobDetailUrl(value, expectedJobId, baseUrl) {
    const normalized = normalizeJobDetailUrl(value, baseUrl);
    const expected = cleanText(expectedJobId);
    if (!normalized || !expected) return '';
    return jobIdFromDetailUrl(normalized) === expected ? normalized : '';
  }

  function filterCandidates(conversations, params, now) {
    const scan = validateScanParams(params);
    if (!scan.ok) return [];
    if (scan.mode === 'count') {
      return (conversations || []).slice(0, scan.count).map(function (conversation) {
        return Object.assign({}, conversation, { timeMatchMode: 'count' });
      });
    }
    return (conversations || []).map(function (conversation) {
      return Object.assign({}, conversation, {
        timeMatchMode: classifyConversationTime(conversation.timeText, params, now)
      });
    }).filter(function (conversation) {
      return conversation.timeMatchMode !== 'none' && isGenericIntroText(conversation.preview);
    });
  }

  function validateDraftSelection(selected, candidates, sent, generatedDrafts) {
    const candidateMap = new Map((candidates || []).map(function (item) {
      return [cleanText(item && item.id), item];
    }).filter(function (entry) {
      return Boolean(entry[0]);
    }));
    const eligibleIds = generatedDrafts
      ? new Set((generatedDrafts || []).filter(function (item) {
        return item && item.text && !item.error;
      }).map(function (item) {
        return cleanText(item.id);
      }).filter(Boolean))
      : null;
    const seen = new Set();
    const drafts = [];
    for (const item of selected || []) {
      const id = cleanText(item && item.id);
      const text = cleanText(item && item.text);
      const candidate = candidateMap.get(id);
      if (!id || !candidate) {
        return { ok: false, error: '补充消息与本次扫描会话不一致', drafts: [] };
      }
      if (candidate.scanError || !normalizeJobDetailUrl(candidate.jobUrl)) {
        return { ok: false, error: '所选会话缺少可核验的岗位详情，已阻止发送', drafts: [] };
      }
      if (eligibleIds && !eligibleIds.has(id)) {
        return { ok: false, error: '所选会话没有可审核的已生成草稿，已阻止发送', drafts: [] };
      }
      if (seen.has(id)) {
        return { ok: false, error: '检测到重复会话，已阻止发送', drafts: [] };
      }
      if (sent && sent[id]) {
        return { ok: false, error: '所选会话中包含已发送或状态待确认的记录', drafts: [] };
      }
      if (text.length < 15 || text.length > 350) {
        return { ok: false, error: '每条补充介绍需为 15–350 个字符', drafts: [] };
      }
      seen.add(id);
      drafts.push({ id: id, text: text });
    }
    if (!drafts.length) return { ok: false, error: '请至少选择一条补充介绍', drafts: [] };
    return { ok: true, error: '', drafts: drafts };
  }

  return Object.freeze({
    cleanText: cleanText,
    localDateKey: localDateKey,
    clockMinutes: clockMinutes,
    parseConversationDateKey: parseConversationDateKey,
    parseConversationDateTime: parseConversationDateTime,
    validateRange: validateRange,
    validateScanParams: validateScanParams,
    isWithinRange: isWithinRange,
    classifyConversationTime: classifyConversationTime,
    hasDeliveredMarker: hasDeliveredMarker,
    isGenericIntroText: isGenericIntroText,
    isLikelyGenericIntro: isLikelyGenericIntro,
    findMatchingOutgoingGenericIntro: findMatchingOutgoingGenericIntro,
    findRecentOutgoingGenericIntro: findRecentOutgoingGenericIntro,
    confirmOutgoingGenericIntro: confirmOutgoingGenericIntro,
    resolveMessageDateTime: resolveMessageDateTime,
    isMessageWithinRange: isMessageWithinRange,
    normalizeJobDetailUrl: normalizeJobDetailUrl,
    jobIdFromDetailUrl: jobIdFromDetailUrl,
    normalizeExactJobDetailUrl: normalizeExactJobDetailUrl,
    filterCandidates: filterCandidates,
    validateDraftSelection: validateDraftSelection
  });
});
