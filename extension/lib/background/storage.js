import {
  DEFAULT_CONFIG,
  DEFAULT_WORKSPACE_STATE,
  DEFAULT_WORKSPACE_STORE,
  STORAGE_SCHEMA_VERSION,
} from '../shared/constants.js';
import {
  canonicalizeUrl,
  normalizeBaseUrl,
  normalizeAssistantHosts,
  parseIsoTime,
  summarizeNote,
} from '../shared/utils.js';

function normalizeWorkspaceState(state = {}) {
  return {
    ...DEFAULT_WORKSPACE_STATE,
    ...(state || {}),
  };
}

function normalizeWorkspaceStateByPage(items = {}) {
  const next = {};

  for (const [url, state] of Object.entries(items || {})) {
    const key = canonicalizeUrl(url);
    if (!key) {
      continue;
    }
    next[key] = normalizeWorkspaceState(state);
  }

  return next;
}

function normalizePageNotes(notes = {}, timestamp = '') {
  const next = {};

  for (const [url, value] of Object.entries(notes || {})) {
    const key = canonicalizeUrl(url);
    if (!key) {
      continue;
    }

    if (typeof value === 'string') {
      next[key] = {
        text: value,
        updatedAt: timestamp,
      };
      continue;
    }

    next[key] = {
      text: String(value?.text || ''),
      updatedAt: value?.updatedAt || timestamp,
    };
  }

  return next;
}

export function sortTrackedPages(items) {
  return [...items].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) {
      return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    }
    return parseIsoTime(right.lastSeenAt || right.createdAt) - parseIsoTime(left.lastSeenAt || left.createdAt);
  });
}

function normalizeTrackedPages(items = [], timestamp = '') {
  const byUrl = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const url = canonicalizeUrl(item?.url || '');
    if (!url) {
      continue;
    }

    const nextItem = {
      id: item?.id || url,
      url,
      title: item?.title || 'Tracked page',
      hostname: item?.hostname || '',
      pageType: item?.pageType || 'page',
      pinned: Boolean(item?.pinned),
      lastSeenAt: item?.lastSeenAt || item?.createdAt || timestamp,
      lastSnapshotAt: item?.lastSnapshotAt || '',
      createdAt: item?.createdAt || item?.lastSeenAt || timestamp,
    };

    const prior = byUrl.get(url);
    if (!prior || parseIsoTime(nextItem.lastSeenAt || nextItem.createdAt) >= parseIsoTime(prior.lastSeenAt || prior.createdAt)) {
      byUrl.set(url, nextItem);
    }
  }

  return sortTrackedPages([...byUrl.values()]);
}

function normalizeSnapshots(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.url)
    .map((item) => ({
      ...item,
      url: canonicalizeUrl(item.url),
      headings: Array.isArray(item.headings) ? item.headings : [],
    }))
    .filter((item) => item.url)
    .sort((left, right) => parseIsoTime(right.timestamp) - parseIsoTime(left.timestamp));
}

function normalizeMessages(messages = [], timestamp = '') {
  return (Array.isArray(messages) ? messages : [])
    .filter(Boolean)
    .slice(-24)
    .map((message) => ({
      id: message.id || '',
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: String(message.text || ''),
      timestamp: message.timestamp || timestamp,
      source: message.source || '',
      selection: message.selection || '',
    }));
}

function normalizeDirectThreads(threads = {}, timestamp = '') {
  const next = {};

  for (const [key, thread] of Object.entries(threads || {})) {
    next[key] = {
      threadKey: thread?.threadKey || key,
      conversation: thread?.conversation || '',
      title: thread?.title || 'Current page',
      url: canonicalizeUrl(thread?.url || ''),
      updatedAt: thread?.updatedAt || timestamp,
      messages: normalizeMessages(thread?.messages, timestamp),
    };
  }

  return next;
}

function normalizeRecentActions(items = [], timestamp = '', uuid = () => crypto.randomUUID()) {
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((item) => ({
      ...item,
      id: item.id || uuid(),
      timestamp: item.timestamp || timestamp,
      summary: item.summary || '',
      output: item.output || '',
    }))
    .slice(0, 12);
}

export function makePageDigest(page) {
  return JSON.stringify({
    title: page?.title || '',
    description: page?.description || '',
    headings: page?.headings || [],
    selection: page?.selection || '',
    text: (page?.text || '').slice(0, 6000),
  });
}

export function migrateStorageRecord(data = {}, {
  now = () => new Date().toISOString(),
  uuid = () => crypto.randomUUID(),
} = {}) {
  const timestamp = typeof now === 'function' ? now() : now;
  const globalWorkspaceState = normalizeWorkspaceState(
    data.workspaceStateGlobal || data.workspaceState || DEFAULT_WORKSPACE_STORE.global,
  );

  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    baseUrl: normalizeBaseUrl(String(data.baseUrl || DEFAULT_CONFIG.baseUrl).trim()),
    apiKey: String(data.apiKey || ''),
    model: String(data.model || DEFAULT_CONFIG.model),
    conversationPrefix: String(data.conversationPrefix || DEFAULT_CONFIG.conversationPrefix).trim()
      || DEFAULT_CONFIG.conversationPrefix,
    preferredTarget: String(data.preferredTarget || DEFAULT_CONFIG.preferredTarget),
    customAssistantHosts: normalizeAssistantHosts(data.customAssistantHosts || DEFAULT_CONFIG.customAssistantHosts),
    workspaceState: globalWorkspaceState,
    workspaceStateGlobal: globalWorkspaceState,
    workspaceStateByPage: normalizeWorkspaceStateByPage(data.workspaceStateByPage || {}),
    directThreads: normalizeDirectThreads(data.directThreads || {}, timestamp),
    recentActions: normalizeRecentActions(data.recentActions || [], timestamp, uuid),
    pageNotes: normalizePageNotes(data.pageNotes || {}, timestamp),
    trackedPages: normalizeTrackedPages(data.trackedPages || [], timestamp),
    pageSnapshots: normalizeSnapshots(data.pageSnapshots || []),
  };
}

export function createStorageApi({
  storage = globalThis.chrome?.storage?.local,
  now = () => new Date().toISOString(),
  uuid = () => crypto.randomUUID(),
} = {}) {
  async function ensureStorageSchema() {
    const current = await storage.get(null);
    const version = Number(current.storageSchemaVersion || 0);
    if (version >= STORAGE_SCHEMA_VERSION) {
      return {
        version,
        migrated: false,
      };
    }

    await storage.set(migrateStorageRecord(current, { now, uuid }));
    return {
      version: STORAGE_SCHEMA_VERSION,
      migrated: true,
    };
  }

  async function getConfig() {
    const data = await storage.get(DEFAULT_CONFIG);
    return {
      ...DEFAULT_CONFIG,
      ...data,
      baseUrl: normalizeBaseUrl(String(data.baseUrl || DEFAULT_CONFIG.baseUrl).trim()),
      conversationPrefix: String(data.conversationPrefix || DEFAULT_CONFIG.conversationPrefix).trim()
        || DEFAULT_CONFIG.conversationPrefix,
      customAssistantHosts: normalizeAssistantHosts(data.customAssistantHosts || DEFAULT_CONFIG.customAssistantHosts),
    };
  }

  async function setConfig(patch = {}) {
    const nextPatch = {
      ...patch,
    };

    if ('baseUrl' in nextPatch) {
      nextPatch.baseUrl = normalizeBaseUrl(String(nextPatch.baseUrl || DEFAULT_CONFIG.baseUrl).trim());
    }
    if ('conversationPrefix' in nextPatch) {
      nextPatch.conversationPrefix = String(nextPatch.conversationPrefix || DEFAULT_CONFIG.conversationPrefix).trim()
        || DEFAULT_CONFIG.conversationPrefix;
    }
    if ('customAssistantHosts' in nextPatch) {
      nextPatch.customAssistantHosts = normalizeAssistantHosts(nextPatch.customAssistantHosts);
    }

    await storage.set(nextPatch);
    return getConfig();
  }

  async function getDirectThreads() {
    const data = await storage.get({ directThreads: {} });
    return data.directThreads;
  }

  async function saveDirectThreads(threads) {
    await storage.set({ directThreads: threads });
  }

  async function saveDirectThread(threadKey, thread) {
    const threads = await getDirectThreads();
    threads[threadKey] = thread;
    await saveDirectThreads(threads);
    return thread;
  }

  async function getWorkspaceStateStore() {
    const data = await storage.get({
      workspaceState: DEFAULT_WORKSPACE_STATE,
      workspaceStateGlobal: DEFAULT_WORKSPACE_STORE.global,
      workspaceStateByPage: DEFAULT_WORKSPACE_STORE.byPage,
    });

    return {
      global: normalizeWorkspaceState(data.workspaceStateGlobal || data.workspaceState || {}),
      byPage: normalizeWorkspaceStateByPage(data.workspaceStateByPage || {}),
    };
  }

  async function saveWorkspaceStateStore(store) {
    await storage.set({
      workspaceState: store.global,
      workspaceStateGlobal: store.global,
      workspaceStateByPage: store.byPage,
    });
  }

  async function getWorkspaceStateByKey(key = '') {
    const store = await getWorkspaceStateStore();
    if (!key) {
      return store.global;
    }

    return normalizeWorkspaceState(store.byPage[key] || {});
  }

  async function setWorkspaceStateByKey(key = '', patch = {}) {
    const store = await getWorkspaceStateStore();
    const next = {
      ...normalizeWorkspaceState(key ? store.byPage[key] : store.global),
      ...patch,
      updatedAt: now(),
    };

    if (key) {
      store.byPage[key] = next;
    } else {
      store.global = next;
    }

    await saveWorkspaceStateStore(store);
    return next;
  }

  async function pushRecent(entry) {
    const data = await storage.get({ recentActions: [] });
    const next = [
      {
        id: uuid(),
        timestamp: now(),
        ...entry,
      },
      ...data.recentActions,
    ].slice(0, 12);

    await storage.set({ recentActions: next });
    return next;
  }

  async function getRecentActions() {
    const data = await storage.get({ recentActions: [] });
    return data.recentActions;
  }

  async function getRecentAction(id) {
    const items = await getRecentActions();
    return items.find((item) => item.id === id) || null;
  }

  async function getPageNotes() {
    const data = await storage.get({ pageNotes: {} });
    return data.pageNotes;
  }

  async function getPageNote(url) {
    const notes = await getPageNotes();
    const key = canonicalizeUrl(url);
    return notes[key] || '';
  }

  async function savePageNote(url, note) {
    if (!url) {
      throw new Error('No page URL available for notes.');
    }

    const notes = await getPageNotes();
    const key = canonicalizeUrl(url);
    notes[key] = {
      text: note,
      updatedAt: now(),
    };
    await storage.set({ pageNotes: notes });
    return notes[key];
  }

  async function getTrackedPages() {
    const data = await storage.get({ trackedPages: [] });
    return data.trackedPages;
  }

  async function upsertTrackedPage(page, pin = true) {
    if (!page?.url) {
      throw new Error('No page URL available to track.');
    }

    const normalizedUrl = canonicalizeUrl(page.url);
    const items = await getTrackedPages();
    const existing = items.find((item) => canonicalizeUrl(item.url) === normalizedUrl);
    const timestamp = now();
    const nextItem = {
      id: existing?.id || uuid(),
      url: normalizedUrl,
      title: page.title || existing?.title || 'Tracked page',
      hostname: page.hostname || existing?.hostname || '',
      pageType: page.pageType || existing?.pageType || 'page',
      pinned: pin ?? existing?.pinned ?? true,
      lastSeenAt: timestamp,
      lastSnapshotAt: existing?.lastSnapshotAt || '',
      createdAt: existing?.createdAt || timestamp,
    };

    const next = [nextItem, ...items.filter((item) => canonicalizeUrl(item.url) !== normalizedUrl)].slice(0, 30);
    await storage.set({ trackedPages: sortTrackedPages(next) });
    return nextItem;
  }

  async function updateTrackedPage(url, patch = {}) {
    if (!url) {
      throw new Error('No page URL available to update.');
    }

    const normalizedUrl = canonicalizeUrl(url);
    const items = await getTrackedPages();
    let updated = null;
    const next = items.map((item) => {
      if (canonicalizeUrl(item.url) !== normalizedUrl) {
        return item;
      }

      updated = {
        ...item,
        ...patch,
        lastSeenAt: patch.lastSeenAt || item.lastSeenAt || now(),
      };
      return updated;
    });

    if (!updated) {
      throw new Error('Tracked page not found.');
    }

    await storage.set({ trackedPages: sortTrackedPages(next) });
    return updated;
  }

  async function removeTrackedPage(url) {
    const normalizedUrl = canonicalizeUrl(url);
    const items = await getTrackedPages();
    const next = items.filter((item) => canonicalizeUrl(item.url) !== normalizedUrl);
    await storage.set({ trackedPages: next });
    return { removed: items.length !== next.length };
  }

  async function getSnapshots() {
    const data = await storage.get({ pageSnapshots: [] });
    return data.pageSnapshots;
  }

  async function getSnapshotsForUrl(url) {
    const items = await getSnapshots();
    const normalizedUrl = canonicalizeUrl(url);
    return items.filter((item) => canonicalizeUrl(item.url) === normalizedUrl);
  }

  async function saveSnapshot(page, source = 'workspace') {
    if (!page?.url) {
      throw new Error('No page URL available for snapshot.');
    }

    const normalizedUrl = canonicalizeUrl(page.url);
    const existing = await getSnapshots();
    const digest = makePageDigest(page);
    const sameUrl = existing.filter((item) => canonicalizeUrl(item.url) === normalizedUrl);
    const latest = sameUrl[0];

    if (latest?.digest === digest) {
      return {
        snapshot: latest,
        unchanged: true,
      };
    }

    const snapshot = {
      id: uuid(),
      timestamp: now(),
      title: page.title || 'Current page',
      url: normalizedUrl,
      hostname: page.hostname || '',
      description: page.description || '',
      headings: page.headings || [],
      pageType: page.pageType || 'page',
      text: (page.text || '').slice(0, 8000),
      digest,
      source,
    };

    const next = [snapshot, ...existing].slice(0, 40);
    await storage.set({ pageSnapshots: next });

    try {
      const tracked = await getTrackedPages();
      const updatedTracked = tracked.map((item) => (
        canonicalizeUrl(item.url) === normalizedUrl
          ? { ...item, lastSnapshotAt: snapshot.timestamp, title: page.title || item.title }
          : item
      ));
      await storage.set({ trackedPages: updatedTracked });
    } catch (_) {
      // If tracked-page metadata update fails, keep the snapshot.
    }

    return {
      snapshot,
      unchanged: false,
    };
  }

  async function getTrackedPageViews() {
    const [items, notes, snapshots] = await Promise.all([
      getTrackedPages(),
      getPageNotes(),
      getSnapshots(),
    ]);

    const snapshotCountByUrl = snapshots.reduce((acc, item) => {
      if (item?.url) {
        acc[item.url] = (acc[item.url] || 0) + 1;
      }
      return acc;
    }, {});

    return sortTrackedPages(items).map((item) => {
      const note = notes[item.url];
      return {
        ...item,
        hasNote: Boolean(note?.text),
        notePreview: summarizeNote(note?.text || ''),
        snapshotCount: snapshotCountByUrl[item.url] || 0,
      };
    });
  }

  return {
    ensureStorageSchema,
    getConfig,
    setConfig,
    getDirectThreads,
    saveDirectThreads,
    saveDirectThread,
    getWorkspaceStateStore,
    saveWorkspaceStateStore,
    getWorkspaceStateByKey,
    setWorkspaceStateByKey,
    pushRecent,
    getRecentActions,
    getRecentAction,
    getPageNotes,
    getPageNote,
    savePageNote,
    getTrackedPages,
    upsertTrackedPage,
    updateTrackedPage,
    removeTrackedPage,
    getTrackedPageViews,
    getSnapshots,
    getSnapshotsForUrl,
    saveSnapshot,
  };
}
