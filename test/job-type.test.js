// 求职类型筛选 —— 零依赖单元测试
// 运行：node test/job-type.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'JobCopilot · AI', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const bg = read('background.js');
const selectors = read('selectors.js');
const html = read('sidepanel.html');
const panel = read('sidepanel.js');

// 从 background.js 中提取纯逻辑，放进沙箱里跑，避免 chrome.* 依赖
const pick = (re, name) => {
  const m = bg.match(re);
  assert.ok(m, 'background.js 中未找到 ' + name);
  return m[0];
};
const ctx = { URLSearchParams };
vm.createContext(ctx);
vm.runInContext([
  selectors,
  pick(/const JOB_TYPE_NAMES = \{[^}]*\};/, 'JOB_TYPE_NAMES'),
  pick(/function resolveCity\(cfg\) \{[\s\S]*?\n\}/, 'resolveCity'),
  pick(/function buildSearchUrl\(cfg\) \{[\s\S]*?\n\}/, 'buildSearchUrl')
].join('\n'), ctx);

const searchUrl = (cfg) => new URL(ctx.buildSearchUrl(cfg));

let passed = 0;
const it = (name, fn) => { fn(); passed++; console.log('  \u2713 ' + name); };

console.log('求职类型筛选测试');

it('不限（空值）不携带 jobType', () => {
  assert.strictEqual(searchUrl({ keyword: 'java', city: '北京', jobType: '' }).searchParams.has('jobType'), false);
});

it('未设置求职类型时不携带 jobType', () => {
  assert.strictEqual(searchUrl({ keyword: 'java', city: '北京' }).searchParams.has('jobType'), false);
});

it('全职 → jobType=1901', () => {
  assert.strictEqual(searchUrl({ keyword: 'java', city: '北京', jobType: '1901' }).searchParams.get('jobType'), '1901');
});

it('实习 → jobType=1902', () => {
  assert.strictEqual(searchUrl({ keyword: 'java', city: '北京', jobType: '1902' }).searchParams.get('jobType'), '1902');
});

it('兼职 → jobType=1903', () => {
  assert.strictEqual(searchUrl({ keyword: 'java', city: '北京', jobType: '1903' }).searchParams.get('jobType'), '1903');
});

it('不改动关键词与城市，城市正确编码', () => {
  const u = searchUrl({ keyword: '数据分析', city: '沈阳', jobType: '1901' });
  assert.strictEqual(u.searchParams.get('query'), '数据分析');
  assert.strictEqual(u.searchParams.get('city'), '101070100');
});

it('城市未识别时回退全国编码且不携带 jobType（空）', () => {
  const u = searchUrl({ keyword: 'java', city: '不存在的城市', jobType: '' });
  assert.strictEqual(u.searchParams.get('city'), '100010000');
  assert.strictEqual(u.searchParams.has('jobType'), false);
});

it('侧边栏存在求职类型下拉框，且选项与后台一致', () => {
  const sel = html.match(/<select id="jobType">([\s\S]*?)<\/select>/);
  assert.ok(sel, 'sidepanel.html 缺少 <select id="jobType">');
  const opts = [...sel[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(opts, [['', '不限'], ['1901', '全职'], ['1902', '实习'], ['1903', '兼职']]);
});

it('侧边栏把 jobType 纳入配置的读写', () => {
  assert.ok(/'jobType'/.test(panel), "sidepanel.js CFG_FIELDS 缺少 'jobType'");
});

it('后台 getCfg 读取 jobType', () => {
  assert.ok(/chrome\.storage\.local\.get\(\[[^\]]*'jobType'[^\]]*\]\)/.test(bg), "background.js getCfg 缺少 'jobType'");
});

it('求职类型名称映射与下拉框一致', () => {
  const names = vm.runInContext('JOB_TYPE_NAMES', ctx);
  assert.strictEqual(JSON.stringify(names), JSON.stringify({ 1901: '全职', 1902: '实习', 1903: '兼职' }));
});

console.log('\n全部通过：' + passed + ' 项');
