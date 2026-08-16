(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MuskAIClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const ENDPOINT = 'https://api.muskapi.cc/v1/chat/completions';
  const DEFAULT_MODEL = 'gpt-5.6-terra';
  const ALLOWED_MODELS = Object.freeze([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
  ]);

  class MuskAPIError extends Error {
    constructor(message, options) {
      super(message);
      this.name = 'MuskAPIError';
      this.code = options && options.code;
      this.status = options && options.status;
    }
  }

  function normalizeModel(model) {
    const selected = model || DEFAULT_MODEL;
    if (!ALLOWED_MODELS.includes(selected)) {
      throw new MuskAPIError('不支持的 GPT-5.6 模型，请在 Sol、Terra、Luna 中选择', {
        code: 'invalid_model'
      });
    }
    return selected;
  }

  function extractContent(data) {
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(part => part && (part.type === 'text' || typeof part.text === 'string'))
        .map(part => part.text || '')
        .join('');
    }
    throw new MuskAPIError('MuskAI 返回格式异常：缺少模型输出', {
      code: 'invalid_response'
    });
  }

  function extractJsonObject(text) {
    if (typeof text !== 'string') return null;
    const cleaned = text.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (nestedError) {
        return null;
      }
    }
  }

  function hasQuotaError(payload) {
    const providerError = payload && payload.error && typeof payload.error === 'object'
      ? payload.error
      : {};
    const details = [
      providerError.code,
      providerError.type,
      getProviderMessage(payload)
    ].filter(Boolean).join(' ').toLowerCase();
    return details.includes('insufficient_quota') ||
      details.includes('quota exceeded') ||
      details.includes('insufficient balance') ||
      details.includes('余额不足') ||
      details.includes('额度不足');
  }

  function errorFromStatus(status, payload) {
    if (hasQuotaError(payload)) {
      return new MuskAPIError('MuskAI 账户余额或额度不足，请先充值或检查套餐', {
        code: 'insufficient_quota', status: status
      });
    }
    if (status === 401) {
      return new MuskAPIError('MuskAI API Key 无效，请检查后重试', {
        code: 'unauthorized', status: status
      });
    }
    if (status === 402) {
      return new MuskAPIError('MuskAI 账户余额或额度不足，请先充值或检查套餐', {
        code: 'insufficient_quota', status: status
      });
    }
    if (status === 403) {
      return new MuskAPIError('MuskAI API Key 没有访问所选模型的权限', {
        code: 'forbidden', status: status
      });
    }
    if (status === 404) {
      return new MuskAPIError('MuskAI 接口或所选模型不存在，请检查模型权限', {
        code: 'not_found', status: status
      });
    }
    if (status === 429) {
      return new MuskAPIError('MuskAI 请求过于频繁或额度不足，请稍后重试', {
        code: 'rate_limited', status: status
      });
    }
    if (status >= 500) {
      return new MuskAPIError('MuskAI 服务暂时不可用，请稍后重试', {
        code: 'server_error', status: status
      });
    }
    return new MuskAPIError('MuskAI 请求失败（HTTP ' + status + '），请检查配置', {
      code: 'request_failed', status: status
    });
  }

  function getProviderMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
    if (typeof payload.message === 'string') return payload.message;
    return '';
  }

  function rejectsJsonSchema(status, payload) {
    if (status !== 400 && status !== 422) return false;
    const providerError = payload && payload.error && typeof payload.error === 'object'
      ? payload.error
      : {};
    const message = [
      getProviderMessage(payload),
      providerError.param,
      providerError.code,
      providerError.type
    ].filter(Boolean).join(' ').toLowerCase();
    return message.includes('response_format') ||
      message.includes('json_schema') ||
      (message.includes('schema') && (
        message.includes('unsupported') ||
        message.includes('not support') ||
        message.includes('unknown')
      ));
  }

  async function parsePayload(response) {
    const text = await response.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function createClient(options) {
    options = options || {};
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 45000;
    const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
      ? options.maxAttempts
      : 3;
    const wait = options.sleepImpl || (ms => new Promise(resolve => setTimeout(resolve, ms)));

    if (!fetchImpl) throw new Error('当前环境不支持 fetch');

    async function request(body, apiKey) {
      let lastError = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

        try {
          const response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });
          const payload = await parsePayload(response);

          if (response.ok) return extractContent(payload);

          if (body.response_format && rejectsJsonSchema(response.status, payload)) {
            throw new MuskAPIError('MuskAI 中转站不支持 JSON Schema，正在兼容回退', {
              code: 'json_schema_unsupported',
              status: response.status
            });
          }

          const mapped = errorFromStatus(response.status, payload);
          if ((response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts) {
            lastError = mapped;
            await wait(Math.min(1500, 300 * Math.pow(2, attempt)));
            continue;
          }
          throw mapped;
        } catch (error) {
          if (error instanceof MuskAPIError) throw error;

          const mapped = timedOut
            ? new MuskAPIError('MuskAI 请求超时，请检查网络后重试', { code: 'timeout' })
            : new MuskAPIError('无法连接 MuskAI，请检查网络后重试', { code: 'network_error' });
          if (attempt + 1 < maxAttempts) {
            lastError = mapped;
            await wait(Math.min(1500, 300 * Math.pow(2, attempt)));
            continue;
          }
          throw mapped;
        } finally {
          clearTimeout(timer);
        }
      }

      throw lastError || new MuskAPIError('MuskAI 请求失败', { code: 'request_failed' });
    }

    async function chat(params) {
      params = params || {};
      const apiKey = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
      if (!apiKey) {
        throw new MuskAPIError('未配置 MuskAI API Key', { code: 'missing_api_key' });
      }

      const body = {
        model: normalizeModel(params.model),
        messages: Array.isArray(params.messages) ? params.messages : [],
        reasoning_effort: 'low',
        max_completion_tokens: params.maxCompletionTokens || 500,
        store: false
      };
      if (params.responseFormat) body.response_format = params.responseFormat;

      try {
        return await request(body, apiKey);
      } catch (error) {
        if (error && error.code === 'json_schema_unsupported' && body.response_format) {
          const fallbackBody = Object.assign({}, body);
          delete fallbackBody.response_format;
          return request(fallbackBody, apiKey);
        }
        throw error;
      }
    }

    return Object.freeze({ chat: chat });
  }

  return Object.freeze({
    ENDPOINT: ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    ALLOWED_MODELS: ALLOWED_MODELS,
    MuskAPIError: MuskAPIError,
    normalizeModel: normalizeModel,
    extractContent: extractContent,
    extractJsonObject: extractJsonObject,
    createClient: createClient
  });
});
