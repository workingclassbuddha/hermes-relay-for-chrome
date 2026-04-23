import {
  DEFAULT_CONFIG,
  HEALTH_TIMEOUT_MS,
  LOCAL_HERMES_BASE_URLS,
  RESPONSE_TIMEOUT_MS,
} from '../shared/constants.js';
import { normalizeBaseUrl } from '../shared/utils.js';

const AUTH_PREFLIGHT_TIMEOUT_MS = 8000;

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

  function invalidApiKeyResult(baseUrl, via, status) {
    return {
      ok: false,
      ran: true,
      authRequired: true,
      status: 'invalid-api-key',
      httpStatus: status,
      via,
      baseUrl,
      message: 'Hermes rejected the saved API key during authenticated preflight.',
    };
  }

  async function probeModelsAccess(config, baseUrl) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: authHeaders(config),
      }, HEALTH_TIMEOUT_MS);

      if (response.ok) {
        return {
          ok: true,
          ran: true,
          status: 'ok',
          via: 'models',
          baseUrl,
          message: 'Authenticated API access verified via /v1/models.',
        };
      }

      if (response.status === 401 || response.status === 403) {
        return invalidApiKeyResult(baseUrl, 'models', response.status);
      }

      if (response.status === 404 || response.status === 405 || response.status === 501) {
        return {
          ok: false,
          ran: true,
          unsupported: true,
          status: response.status,
          via: 'models',
          baseUrl,
          message: 'Hermes does not expose /v1/models. Falling back to a tiny authenticated response check.',
        };
      }

      return {
        ok: false,
        ran: true,
        status: response.status,
        via: 'models',
        baseUrl,
        message: `Authenticated preflight returned HTTP ${response.status} from /v1/models.`,
      };
    } catch (error) {
      return {
        ok: false,
        ran: true,
        status: 'offline',
        via: 'models',
        baseUrl,
        message: error.message || 'Unable to verify authenticated Hermes access.',
      };
    }
  }

  async function probeResponsesAccess(config, baseUrl, includeStoreFlag = true) {
    const body = {
      model: config.model,
      input: 'ping',
      instructions: 'Reply with ok.',
    };

    if (includeStoreFlag) {
      body.store = false;
    }

    try {
      const response = await fetchWithTimeout(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify(body),
      }, AUTH_PREFLIGHT_TIMEOUT_MS);

      if (response.ok) {
        await response.text().catch(() => '');
        return {
          ok: true,
          ran: true,
          status: 'ok',
          via: 'responses',
          baseUrl,
          message: 'Authenticated API access verified via /v1/responses.',
        };
      }

      if (response.status === 400 && includeStoreFlag) {
        return probeResponsesAccess(config, baseUrl, false);
      }

      if (response.status === 401 || response.status === 403) {
        return invalidApiKeyResult(baseUrl, 'responses', response.status);
      }

      return {
        ok: false,
        ran: true,
        status: response.status,
        via: 'responses',
        baseUrl,
        message: `Authenticated preflight returned HTTP ${response.status} from /v1/responses.`,
      };
    } catch (error) {
      return {
        ok: false,
        ran: true,
        status: 'offline',
        via: 'responses',
        baseUrl,
        message: error.message || 'Unable to verify authenticated Hermes access.',
      };
    }
  }

  async function preflightAccess(config = DEFAULT_CONFIG) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const modelsResult = await probeModelsAccess(config, baseUrl);
    if (modelsResult.ok || modelsResult.authRequired) {
      return modelsResult;
    }

    if (modelsResult.unsupported) {
      return probeResponsesAccess(config, baseUrl, true);
    }

    return modelsResult;
  }

  async function getCurrentLiveSession(config = DEFAULT_CONFIG) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    try {
      const response = await fetchWithTimeout(`${baseUrl}/v1/live-sessions/current`, {
        method: 'GET',
        headers: authHeaders(config),
      }, HEALTH_TIMEOUT_MS);
      if (response.status === 404) {
        return {
          ok: false,
          attached: false,
          status: 'none',
          baseUrl,
          message: 'No live CLI session is currently attached.',
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          attached: false,
          status: response.status,
          baseUrl,
          message: `Live session discovery returned HTTP ${response.status}.`,
        };
      }
      const payload = await response.json();
      return {
        ok: true,
        attached: true,
        status: 'ok',
        baseUrl,
        session: payload?.session || null,
        message: payload?.session?.session_title
          ? `Attached live session available: ${payload.session.session_title}`
          : 'Attached live session available.',
      };
    } catch (error) {
      return {
        ok: false,
        attached: false,
        status: 'offline',
        baseUrl,
        message: error.message || 'Unable to check live session status.',
      };
    }
  }

  async function sendLiveCommand(config = DEFAULT_CONFIG, {
    sessionId,
    type,
    prompt,
    metadata = {},
    timeoutMs = RESPONSE_TIMEOUT_MS,
  } = {}) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const response = await fetchWithTimeout(`${baseUrl}/v1/live-sessions/${encodeURIComponent(String(sessionId || '').trim())}/commands`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        type,
        prompt,
        metadata,
      }),
    }, timeoutMs);

    const payload = await response.json().catch(() => ({}));
    if (response.status === 202) {
      return {
        ok: false,
        queued: true,
        status: 202,
        text: '',
        raw: payload,
      };
    }
    if (!response.ok) {
      throw new Error(payload?.error || `Hermes live session command failed with HTTP ${response.status}.`);
    }

    return {
      ok: true,
      queued: false,
      text: payload?.result?.text || payload?.command?.result?.text || '',
      sessionId: payload?.result?.session_id || sessionId || '',
      raw: payload,
    };
  }

  function buildLiveEventsUrl(config = DEFAULT_CONFIG, {
    sessionId,
    after = 0,
  } = {}) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const url = new URL(`${baseUrl}/v1/live-sessions/${encodeURIComponent(String(sessionId || '').trim())}/events`);
    if (config.apiKey) {
      url.searchParams.set('access_token', config.apiKey);
    }
    if (after) {
      url.searchParams.set('after', String(after));
    }
    return url.toString();
  }

  async function postLiveBrowserEvent(config = DEFAULT_CONFIG, {
    sessionId,
    type = 'browser.context',
    payload = {},
    commandId = '',
    status = 'ok',
    source = 'extension',
  } = {}) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const response = await fetchWithTimeout(`${baseUrl}/v1/live-sessions/${encodeURIComponent(String(sessionId || '').trim())}/browser-events`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        type,
        payload,
        command_id: commandId,
        status,
        source,
      }),
    }, HEALTH_TIMEOUT_MS);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.error || `Hermes browser event failed with HTTP ${response.status}.`);
    }
    return body;
  }

  async function postLiveBrowserResult(config = DEFAULT_CONFIG, {
    sessionId,
    payload = {},
    commandId = '',
    status = 'ok',
    source = 'extension',
  } = {}) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const response = await fetchWithTimeout(`${baseUrl}/v1/live-sessions/${encodeURIComponent(String(sessionId || '').trim())}/browser-results`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        payload,
        command_id: commandId,
        status,
        source,
      }),
    }, HEALTH_TIMEOUT_MS);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.error || `Hermes browser result failed with HTTP ${response.status}.`);
    }
    return body;
  }

  async function resolveLiveApproval(config = DEFAULT_CONFIG, {
    sessionId,
    approvalId,
    decision,
    payload = {},
    source = 'extension',
  } = {}) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const response = await fetchWithTimeout(`${baseUrl}/v1/live-sessions/${encodeURIComponent(String(sessionId || '').trim())}/approvals/${encodeURIComponent(String(approvalId || '').trim())}`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        decision,
        payload,
        source,
      }),
    }, HEALTH_TIMEOUT_MS);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.error || `Hermes approval update failed with HTTP ${response.status}.`);
    }
    return body;
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
      let payload = null;

      try {
        payload = JSON.parse(body);
      } catch (_) {
        payload = null;
      }

      const errorCode = payload?.error?.code || '';
      if (response.status === 401 || errorCode === 'invalid_api_key') {
        throw new Error(
          'Hermes rejected the saved API key. Run npm run setup:local and reload the unpacked extension, or update the key in the popup.',
        );
      }

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
    buildLiveEventsUrl,
    fetchWithTimeout,
    getCurrentLiveSession,
    postLiveBrowserEvent,
    postLiveBrowserResult,
    preflightAccess,
    probeHealth,
    resolveLiveApproval,
    sendLiveCommand,
  };
}
