import assert from 'node:assert/strict';
import test from 'node:test';

import { createHermesClient, extractOutputText } from '../extension/lib/background/hermes-client.js';

test('extractOutputText flattens response message blocks', () => {
  const text = extractOutputText({
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'First block' },
          { type: 'output_text', text: 'Second block' },
        ],
      },
    ],
  });

  assert.equal(text, 'First block\n\nSecond block');
});

test('checkHealth reports offline when fetch fails', async () => {
  const client = createHermesClient({
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });

  const status = await client.checkHealth({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'local-key',
  });

  assert.equal(status.ok, false);
  assert.equal(status.reachable, false);
  assert.match(status.message, /ECONNREFUSED/);
});

test('checkHealth falls back to localhost when the default loopback host is offline', async () => {
  const client = createHermesClient({
    fetchImpl: async (url) => {
      if (String(url).startsWith('http://127.0.0.1:8642')) {
        throw new Error('connect ECONNREFUSED');
      }

      return {
        ok: true,
        async json() {
          return { status: 'ok' };
        },
      };
    },
  });

  const status = await client.checkHealth({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: '',
  });

  assert.equal(status.ok, true);
  assert.equal(status.baseUrl, 'http://localhost:8642');
  assert.equal(status.suggestedBaseUrl, 'http://localhost:8642');
});

test('checkHealth reports authRequired when Hermes rejects the current key', async () => {
  const client = createHermesClient({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
    }),
  });

  const status = await client.checkHealth({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'wrong-key',
  });

  assert.equal(status.ok, false);
  assert.equal(status.authRequired, true);
  assert.equal(status.reachable, true);
});

test('preflightAccess verifies auth via /v1/models when available', async () => {
  const seenUrls = [];
  const client = createHermesClient({
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return {
        ok: true,
      };
    },
  });

  const status = await client.preflightAccess({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'local-key',
    model: 'hermes-agent',
  });

  assert.equal(status.ok, true);
  assert.equal(status.via, 'models');
  assert.deepEqual(seenUrls, ['http://127.0.0.1:8642/v1/models']);
});

test('preflightAccess falls back to /v1/responses when /v1/models is unavailable', async () => {
  const seenUrls = [];
  const client = createHermesClient({
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      if (String(url).endsWith('/v1/models')) {
        return {
          ok: false,
          status: 404,
        };
      }

      return {
        ok: true,
        async text() {
          return '{"output_text":"ok"}';
        },
      };
    },
  });

  const status = await client.preflightAccess({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'local-key',
    model: 'hermes-agent',
  });

  assert.equal(status.ok, true);
  assert.equal(status.via, 'responses');
  assert.deepEqual(seenUrls, [
    'http://127.0.0.1:8642/v1/models',
    'http://127.0.0.1:8642/v1/responses',
  ]);
});

test('getCurrentLiveSession returns attached session metadata when available', async () => {
  const client = createHermesClient({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          session: {
            session_id: 'sess_live',
            session_title: 'Live Session',
          },
        };
      },
    }),
  });

  const status = await client.getCurrentLiveSession({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'local-key',
  });

  assert.equal(status.ok, true);
  assert.equal(status.session.session_id, 'sess_live');
});

test('sendLiveCommand returns live session response text', async () => {
  const seen = [];
  const client = createHermesClient({
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            result: {
              text: 'Live shared-session reply',
              session_id: 'sess_live',
            },
          };
        },
      };
    },
  });

  const result = await client.sendLiveCommand({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'local-key',
  }, {
    sessionId: 'sess_live',
    type: 'workflow.run',
    prompt: 'Summarize this page',
    metadata: { mode: 'summarize' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Live shared-session reply');
  assert.match(seen[0].url, /\/v1\/live-sessions\/sess_live\/commands$/);
});

test('callResponse returns parsed output text', async () => {
  const client = createHermesClient({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hermes says hi' },
              ],
            },
          ],
        };
      },
    }),
  });

  const response = await client.callResponse({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'local-key',
    model: 'hermes-agent',
  }, {
    prompt: 'hello',
    instructions: 'be helpful',
    conversation: 'relay-test',
  });

  assert.equal(response.text, 'Hermes says hi');
});

test('callResponse surfaces a setup hint for invalid API keys', async () => {
  const client = createHermesClient({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({
          error: {
            message: 'Invalid API key',
            code: 'invalid_api_key',
          },
        });
      },
    }),
  });

  await assert.rejects(
    () => client.callResponse({
      baseUrl: 'http://127.0.0.1:8642',
      apiKey: 'wrong-key',
      model: 'hermes-agent',
    }, {
      prompt: 'hello',
      instructions: 'be helpful',
      conversation: 'relay-test',
    }),
    /Run npm run setup:local and reload the unpacked extension/,
  );
});
