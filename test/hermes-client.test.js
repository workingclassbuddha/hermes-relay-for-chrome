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
