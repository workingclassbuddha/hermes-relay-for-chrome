import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDirectThreadMeta, createRelayOperations } from '../extension/lib/background/workflows.js';

test('buildDirectThreadMeta canonicalizes page urls for thread identity', () => {
  const meta = buildDirectThreadMeta(
    { conversationPrefix: 'relay' },
    { url: 'https://example.com/path#frag', title: 'Example' },
    { id: 12 },
  );

  assert.equal(meta.url, 'https://example.com/path');
  assert.match(meta.threadKey, /^direct-/);
  assert.equal(meta.conversation.startsWith('relay-direct-'), true);
});

test('insertLatestContext requires a previously built context bundle', async () => {
  const operations = createRelayOperations({
    storageApi: {
      async getRecentActions() {
        return [];
      },
    },
    pageContextApi: {
      async getActiveTab() {
        return {
          id: 1,
          url: 'https://chatgpt.com/',
        };
      },
      isRestrictedBrowserUrl() {
        return false;
      },
    },
    hermesClient: {},
    browser: {
      tabs: {
        async sendMessage() {
          return { ok: true };
        },
      },
      sidePanel: {},
    },
  });

  await assert.rejects(() => operations.insertLatestContext(), /Build context from a page first/);
});

test('insertLatestContext forwards the saved bundle into the active chat tab', async () => {
  const sentMessages = [];
  let injectedTabId = null;
  const operations = createRelayOperations({
    storageApi: {
      async getRecentActions() {
        return [
          {
            type: 'build-context',
            output: 'Saved handoff bundle',
            title: 'Example page',
            timestamp: '2026-04-21T01:00:00.000Z',
          },
        ];
      },
      async pushRecent() {
        return [];
      },
    },
    pageContextApi: {
      async ensureChatBridge(tabId) {
        injectedTabId = tabId;
      },
      async getActiveTab() {
        return {
          id: 9,
          title: 'ChatGPT',
          url: 'https://chatgpt.com/',
        };
      },
      isRestrictedBrowserUrl() {
        return false;
      },
    },
    hermesClient: {},
    browser: {
      tabs: {
        async sendMessage(tabId, payload) {
          sentMessages.push({ tabId, payload });
          return { ok: true };
        },
      },
      sidePanel: {},
    },
  });

  const result = await operations.insertLatestContext();

  assert.equal(result.text, 'Saved handoff bundle');
  assert.equal(injectedTabId, 9);
  assert.deepEqual(sentMessages, [
    {
      tabId: 9,
      payload: {
        type: 'INSERT_HERMES_CONTEXT',
        text: 'Saved handoff bundle',
      },
    },
  ]);
});

test('insertLatestContext supports a user-approved custom AI host', async () => {
  const sentMessages = [];
  const operations = createRelayOperations({
    storageApi: {
      async getRecentActions() {
        return [
          {
            type: 'build-context',
            output: 'Saved handoff bundle',
            title: 'Example page',
            timestamp: '2026-04-21T01:00:00.000Z',
          },
        ];
      },
      async pushRecent() {
        return [];
      },
    },
    getConfig: async () => ({
      customAssistantHosts: ['assistant.example.com'],
    }),
    pageContextApi: {
      async ensureChatBridge() {
        return null;
      },
      async getActiveTab() {
        return {
          id: 15,
          title: 'Custom AI',
          url: 'https://assistant.example.com/chat',
        };
      },
      isRestrictedBrowserUrl() {
        return false;
      },
    },
    hermesClient: {},
    browser: {
      tabs: {
        async sendMessage(tabId, payload) {
          sentMessages.push({ tabId, payload });
          return { ok: true };
        },
      },
      sidePanel: {},
    },
  });

  const result = await operations.insertLatestContext();

  assert.equal(result.text, 'Saved handoff bundle');
  assert.equal(sentMessages[0].tabId, 15);
});

test('addCustomAssistantHost saves a new approved hostname', async () => {
  const saved = [];
  const operations = createRelayOperations({
    storageApi: {
      async setConfig(patch) {
        saved.push(patch);
        return patch;
      },
    },
    getConfig: async () => ({
      customAssistantHosts: ['poe.com'],
    }),
    pageContextApi: {},
    hermesClient: {},
    browser: {
      tabs: {},
      sidePanel: {},
    },
  });

  const result = await operations.addCustomAssistantHost('https://assistant.example.com/chat');

  assert.equal(result.hostname, 'assistant.example.com');
  assert.deepEqual(saved, [{
    customAssistantHosts: ['poe.com', 'assistant.example.com'],
  }]);
});
