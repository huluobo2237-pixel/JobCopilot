const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeGreeting,
  assessGreeting,
  buildMessages,
  chooseBetterGreeting
} = require('../JobCopilot · AI/src/greeting-core.js');

test('builds a high-information JD greeting prompt without embedding personal fixture data', () => {
  const messages = buildMessages({
    resumeText: '张明，某大学计算机专业2027届本科生。做过知识库问答平台。',
    job: { name: 'AI应用开发实习生', company: '示例科技', tags: ['Python', 'RAG'] },
    jd: '负责Python接口、RAG知识库和异步任务开发。'
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /Boss您好/);
  assert.match(messages[0].content, /姓名、学校、专业、毕业届别/);
  assert.match(messages[0].content, /1-2段最匹配的项目或实习/);
  assert.match(messages[1].content, /AI应用开发实习生/);
  assert.match(messages[1].content, /Python接口、RAG知识库/);
});

test('sanitizes greeting wrappers and newlines', () => {
  assert.equal(
    sanitizeGreeting('```text\n招呼语：Boss您好，\n我是张明。\n```'),
    'Boss您好， 我是张明。'
  );
});

test('accepts a concrete identity-skill-project-interest greeting', () => {
  const greeting = 'Boss您好，我叫张明，是某大学计算机专业2027届本科生，主要方向是Python后端与AI应用开发。熟悉Python、FastAPI、Redis、Docker、Pandas、RAG及Agent技术，完成过企业知识库问答平台和智能任务编排系统，负责接口开发、异步任务、数据处理与检索链路。目前也在数据实习中参与指标分析和可视化报表。我对贵公司的AI应用开发岗位很感兴趣，希望有机会进一步沟通。';
  const result = assessGreeting(greeting);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('flags generic short drafts and prefers a rewritten concrete greeting', () => {
  const generic = '熟悉Python，做过相关项目，希望有机会沟通。';
  const improved = 'Boss您好，我是某大学软件工程专业2027届本科生，主要方向是Python后端与AI应用开发。熟悉Python、FastAPI、Redis、Docker、RAG和Agent技术，完成过知识库问答平台与任务编排系统，负责接口开发、异步任务、数据库处理和检索流程，也参与过数据清洗与可视化实习工作。我对贵公司的后端开发岗位很感兴趣，希望有机会进一步沟通。';
  assert.ok(assessGreeting(generic).issues.length > 0);
  assert.equal(chooseBetterGreeting(generic, improved), improved);
});
