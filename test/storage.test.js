import assert from 'node:assert/strict';
import test from 'node:test';

import { STORAGE_SCHEMA_VERSION } from '../extension/lib/shared/constants.js';
import { createStorageApi, migrateStorageRecord } from '../extension/lib/background/storage.js';

function createMemoryStorage(initial = {}) {
  const data = { ...initial };

  return {
    async get(keys) {
      if (keys === null) {
        return { ...data };
      }

      if (Array.isArray(keys)) {
        return keys.reduce((acc, key) => {
          acc[key] = data[key];
          return acc;
        }, {});
      }

      if (typeof keys === 'string') {
        return { [keys]: data[keys] };
      }

      return Object.entries(keys || {}).reduce((acc, [key, fallback]) => {
        acc[key] = key in data ? data[key] : fallback;
        return acc;
      }, {});
    },

    async set(patch) {
      Object.assign(data, patch);
    },

    dump() {
      return { ...data };
    },
  };
}

test('migrateStorageRecord normalizes legacy keys and urls', () => {
  const migrated = migrateStorageRecord({
    baseUrl: 'http://localhost:8642///',
    conversationPrefix: '  relay  ',
    workspaceState: { prompt: 'hello' },
    pageNotes: {
      'https://example.com/path#section': 'remember this',
    },
    trackedPages: [
      {
        id: 'tracked-1',
        url: 'https://example.com/path#one',
        pinned: true,
        title: 'Example',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ],
    pageSnapshots: [
      {
        id: 'snap-1',
        url: 'https://example.com/path#later',
        timestamp: '2026-04-20T02:00:00.000Z',
        headings: null,
      },
    ],
  }, {
    now: () => '2026-04-21T00:00:00.000Z',
    uuid: () => 'uuid-1',
  });

  assert.equal(migrated.storageSchemaVersion, STORAGE_SCHEMA_VERSION);
  assert.equal(migrated.baseUrl, 'http://localhost:8642');
  assert.equal(migrated.conversationPrefix, 'relay');
  assert.equal(migrated.workspaceStateGlobal.prompt, 'hello');
  assert.deepEqual(migrated.pageNotes['https://example.com/path'], {
    text: 'remember this',
    updatedAt: '2026-04-21T00:00:00.000Z',
  });
  assert.equal(migrated.trackedPages[0].url, 'https://example.com/path');
  assert.equal(migrated.pageSnapshots[0].url, 'https://example.com/path');
});

test('createStorageApi ensures schema and normalizes config updates', async () => {
  const storage = createMemoryStorage({
    pageNotes: {
      'https://example.com/a#frag': 'legacy note',
    },
  });
  const api = createStorageApi({
    storage,
    now: () => '2026-04-21T00:00:00.000Z',
  });

  const migration = await api.ensureStorageSchema();
  assert.equal(migration.migrated, true);

  await api.setConfig({
    baseUrl: 'http://127.0.0.1:8642///',
    conversationPrefix: '  hermes-relay  ',
    customAssistantHosts: ['Poe.com', 'poe.com', ' beta.example.ai '],
  });

  const config = await api.getConfig();
  assert.equal(config.baseUrl, 'http://127.0.0.1:8642');
  assert.equal(config.conversationPrefix, 'hermes-relay');
  assert.deepEqual(config.customAssistantHosts, ['poe.com', 'beta.example.ai']);

  const data = storage.dump();
  assert.equal(data.storageSchemaVersion, STORAGE_SCHEMA_VERSION);
  assert.equal(data.pageNotes['https://example.com/a'].text, 'legacy note');
});

test('createStorageApi stores live events in sequence order without duplicates', async () => {
  const storage = createMemoryStorage();
  const api = createStorageApi({ storage });

  await api.pushLiveEvents([
    { id: 'evt-2', sequence: 2, session_id: 'sess', type: 'assistant.final', payload: { text: 'done' } },
    { id: 'evt-1', sequence: 1, session_id: 'sess', type: 'browser.context', payload: { page: {} } },
    { id: 'evt-2', sequence: 2, session_id: 'sess', type: 'assistant.final', payload: { text: 'done again' } },
  ]);

  const events = await api.getLiveEvents('sess');

  assert.deepEqual(events.map((event) => event.id), ['evt-1', 'evt-2']);
  assert.equal(events[1].payload.text, 'done again');
});
