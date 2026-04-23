import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrowserContextEnvelope,
  buildDirectThreadMeta,
  createRelayOperations,
} from '../extension/lib/background/workflows.js';

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

test('runWorkflow routes through an attached live session when available', async () => {
  const pushed = [];
  const browserEvents = [];
  const operations = createRelayOperations({
    storageApi: {
      async pushRecent(item) {
        pushed.push(item);
      },
    },
    getConfig: async () => ({
      baseUrl: 'http://127.0.0.1:8642',
      apiKey: 'local-key',
      conversationPrefix: 'relay',
    }),
    pageContextApi: {
      async getActiveTab() {
        return {
          id: 3,
          title: 'Example',
          url: 'https://example.com/article',
        };
      },
      async extractPageContext() {
        return {
          title: 'Example Article',
          url: 'https://example.com/article',
          hostname: 'example.com',
          pageType: 'article',
          text: 'Important page text.',
          description: 'An example article.',
          headings: ['Heading'],
          selection: 'Critical selected line.',
        };
      },
      isRestrictedBrowserUrl() {
        return false;
      },
    },
    hermesClient: {
      async getCurrentLiveSession() {
        return {
          ok: true,
          session: {
            session_id: 'sess_live',
            session_title: 'Live Session',
          },
        };
      },
      async sendLiveCommand(_config, payload) {
        assert.equal(payload.sessionId, 'sess_live');
        assert.equal(payload.type, 'workflow.run');
        assert.match(payload.prompt, /Browser command: Summarize/);
        assert.match(payload.prompt, /Scope: Selection first/);
        assert.deepEqual(payload.metadata.provenance, [
          'page title',
          'URL',
          'selected text',
          'description',
          'visible headings',
          'article body',
        ]);
        return {
          ok: true,
          text: 'Live summary',
          sessionId: 'sess_live',
          raw: { ok: true },
        };
      },
      async postLiveBrowserEvent(_config, payload) {
        browserEvents.push(payload);
        return { ok: true, event: { type: payload.type } };
      },
      async callResponse() {
        throw new Error('should not use direct API path when live session exists');
      },
    },
    browser: {
      tabs: {},
      sidePanel: {},
    },
  });

  const result = await operations.runWorkflow({
    mode: 'summarize',
    prompt: 'Summarize this page',
    target: 'generic',
  });

  assert.equal(result.text, 'Live summary');
  assert.equal(result.source, 'live-session');
  assert.equal(pushed[0].source, 'live-session');
  assert.equal(result.meta.scopeLabel, 'Selection first');
  assert.equal(pushed[0].provenanceText, 'Used page title + URL + selected text + description + visible headings + article body');
  assert.equal(browserEvents[0].type, 'browser.context');
  assert.equal(browserEvents[0].payload.page.selection, 'Critical selected line.');
});

test('buildBrowserContextEnvelope prioritizes selected text and captures provenance', () => {
  const envelope = buildBrowserContextEnvelope({
    title: 'Example',
    url: 'https://example.com/article',
    hostname: 'example.com',
    pageType: 'article',
    selection: 'Selected text',
    description: 'Description',
    headings: ['Heading A', 'Heading B'],
    text: 'Body text',
  }, {
    mode: 'extract-facts',
    userPrompt: 'Find the key facts.',
    target: 'generic',
    timestamp: '2026-04-22T00:00:00.000Z',
  });

  assert.equal(envelope.scope, 'selection');
  assert.equal(envelope.scopeLabel, 'Selection first');
  assert.deepEqual(envelope.provenance, [
    'page title',
    'URL',
    'selected text',
    'description',
    'visible headings',
    'article body',
  ]);
  assert.match(envelope.prompt, /Content priority: selected text, then readable page body, then page metadata/);
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
