(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GreetingCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function sanitizeGreeting(value) {
    let text = String(value == null ? '' : value).trim();
    text = text.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '');
    text = text.replace(/^\s*(?:专属)?招呼语\s*[：:]\s*/i, '');
    text = text.replace(/^[“”"']+|[“”"']+$/g, '');
    return cleanText(text);
  }

  function assessGreeting(value) {
    const text = sanitizeGreeting(value);
    const length = Array.from(text).length;
    const issues = [];
    let score = 0;

    if (length >= 135 && length <= 300) score += 4;
    else if (length < 135) issues.push('内容过短，没有充分呈现身份、技能和经历');
    else issues.push('内容过长，需要压缩到300字以内');

    if (/^(?:Boss|BOSS|boss|HR)?您好[，,!！]?/.test(text)) score += 2;
    else issues.push('没有以“Boss您好”自然开场');

    if (/(?:我叫|我是)/.test(text)) score += 2;
    else issues.push('缺少求职者身份背景');

    if (/(?:项目|平台|系统|实习|负责|完成|开发|经验)/.test(text)) score += 2;
    else issues.push('缺少项目或实习证据');

    if (/(?:感兴趣|希望有机会|期待).*(?:沟通|交流)|进一步沟通/.test(text)) score += 2;
    else issues.push('缺少自然的沟通意愿结尾');

    if (/(?:以下是|招呼语|字数|作为.{0,4}AI|根据.{0,6}简历)/i.test(text)) {
      score -= 4;
      issues.push('包含模型说明或多余引导语');
    }

    return { text: text, length: length, score: score, issues: issues, ok: issues.length === 0 };
  }

  function buildMessages(input) {
    input = input || {};
    const job = input.job || {};
    const resume = String(input.resumeText || '').trim().slice(0, 14000);
    const jd = String(input.jd || '').trim().slice(0, 8000);
    const previousDraft = sanitizeGreeting(input.previousDraft || '');
    const issues = Array.isArray(input.issues) ? input.issues.filter(Boolean) : [];

    const system = [
      '你是求职者本人，正在BOSS直聘向目标岗位的招聘者发送第一条招呼语。回复会原样发出。',
      '写作目标：生成一段像真人写的、高信息密度、与JD明显对应的自我介绍，不写空泛套话。',
      '必须按以下顺序组织为一个自然段：',
      '1. 以“Boss您好”开头；紧接姓名、学校、专业、毕业届别或当前身份。只写简历中明确存在的信息，缺失时自然省略，绝不猜测。',
      '2. 用一句话说明主要求职方向，并使方向与目标岗位一致。',
      '3. 从JD与简历的交集中选择5-8项最关键技能，使用自然句子表达，不机械罗列全部关键词。',
      '4. 选择1-2段最匹配的项目或实习，写出项目名、承担工作和能力证据；优先接口开发、数据库、异步任务、数据处理、知识库、内部工具等与JD直接相关的内容。',
      '5. 结尾明确表达对该公司该岗位的兴趣，并以“希望有机会进一步沟通”或同等自然语句收束。',
      '质量要求：全文135-300个中文字符；信息具体但不夸张；不得虚构姓名、学校、学历、技能、项目、职责、成果或数字；不得使用“本人性格开朗”“学习能力强”“能吃苦”等无证据套话；不得要求对方立即回复；不得输出标题、项目符号、Markdown、注释、括号说明或字数统计。',
      '只输出JSON对象：{"greeting":"最终招呼语"}。'
    ].join('\n');

    const userParts = [
      '【我的简历】\n' + resume,
      '【目标公司】\n' + cleanText(job.company || '未获取'),
      '【目标岗位】\n' + cleanText(job.name || '未获取'),
      '【岗位JD】\n' + (jd || ('技能标签：' + (job.tags || []).join('、')))
    ];
    if (previousDraft) {
      userParts.push('【上一版草稿】\n' + previousDraft);
      userParts.push('【必须修正的问题】\n' + (issues.length ? issues.join('；') : '进一步提高信息密度和岗位针对性'));
      userParts.push('请彻底重写，不要只做局部同义替换。');
    } else {
      userParts.push('请直接生成一条可发送的专属招呼语。重点保留简历中与JD最匹配的身份、技能、项目和实习信息。');
    }

    return [
      { role: 'system', content: system },
      { role: 'user', content: userParts.join('\n\n') }
    ];
  }

  function chooseBetterGreeting(first, second) {
    const left = assessGreeting(first);
    const right = assessGreeting(second);
    if (!right.text) return left.text;
    if (!left.text) return right.text;
    if (right.score !== left.score) return right.score > left.score ? right.text : left.text;
    const ideal = 210;
    return Math.abs(right.length - ideal) < Math.abs(left.length - ideal) ? right.text : left.text;
  }

  return {
    sanitizeGreeting: sanitizeGreeting,
    assessGreeting: assessGreeting,
    buildMessages: buildMessages,
    chooseBetterGreeting: chooseBetterGreeting
  };
});
