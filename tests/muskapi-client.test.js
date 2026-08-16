'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENDPOINT,
  DEFAULT_MODEL,
  ALLOWED_MODELS,
  normalizeModel,
  extractContent,
  extractJsonObject,
  createClient
} = require('../JobCopilot · AI/src/muskapi-client.js');

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function completion(content) {
  return { choices: [{ message: { content: content } }] };
}

test('uses the fixed MuskAI endpoint, Bearer auth, and GPT-5.6 request fields', async () => {
  let captured;
  const client = createClient({
    endpoint: 'https://example.invalid/should-not-be-used',
    fetchImpl: async (url, options) => {
      captured = { url: url, options: options };
      return jsonResponse(completion('OK'));
    }
  });

  const result = await client.chat({
    apiKey: 'test-secret-key',
    messages: [{ role: 'user', content: 'ping' }],
    maxCompletionTokens: 123
  });

  assert.equal(result, 'OK');
  assert.equal(captured.url, ENDPOINT);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-secret-key');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_completion_tokens, 123);
  assert.equal(body.store, false);
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
});

test('defaults to Terra and only accepts the three approved models', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-5.6-terra');
  assert.deepEqual(ALLOWED_MODELS, [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
  ]);
  assert.equal(normalizeModel(), DEFAULT_MODEL);
  for (const model of ALLOWED_MODELS) assert.equal(normalizeModel(model), model);
  assert.throws(() => normalizeModel('gpt-5.6'), /不支持的 GPT-5.6 模型/);
});

test('parses string and content-part responses', () => {
  assert.equal(extractContent(completion('hello')), 'hello');
  assert.equal(extractContent(completion([
    { type: 'text', text: 'hel' },
    { type: 'text', text: 'lo' }
  ])), 'hello');
  assert.throws(() => extractContent({ choices: [] }), /返回格式异常/);
});

test('preserves multimodal Chat Completions message content for OCR', async () => {
  let body;
  const client = createClient({
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse(completion('OCR text'));
    }
  });
  const content = [
    { type: 'text', text: 'transcribe' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,b2Ny', detail: 'high' }
    }
  ];
  await client.chat({
    apiKey: 'test-key',
    messages: [{ role: 'user', content: content }]
  });
  assert.deepEqual(body.messages[0].content, content);
  assert.equal(body.store, false);
});

test('extracts JSON from direct, fenced, and surrounding text output', () => {
  assert.deepEqual(extractJsonObject('{"match":true,"reason":"匹配"}'), {
    match: true,
    reason: '匹配'
  });
  assert.deepEqual(extractJsonObject('```json\n{"match":false,"reason":"超纲"}\n```'), {
    match: false,
    reason: '超纲'
  });
  assert.deepEqual(extractJsonObject('结果：{"match":true,"reason":"相关"}。'), {
    match: true,
    reason: '相关'
  });
  assert.equal(extractJsonObject('not json'), null);
});

test('falls back without JSON Schema when the relay rejects response_format', async () => {
  const bodies = [];
  const client = createClient({
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return jsonResponse({ error: { message: 'response_format json_schema is unsupported' } }, 400);
      }
      return jsonResponse(completion('{"match":true,"reason":"匹配"}'));
    }
  });

  const output = await client.chat({
    apiKey: 'test-key',
    messages: [{ role: 'user', content: 'screen' }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'screening', schema: { type: 'object' } }
    }
  });

  assert.match(output, /"match":true/);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].response_format.type, 'json_schema');
  assert.equal('response_format' in bodies[1], false);
});

test('recognizes an OpenAI-style response_format parameter rejection', async () => {
  const bodies = [];
  const client = createClient({
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return jsonResponse({
          error: {
            message: 'Unsupported parameter',
            param: 'response_format',
            type: 'invalid_request_error'
          }
        }, 400);
      }
      return jsonResponse(completion('{"match":false,"reason":"不匹配"}'));
    }
  });

  const result = await client.chat({
    apiKey: 'test-key',
    messages: [],
    responseFormat: { type: 'json_schema', json_schema: { name: 'screening' } }
  });

  assert.match(result, /"match":false/);
  assert.equal('response_format' in bodies[1], false);
});

test('retries network errors, 429, and 5xx with a finite attempt limit', async t => {
  for (const scenario of [
    {
      name: 'network error',
      first: () => { throw new TypeError('socket failed'); }
    },
    {
      name: 'HTTP 429',
      first: () => jsonResponse({ error: { message: 'rate limited' } }, 429)
    },
    {
      name: 'HTTP 503',
      first: () => jsonResponse({ error: { message: 'unavailable' } }, 503)
    }
  ]) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const client = createClient({
        maxAttempts: 2,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls++;
          if (calls === 1) return scenario.first();
          return jsonResponse(completion('recovered'));
        }
      });
      assert.equal(await client.chat({ apiKey: 'test-key', messages: [] }), 'recovered');
      assert.equal(calls, 2);
    });
  }
});

test('aborts timed-out requests and retries only up to maxAttempts', async () => {
  let calls = 0;
  const client = createClient({
    timeoutMs: 5,
    maxAttempts: 2,
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      calls++;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
  });

  await assert.rejects(
    client.chat({ apiKey: 'test-key', messages: [] }),
    error => error.code === 'timeout' && /请求超时/.test(error.message)
  );
  assert.equal(calls, 2);
});

test('maps permanent HTTP errors to clear Chinese messages without leaking the key', async t => {
  const cases = [
    [401, /API Key 无效/],
    [402, /余额或额度不足/],
    [403, /没有访问所选模型的权限/],
    [404, /接口或所选模型不存在/],
    [429, /请求过于频繁或额度不足/],
    [500, /服务暂时不可用/]
  ];

  for (const [status, expected] of cases) {
    await t.test('HTTP ' + status, async () => {
      const secret = 'never-print-this-secret';
      const client = createClient({
        maxAttempts: 1,
        fetchImpl: async () => jsonResponse({
          error: { message: 'provider echoed ' + secret }
        }, status)
      });

      await assert.rejects(
        client.chat({ apiKey: secret, messages: [] }),
        error => expected.test(error.message) && !error.message.includes(secret)
      );
    });
  }
});

test('maps provider quota codes even when the relay returns HTTP 400', async () => {
  const client = createClient({
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse({
      error: {
        message: 'You exceeded your current quota',
        code: 'insufficient_quota'
      }
    }, 400)
  });

  await assert.rejects(
    client.chat({ apiKey: 'test-key', messages: [] }),
    error => error.code === 'insufficient_quota' && /余额或额度不足/.test(error.message)
  );
});

test('rejects missing keys and malformed successful responses safely', async () => {
  const client = createClient({
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse({ choices: [] })
  });

  await assert.rejects(client.chat({ messages: [] }), /未配置 MuskAI API Key/);
  await assert.rejects(
    client.chat({ apiKey: 'test-key', messages: [] }),
    error => error.code === 'invalid_response' && /返回格式异常/.test(error.message)
  );
});
