import {
  DEFAULT_CONFIG,
  HEALTH_TIMEOUT_MS,
  LOCAL_HERMES_BASE_URLS,
  RESPONSE_TIMEOUT_MS,
} from '../shared/constants.js';
import { normalizeBaseUrl } from '../shared/utils.js';

function uniqueBaseUrls(urls = []) {
  return [...new Set(
    urls
      .map((url) => normalizeBaseUrl(url))
      .filter(Boolean),
  )];
}

export function extractOutputText(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const chunks = [];

  for (const item of output) {
    if (item?.type !== 'message') {
      continue;
    }

    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === 'output_text' && block.text) {
        chunks.push(block.text);
      }
    }
  }

  if (chunks.length) {
    return chunks.join('\n\n').trim();
  }

  return payload?.output_text || payload?.content || '';
}

export function createHermesClient({
  fetchImpl = globalThis.fetch,
} = {}) {
  function authHeaders(config, extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetchImpl(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Hermes did not respond within ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeHealth(config = DEFAULT_CONFIG, baseUrl = DEFAULT_CONFIG.baseUrl) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    try {
      const response = await fetchWithTimeout(`${normalizedBaseUrl}/health`, {
        method: 'GET',
        headers: authHeaders(config),
      }, HEALTH_TIMEOUT_MS);

      if (response.ok) {
        const data = await response.json().catch(() => ({ status: 'ok' }));
        return {
          ok: true,
          reachable: true,
          status: data.status || 'ok',
          baseUrl: normalizedBaseUrl,
          message: `Hermes is ready at ${normalizedBaseUrl}.`,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reachable: true,
          authRequired: true,
          needsApiKey: true,
          status: response.status,
          baseUrl: normalizedBaseUrl,
          message: 'Hermes is running locally, but the API key is missing or was rejected.',
        };
      }

      return {
        ok: false,
        reachable: true,
        status: response.status,
        baseUrl: normalizedBaseUrl,
        message: `Hermes responded at ${normalizedBaseUrl} with HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        ok: false,
        reachable: false,
        status: 'offline',
        message: error.message || 'Unable to reach Hermes',
        baseUrl: normalizedBaseUrl,
      };
    }
  }

  async function checkHealth(config = DEFAULT_CONFIG) {
    const configuredBaseUrl = normalizeBaseUrl(config.baseUrl);
    const candidates = uniqueBaseUrls([configuredBaseUrl, ...LOCAL_HERMES_BASE_URLS]);
    const results = [];

    for (const candidate of candidates) {
      const result = await probeHealth(config, candidate);
      results.push(result);

      if (result.ok || result.authRequired) {
        return {
          ...result,
          configuredBaseUrl,
          detectedBaseUrl: result.baseUrl,
          suggestedBaseUrl: result.baseUrl !== configuredBaseUrl ? result.baseUrl : '',
          probedBaseUrls: candidates,
        };
      }
    }

    const fallback = results.find((item) => item.reachable) || results[0] || {
      ok: false,
      reachable: false,
      status: 'offline',
      baseUrl: configuredBaseUrl,
      message: 'Unable to reach Hermes',
    };

    return {
      ...fallback,
      configuredBaseUrl,
      detectedBaseUrl: fallback.reachable ? fallback.baseUrl : '',
      suggestedBaseUrl: fallback.reachable && fallback.baseUrl !== configuredBaseUrl
        ? fallback.baseUrl
        : '',
      probedBaseUrls: candidates,
    };
  }

  async function callResponse(config, { prompt, instructions, conversation }) {
    const response = await fetchWithTimeout(`${normalizeBaseUrl(config.baseUrl)}/v1/responses`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model: config.model,
        input: prompt,
        instructions,
        conversation,
        store: true,
      }),
    }, RESPONSE_TIMEOUT_MS);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Hermes API ${response.status}: ${body.slice(0, 200)}`);
    }

    const payload = await response.json();
    return {
      raw: payload,
      text: extractOutputText(payload),
    };
  }

  return {
    authHeaders,
    checkHealth,
    callResponse,
    fetchWithTimeout,
    probeHealth,
  };
}
