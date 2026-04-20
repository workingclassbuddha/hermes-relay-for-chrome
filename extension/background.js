'use strict';

const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:8642',
  apiKey: '',
  model: 'hermes-agent',
  conversationPrefix: 'hermes-relay',
  preferredTarget: 'auto',
};

const CONTEXT_MENU_IDS = {
  askSelection: 'hermes-relay-ask-selection',
  rememberSelection: 'hermes-relay-remember-selection',
  sendPage: 'hermes-relay-send-page',
  injectContext: 'hermes-relay-inject-context',
};

const DEFAULT_WORKSPACE_STATE = {
  prompt: '',
  directPrompt: '',
  mode: 'ask',
  target: 'auto',
  output: '',
  lastAction: '',
  pageLock: false,
  lockedPageUrl: '',
  trackedSearch: '',
  trackedPinnedOnly: false,
  source: '',
  updatedAt: '',
};

const DEFAULT_WORKSPACE_STORE = {
  global: { ...DEFAULT_WORKSPACE_STATE },
  byPage: {},
};

async function getDirectThreads() {
  const data = await chrome.storage.local.get({ directThreads: {} });
  return data.directThreads;
}

async function saveDirectThreads(threads) {
  await chrome.storage.local.set({ directThreads: threads });
}

async function getWorkspaceStateStore() {
  const data = await chrome.storage.local.get({
    workspaceState: DEFAULT_WORKSPACE_STATE,
    workspaceStateGlobal: DEFAULT_WORKSPACE_STORE.global,
    workspaceStateByPage: DEFAULT_WORKSPACE_STORE.byPage,
  });

  const global = {
    ...DEFAULT_WORKSPACE_STATE,
    ...(data.workspaceStateGlobal || data.workspaceState || {}),
  };

  return {
    global,
    byPage: data.workspaceStateByPage || {},
  };
}

async function saveWorkspaceStateStore(store) {
  await chrome.storage.local.set({
    workspaceState: store.global,
    workspaceStateGlobal: store.global,
    workspaceStateByPage: store.byPage,
  });
}

async function resolveWorkspaceStateKey({ url = '', useActivePage = false } = {}) {
  if (url) {
    return canonicalizeUrl(url);
  }

  if (!useActivePage) {
    return '';
  }

  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    return canonicalizeUrl(activeTab?.url || '');
  }

  let activePage = null;
  try {
    activePage = await extractPageContext(activeTab.id);
  } catch (_) {
    activePage = null;
  }
  return canonicalizeUrl(activePage?.url || activeTab?.url || '');
}

async function getWorkspaceState(scope = {}) {
  const store = await getWorkspaceStateStore();
  const key = await resolveWorkspaceStateKey(scope);

  if (!key) {
    return store.global;
  }

  return {
    ...DEFAULT_WORKSPACE_STATE,
    ...(store.byPage[key] || {}),
  };
}

async function setWorkspaceState(patch = {}, scope = {}) {
  const store = await getWorkspaceStateStore();
  const key = await resolveWorkspaceStateKey(scope);
  const next = {
    ...DEFAULT_WORKSPACE_STATE,
    ...(key ? store.byPage[key] : store.global),
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  if (key) {
    store.byPage[key] = next;
  } else {
    store.global = next;
  }

  await saveWorkspaceStateStore(store);
  return next;
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return String(url || '').split('#')[0];
  }
}

async function getConfig() {
  const data = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...data,
  };
}

async function setConfig(patch) {
  await chrome.storage.local.set(patch);
  return getConfig();
}

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

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
}

function hashString(input) {
  let hash = 0;
  const text = String(input || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

async function checkHealth() {
  const config = await getConfig();
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: authHeaders(config),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: `Hermes returned HTTP ${response.status}`,
      };
    }
    const data = await response.json().catch(() => ({ status: 'ok' }));
    return {
      ok: true,
      status: data.status || 'ok',
      baseUrl,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'offline',
      message: error.message || 'Unable to reach Hermes',
      baseUrl,
    };
  }
}

function extractOutputText(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const chunks = [];

  for (const item of output) {
    if (item?.type === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const block of content) {
        if (block?.type === 'output_text' && block.text) {
          chunks.push(block.text);
        }
      }
    }
  }

  if (chunks.length) {
    return chunks.join('\n\n').trim();
  }

  return payload?.output_text || payload?.content || '';
}

async function pushRecent(entry) {
  const data = await chrome.storage.local.get({ recentActions: [] });
  const next = [
    {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    },
    ...data.recentActions,
  ].slice(0, 12);

  await chrome.storage.local.set({ recentActions: next });
  return next;
}

async function getRecentActions() {
  const data = await chrome.storage.local.get({ recentActions: [] });
  return data.recentActions;
}

async function getRecentAction(id) {
  const items = await getRecentActions();
  return items.find((item) => item.id === id) || null;
}

async function getPageNotes() {
  const data = await chrome.storage.local.get({ pageNotes: {} });
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
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ pageNotes: notes });
  return notes[key];
}

async function getTrackedPages() {
  const data = await chrome.storage.local.get({ trackedPages: [] });
  return data.trackedPages;
}

function parseIsoTime(value) {
  const stamp = Date.parse(value || '');
  return Number.isFinite(stamp) ? stamp : 0;
}

function sortTrackedPages(items) {
  return [...items].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) {
      return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    }
    return parseIsoTime(right.lastSeenAt || right.createdAt) - parseIsoTime(left.lastSeenAt || left.createdAt);
  });
}

async function upsertTrackedPage(page, pin = true) {
  if (!page?.url) {
    throw new Error('No page URL available to track.');
  }

  const normalizedUrl = canonicalizeUrl(page.url);
  const items = await getTrackedPages();
  const existing = items.find((item) => canonicalizeUrl(item.url) === normalizedUrl);
  const now = new Date().toISOString();
  const nextItem = {
    id: existing?.id || crypto.randomUUID(),
    url: normalizedUrl,
    title: page.title || existing?.title || 'Tracked page',
    hostname: page.hostname || existing?.hostname || '',
    pageType: page.pageType || existing?.pageType || 'page',
    pinned: pin ?? existing?.pinned ?? true,
    lastSeenAt: now,
    lastSnapshotAt: existing?.lastSnapshotAt || '',
    createdAt: existing?.createdAt || now,
  };

  const next = [nextItem, ...items.filter((item) => canonicalizeUrl(item.url) !== normalizedUrl)].slice(0, 30);
  await chrome.storage.local.set({ trackedPages: next });
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
      lastSeenAt: patch.lastSeenAt || item.lastSeenAt || new Date().toISOString(),
    };
    return updated;
  });

  if (!updated) {
    throw new Error('Tracked page not found.');
  }

  await chrome.storage.local.set({ trackedPages: sortTrackedPages(next) });
  return updated;
}

async function removeTrackedPage(url) {
  const normalizedUrl = canonicalizeUrl(url);
  const items = await getTrackedPages();
  const next = items.filter((item) => canonicalizeUrl(item.url) !== normalizedUrl);
  await chrome.storage.local.set({ trackedPages: next });
  return { removed: items.length !== next.length };
}

function summarizeNote(text, limit = 160) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
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

async function getSnapshots() {
  const data = await chrome.storage.local.get({ pageSnapshots: [] });
  return data.pageSnapshots;
}

async function getSnapshotsForUrl(url) {
  const items = await getSnapshots();
  const normalizedUrl = canonicalizeUrl(url);
  return items.filter((item) => canonicalizeUrl(item.url) === normalizedUrl);
}

function makePageDigest(page) {
  return JSON.stringify({
    title: page?.title || '',
    description: page?.description || '',
    headings: page?.headings || [],
    selection: page?.selection || '',
    text: (page?.text || '').slice(0, 6000),
  });
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
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
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
  await chrome.storage.local.set({ pageSnapshots: next });
  try {
    const tracked = await getTrackedPages();
    const updatedTracked = tracked.map((item) => canonicalizeUrl(item.url) === normalizedUrl
      ? { ...item, lastSnapshotAt: snapshot.timestamp, title: page.title || item.title }
      : item);
    await chrome.storage.local.set({ trackedPages: updatedTracked });
  } catch (_) {}
  return {
    snapshot,
    unchanged: false,
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function extractPageContext(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || '';
      const url = window.location.href;
      const hostname = window.location.hostname || '';
      const selection = window.getSelection?.().toString().trim() || '';
      const description = document.querySelector('meta[name="description"]')?.content?.trim() || '';
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 8)
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      const root =
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.body;
      const text = (root?.innerText || document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12000);

      const pageType =
        document.querySelector('article') ? 'article' :
        document.querySelector('form') ? 'form' :
        document.querySelector('[role="main"]') ? 'app' :
        'page';

      return {
        title,
        url,
        hostname,
        selection,
        description,
        headings,
        pageType,
        text,
      };
    },
  });

  return result;
}

function buildConversationId(config, suffix) {
  const safeSuffix = String(suffix || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'general';
  return `${config.conversationPrefix}-${safeSuffix}`;
}

function buildDirectThreadMeta(config, page, tab) {
  const normalizedUrl = canonicalizeUrl(page?.url || tab?.url || '');
  const seed = normalizedUrl || `tab-${tab?.id || 'current'}`;
  const suffix = `direct-${hashString(seed)}`;
  return {
    threadKey: suffix,
    conversation: buildConversationId(config, suffix),
    title: page?.title || tab?.title || 'Current page',
    url: normalizedUrl,
  };
}

function inferAssistantTarget(url) {
  const raw = String(url || '').toLowerCase();
  if (raw.includes('claude.ai')) return 'claude';
  if (raw.includes('chatgpt.com') || raw.includes('chat.openai.com')) return 'chatgpt';
  if (raw.includes('gemini.google.com')) return 'gemini';
  return 'generic';
}

function getModeDefinition(mode) {
  const table = {
    ask: {
      label: 'Ask',
      userPromptFallback: 'Explain what matters on this page.',
      instructions:
        'You are Hermes Relay. Answer with a concise, useful response grounded in the current page. Prefer concrete takeaways, next steps, and cautions.',
      task:
        'Answer the user request using the current page. Ground your response in what is visible here and keep it practical.',
    },
    summarize: {
      label: 'Summarize',
      userPromptFallback: 'Summarize this page for me.',
      instructions:
        'You are Hermes Relay. Summarize the page crisply for a busy user. Emphasize what matters, what can be ignored, and what changed or stands out.',
      task:
        'Summarize the page in a high-signal way. Lead with the important points, then list notable details.',
    },
    'next-steps': {
      label: 'Next Steps',
      userPromptFallback: 'What should I do next here?',
      instructions:
        'You are Hermes Relay. Read the page and produce a short action plan. Focus on the next 3 to 5 useful moves.',
      task:
        'Convert the current page into an action plan. Be specific and sequence the next steps.',
    },
    'draft-reply': {
      label: 'Draft Reply',
      userPromptFallback: 'Draft a reply based on this page.',
      instructions:
        'You are Hermes Relay. Draft a response that a user could paste into another assistant or send as a working reply. Keep it concise and useful.',
      task:
        'Draft a reply or continuation message based on the page context and the user request.',
    },
    'extract-tasks': {
      label: 'Extract Tasks',
      userPromptFallback: 'Extract the tasks and decisions from this page.',
      instructions:
        'You are Hermes Relay. Extract tasks, commitments, blockers, and open questions from the page. Use clean bullets.',
      task:
        'Extract tasks, decisions, blockers, and open questions from the page.',
    },
    research: {
      label: 'Research Brief',
      userPromptFallback: 'Turn this into a research brief.',
      instructions:
        'You are Hermes Relay. Produce a compact research brief with claims, evidence, ambiguities, and what to verify next.',
      task:
        'Turn the current page into a research brief. Separate confirmed information from assumptions and note what deserves verification.',
    },
    compare: {
      label: 'Compare',
      userPromptFallback: 'Help me compare the options on this page.',
      instructions:
        'You are Hermes Relay. Compare options, tradeoffs, and likely decision criteria from the page. Use a compact, scannable format.',
      task:
        'Compare the important options or claims on the page. Highlight differences, tradeoffs, and the likely best choice.',
    },
    'remember-fact': {
      label: 'Remember Fact',
      userPromptFallback: 'Save the durable facts from this page.',
      instructions:
        'You are Hermes Relay. Decide what durable factual knowledge from this page deserves to become Hermes memory. If memory tools are available, store the useful fact(s). Return a compact receipt.',
      task:
        'Identify durable factual knowledge from the page and save it to Hermes memory if warranted. Prefer reusable facts over transient noise.',
    },
    'remember-preference': {
      label: 'Remember Preference',
      userPromptFallback: 'Save any durable preference or style information from this page.',
      instructions:
        'You are Hermes Relay. Look for user preferences, tastes, style cues, operating preferences, or standing instructions. If they are durable, save them to Hermes memory and return a compact receipt.',
      task:
        'Extract durable preferences, style cues, or standing instructions from the page and save them to Hermes memory if warranted.',
    },
    'remember-workflow': {
      label: 'Remember Workflow',
      userPromptFallback: 'Save the reusable workflow or operating pattern from this page.',
      instructions:
        'You are Hermes Relay. Look for repeatable workflow knowledge, process knowledge, or operating patterns that would help future tasks. Save them to Hermes memory if appropriate and return a compact receipt.',
      task:
        'Extract reusable workflow knowledge from the page and save it to Hermes memory if warranted.',
    },
    capture: {
      label: 'Capture',
      instructions:
        'You are Hermes Relay. Summarize this page for later retrieval. If the page contains durable user, environment, or workflow facts, you may use Hermes memory tools when appropriate. End with a short capture receipt.',
      task:
        'Read this page context, summarize the important takeaways, and if durable facts or preferences are revealed, decide whether they belong in Hermes memory.',
    },
    inject: {
      label: 'Build Context',
      instructions:
        'Return only a clean context bundle for another AI assistant. Keep it under 350 words. Use short sections and no preamble.',
      task:
        'Create a compact context bundle for another AI assistant. Include only the page facts, user intent, and relevant next-step framing that would help continue work cleanly.',
    },
  };

  return table[mode] || table.ask;
}

function getTargetGuidance(target) {
  const table = {
    claude: 'Format the context so it reads naturally in Claude. Clean headings, high signal, no filler.',
    chatgpt: 'Format the context so it works cleanly in ChatGPT. Direct, structured, and easy to continue from.',
    gemini: 'Format the context so it works cleanly in Gemini. Be crisp, neutral, and task-oriented.',
    generic: 'Format the context so it works in any assistant. Keep it portable and compact.',
  };

  return table[target] || table.generic;
}

async function callHermesResponse({ prompt, instructions, conversation }) {
  const config = await getConfig();
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/responses`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      model: config.model,
      input: prompt,
      instructions,
      conversation,
      store: true,
    }),
  });

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

function composeDirectPrompt(page, userPrompt) {
  return [
    `Current page title: ${page?.title || '(untitled)'}`,
    `Current page URL: ${page?.url || ''}`,
    `Hostname: ${page?.hostname || ''}`,
    `Page type: ${page?.pageType || 'page'}`,
    page?.description ? `Page description:\n${page.description}` : '',
    Array.isArray(page?.headings) && page.headings.length
      ? `Visible headings:\n- ${page.headings.join('\n- ')}`
      : '',
    page?.selection ? `Selected text:\n${page.selection}` : '',
    `Page text excerpt:\n${page?.text || '(no readable text found)'}`,
    `User message:\n${userPrompt}`,
  ].filter(Boolean).join('\n\n');
}

async function getDirectThread(page = null, tab = null) {
  let activeTab = tab;
  let activePage = page;

  if (!activeTab) {
    activeTab = await getActiveTab();
  }
  if (!activePage && activeTab?.id) {
    activePage = await extractPageContext(activeTab.id);
  }
  if (!activeTab && !activePage) {
    throw new Error('No active tab available.');
  }

  if (activePage?.url) {
    activePage = {
      ...activePage,
      url: canonicalizeUrl(activePage.url),
    };
  }

  const config = await getConfig();
  const meta = buildDirectThreadMeta(config, activePage, activeTab);
  const threads = await getDirectThreads();
  return {
    threadKey: meta.threadKey,
    thread: threads[meta.threadKey] || {
      ...meta,
      messages: [],
      updatedAt: '',
    },
    page: activePage,
    tab: activeTab,
  };
}

async function summarizePageContinuity(page = null, tab = null) {
  let activeTab = tab;
  let activePage = page;

  if (!activeTab) {
    activeTab = await getActiveTab();
  }
  if (!activePage && activeTab?.id) {
    activePage = await extractPageContext(activeTab.id);
  }
  if (!activePage?.url) {
    return {
      seenBefore: false,
      status: 'new',
      message: 'Hermes has not seen this page yet.',
      noteCount: 0,
      snapshotCount: 0,
      tracked: false,
      directMessageCount: 0,
      lastSeenAt: '',
      lastSnapshotAt: '',
      lastNotedAt: '',
      threadUpdatedAt: '',
      canonicalUrl: '',
    };
  }

  const canonicalUrl = canonicalizeUrl(activePage.url);
  const [notes, snapshots, trackedPages, direct] = await Promise.all([
    getPageNotes(),
    getSnapshots(),
    getTrackedPages(),
    getDirectThread({ ...activePage, url: canonicalUrl }, activeTab),
  ]);

  const note = notes[canonicalUrl] || null;
  const snapshotItems = snapshots.filter((item) => canonicalizeUrl(item.url) === canonicalUrl);
  const tracked = trackedPages.find((item) => canonicalizeUrl(item.url) === canonicalUrl) || null;
  const directMessageCount = Array.isArray(direct.thread?.messages) ? direct.thread.messages.length : 0;
  const seenBefore = Boolean(note?.text || snapshotItems.length || tracked || directMessageCount);
  const lastSeenAt = tracked?.lastSeenAt || tracked?.createdAt || '';
  const threadUpdatedAt = direct.thread?.updatedAt || '';
  const lastSnapshotAt = snapshotItems[0]?.timestamp || tracked?.lastSnapshotAt || '';
  const lastNotedAt = note?.updatedAt || '';

  let message = 'Hermes has not seen this page yet.';
  if (seenBefore) {
    const facts = [];
    if (tracked) facts.push(tracked.pinned ? 'tracked + pinned' : 'tracked');
    if (note?.text) facts.push('has note');
    if (snapshotItems.length) facts.push(`${snapshotItems.length} snapshot${snapshotItems.length === 1 ? '' : 's'}`);
    if (directMessageCount) facts.push(`${directMessageCount} direct message${directMessageCount === 1 ? '' : 's'}`);
    message = `Hermes has seen this page before${facts.length ? ` • ${facts.join(' • ')}` : ''}`;
  }

  return {
    seenBefore,
    status: seenBefore ? 'seen' : 'new',
    message,
    noteCount: note?.text ? 1 : 0,
    snapshotCount: snapshotItems.length,
    tracked: Boolean(tracked),
    pinned: Boolean(tracked?.pinned),
    notePreview: summarizeNote(note?.text || '', 120),
    directMessageCount,
    lastSeenAt,
    lastSnapshotAt,
    lastNotedAt,
    threadUpdatedAt,
    canonicalUrl,
  };
}

async function saveDirectThread(threadKey, thread) {
  const threads = await getDirectThreads();
  threads[threadKey] = thread;
  await saveDirectThreads(threads);
  return thread;
}

async function clearDirectThread(page = null, tab = null) {
  const { threadKey, thread } = await getDirectThread(page, tab);
  const threads = await getDirectThreads();
  threads[threadKey] = {
    ...thread,
    messages: [],
    updatedAt: new Date().toISOString(),
  };
  await saveDirectThreads(threads);
  return threads[threadKey];
}

async function sendDirectLineMessage({
  prompt = '',
  page = null,
  tab = null,
  selectionText = '',
  source = 'workspace',
}) {
  let activeTab = tab;
  let activePage = page;
  if (!activeTab) {
    activeTab = await getActiveTab();
  }
  if (!activePage && activeTab?.id) {
    activePage = await extractPageContext(activeTab.id);
  }
  if (!activePage) {
    throw new Error('No active page available.');
  }

  if (selectionText) {
    activePage = {
      ...activePage,
      selection: selectionText,
    };
  }

  const config = await getConfig();
  const meta = buildDirectThreadMeta(config, activePage, activeTab);
  const promptText = prompt.trim() || 'Take in this page and tell me what matters.';
  const result = await callHermesResponse({
    prompt: composeDirectPrompt(activePage, promptText),
    instructions: 'You are Hermes receiving live browser context from Hermes Relay. Treat the browser as your eyes and ears. Answer directly, ground yourself in the supplied page, and stay useful.',
    conversation: meta.conversation,
  });

  const existing = await getDirectThreads();
  const prior = existing[meta.threadKey] || {
    ...meta,
    messages: [],
    updatedAt: '',
  };
  const timestamp = new Date().toISOString();
  const nextThread = {
    ...prior,
    ...meta,
    updatedAt: timestamp,
    messages: [
      ...prior.messages,
      {
        id: crypto.randomUUID(),
        role: 'user',
        text: promptText,
        timestamp,
        source,
        selection: selectionText || activePage.selection || '',
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: result.text,
        timestamp: new Date().toISOString(),
        source,
      },
    ].slice(-24),
  };

  await saveDirectThread(meta.threadKey, nextThread);
  await pushRecent({
    type: 'direct-line',
    title: activePage.title || activeTab?.title || 'Current page',
    url: activePage.url || activeTab?.url || '',
    prompt: promptText,
    summary: result.text.slice(0, 280),
    output: result.text,
    source,
  });

  return {
    ok: true,
    thread: nextThread,
    threadKey: meta.threadKey,
    page: activePage,
    text: result.text,
    raw: result.raw,
  };
}

function composePagePrompt(page, userPrompt, mode, target) {
  const modeDef = getModeDefinition(mode);
  const sections = [
    `Current page title: ${page.title || '(untitled)'}`,
    `Current page URL: ${page.url}`,
    `Hostname: ${page.hostname || ''}`,
    `Page type: ${page.pageType || 'page'}`,
    `Relay mode: ${modeDef.label}`,
  ];

  if (page.description) {
    sections.push(`Page description:\n${page.description}`);
  }

  if (Array.isArray(page.headings) && page.headings.length) {
    sections.push(`Visible headings:\n- ${page.headings.join('\n- ')}`);
  }

  if (page.selection) {
    sections.push(`Selected text:\n${page.selection}`);
  }

  sections.push(`Page text excerpt:\n${page.text || '(no readable text found)'}`);

  if (mode === 'inject') {
    sections.push(`Target assistant: ${target}`);
  }

  sections.push(`Task:\n${modeDef.task}`);
  sections.push(`User request:\n${userPrompt || modeDef.userPromptFallback || ''}`);

  return sections.join('\n\n');
}

async function askHermesAboutPage(userPrompt, mode = 'ask') {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error('No active tab available.');
  }
  const page = await extractPageContext(tab.id);
  const config = await getConfig();
  const conversation = buildConversationId(config, `page-${mode}`);
  const prompt = composePagePrompt(page, userPrompt, mode, 'generic');
  const instructions = getModeDefinition(mode).instructions;
  const result = await callHermesResponse({ prompt, instructions, conversation });
  await pushRecent({
    type: `page-${mode}`,
    title: page.title || tab.title || 'Current page',
    url: page.url || tab.url || '',
    prompt: userPrompt,
    summary: result.text.slice(0, 280),
    output: result.text,
    mode,
  });
  return {
    page,
    ...result,
  };
}

async function runWorkflow({
  mode = 'ask',
  prompt = '',
  target = 'generic',
  page = null,
  title = '',
  url = '',
}) {
  let activePage = page;
  let fallbackTitle = title;
  let fallbackUrl = url;

  if (!activePage) {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error('No active tab available.');
    }
    activePage = await extractPageContext(tab.id);
    fallbackTitle = tab.title || activePage.title || 'Current page';
    fallbackUrl = tab.url || activePage.url || '';
  }

  const config = await getConfig();
  const conversation = buildConversationId(config, `workflow-${mode}`);
  const effectiveTarget = mode === 'inject'
    ? (target === 'auto' ? inferAssistantTarget(activePage.url) : target)
    : 'generic';
  const promptBody = composePagePrompt(activePage, prompt, mode, effectiveTarget);
  const instructions = mode === 'inject'
    ? `${getModeDefinition(mode).instructions} ${getTargetGuidance(effectiveTarget)}`
    : getModeDefinition(mode).instructions;
  const result = await callHermesResponse({
    prompt: promptBody,
    instructions,
    conversation,
  });

  await pushRecent({
    type: `workflow-${mode}`,
    title: activePage.title || fallbackTitle || 'Current page',
    url: activePage.url || fallbackUrl || '',
    prompt,
    summary: result.text.slice(0, 280),
    output: result.text,
    mode,
    target: effectiveTarget,
  });

  return {
    page: activePage,
    text: result.text,
    raw: result.raw,
    mode,
    target: effectiveTarget,
  };
}

async function runMemoryAction({
  kind = 'fact',
  note = '',
  page = null,
}) {
  const modeMap = {
    fact: 'remember-fact',
    preference: 'remember-preference',
    workflow: 'remember-workflow',
  };
  const mode = modeMap[kind] || 'remember-fact';
  return runWorkflow({
    mode,
    prompt: note,
    target: 'generic',
    page,
  });
}

async function capturePageToHermes() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error('No active tab available.');
  }
  const page = await extractPageContext(tab.id);
  const config = await getConfig();
  const conversation = buildConversationId(config, 'capture');
  const prompt = composePagePrompt(page, '', 'capture');
  const instructions =
    'You are Hermes Relay. Summarize this page for later retrieval. If the page contains durable user, environment, or workflow facts, you may use Hermes memory tools when appropriate. End with a short capture receipt.';
  const result = await callHermesResponse({ prompt, instructions, conversation });
  await pushRecent({
    type: 'capture-page',
    title: page.title || tab.title || 'Current page',
    url: page.url || tab.url || '',
    summary: result.text.slice(0, 280),
    output: result.text,
    mode: 'capture',
  });
  return {
    page,
    ...result,
  };
}

async function buildInjectableContext(userPrompt, requestedTarget = 'auto') {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error('No active tab available.');
  }
  const page = await extractPageContext(tab.id);
  const config = await getConfig();
  const target = requestedTarget === 'auto'
    ? inferAssistantTarget(tab.url)
    : requestedTarget;
  const conversation = buildConversationId(config, 'inject');
  const prompt = composePagePrompt(page, userPrompt, 'inject', target);
  const instructions = `${getModeDefinition('inject').instructions} ${getTargetGuidance(target)}`;
  const result = await callHermesResponse({ prompt, instructions, conversation });
  await pushRecent({
    type: 'build-context',
    title: page.title || tab.title || 'Current page',
    url: page.url || tab.url || '',
    summary: result.text.slice(0, 280),
    output: result.text,
    target,
    mode: 'inject',
  });
  return {
    page,
    target,
    ...result,
  };
}

async function compareWithLatestSnapshot(page = null, note = '') {
  let activePage = page;
  if (!activePage) {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error('No active tab available.');
    }
    activePage = await extractPageContext(tab.id);
  }

  const snapshots = await getSnapshotsForUrl(activePage.url);
  const previous = snapshots[0];
  if (!previous) {
    throw new Error('No earlier snapshot exists for this page yet.');
  }

  const config = await getConfig();
  const conversation = buildConversationId(config, 'snapshot-compare');
  const prompt = [
    `Current page title: ${activePage.title || '(untitled)'}`,
    `Current page URL: ${activePage.url}`,
    `User note:\n${note || 'Describe what changed in a high-signal way.'}`,
    'Previous snapshot:',
    `Title: ${previous.title || '(untitled)'}`,
    `Description: ${previous.description || ''}`,
    `Headings:\n- ${(previous.headings || []).join('\n- ')}`,
    `Text excerpt:\n${previous.text || ''}`,
    'Current page:',
    `Description: ${activePage.description || ''}`,
    `Headings:\n- ${(activePage.headings || []).join('\n- ')}`,
    `Text excerpt:\n${(activePage.text || '').slice(0, 8000)}`,
    'Task:\nCompare the previous snapshot against the current page. Explain what changed, what stayed the same, what matters, and any likely implications.',
  ].join('\n\n');
  const instructions =
    'You are Hermes Relay. Produce a compact diff-style comparison between the earlier page snapshot and the current page. Focus on meaningful changes, not trivial wording drift.';
  const result = await callHermesResponse({ prompt, instructions, conversation });

  await pushRecent({
    type: 'snapshot-compare',
    title: activePage.title || previous.title || 'Current page',
    url: activePage.url || '',
    prompt: note,
    summary: result.text.slice(0, 280),
    output: result.text,
    mode: 'snapshot-compare',
  });

  return {
    page: activePage,
    previous,
    text: result.text,
    raw: result.raw,
  };
}

async function injectIntoActiveTab(text) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error('No active tab available.');
  }

  try {
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: 'INSERT_HERMES_CONTEXT',
      text,
    });
    if (!reply?.ok) {
      throw new Error(reply?.error || 'No compatible chat input found.');
    }
    await pushRecent({
      type: 'inject-context',
      title: tab.title || 'Active tab',
      url: tab.url || '',
      summary: text.slice(0, 280),
      output: text,
    });
    return reply;
  } catch (error) {
    throw new Error(error.message || 'Could not inject into the current tab.');
  }
}

async function askHermesAboutSelection(selectionText, tab) {
  const config = await getConfig();
  const conversation = buildConversationId(config, 'selection');
  const prompt = `Selected text:\n${selectionText}\n\nTask:\nExplain what matters here, add useful context, and suggest what to do next.`;
  const instructions =
    'You are Hermes Relay. Answer crisply and make the result useful in-place for someone reading in the browser.';
  const result = await callHermesResponse({ prompt, instructions, conversation });
  await pushRecent({
    type: 'ask-selection',
    title: tab?.title || 'Selection',
    url: tab?.url || '',
    summary: result.text.slice(0, 280),
    output: result.text,
  });
  return result.text;
}

async function rememberSelection(selectionText, tab) {
  const config = await getConfig();
  const conversation = buildConversationId(config, 'remember');
  const prompt = [
    `Source URL: ${tab?.url || ''}`,
    `Source title: ${tab?.title || ''}`,
    `Selection:\n${selectionText}`,
    'Task:\nDecide whether this should be persisted to Hermes memory. If yes, store the durable part and briefly confirm what was saved. If not, explain why not in one sentence.',
  ].join('\n\n');
  const instructions =
    'You are Hermes Relay. Favor durable, reusable memory over noisy, one-off fragments. Use Hermes memory tools only when the selection deserves retention.';
  const result = await callHermesResponse({ prompt, instructions, conversation });
  await pushRecent({
    type: 'remember-selection',
    title: tab?.title || 'Selection',
    url: tab?.url || '',
    summary: result.text.slice(0, 280),
    output: result.text,
  });
  return result.text;
}

async function openContextResult(text, label) {
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${label}</title>
        <style>
          body { margin: 0; padding: 24px; background: #202316; color: #f2ead7; font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
          main { max-width: 860px; margin: 0 auto; }
          h1 { margin: 0 0 16px; font-size: 18px; }
          pre { white-space: pre-wrap; word-break: break-word; background: #2a311f; border: 1px solid #586546; padding: 18px; border-radius: 12px; }
        </style>
      </head>
      <body>
        <main>
          <h1>${label}</h1>
          <pre>${text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</pre>
        </main>
      </body>
    </html>`;
  await chrome.tabs.create({
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  });
}

async function openSidePanel() {
  const tab = await getActiveTab();
  if (!tab?.windowId) {
    throw new Error('No active window available.');
  }

  await chrome.sidePanel.setOptions({
    path: 'sidepanel/sidepanel.html',
    enabled: true,
  });
  await chrome.sidePanel.open({ windowId: tab.windowId });
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.askSelection,
    title: 'Explain this selection with Hermes',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.rememberSelection,
    title: 'Save this selection to Hermes memory',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.sendPage,
    title: 'Open this page in Hermes Workspace',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.injectContext,
    title: 'Insert latest Hermes context here',
    contexts: ['editable'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === CONTEXT_MENU_IDS.askSelection && info.selectionText) {
      const result = await sendDirectLineMessage({
        tab,
        selectionText: info.selectionText.trim(),
        prompt: 'Focus on this selection and tell me what matters.',
        source: 'context-selection',
      });
      await setWorkspaceState(
        {
          output: result.text || '',
          lastAction: 'selection-explain',
          source: 'context-menu',
        },
        { url: tab?.url || '' },
      );
      await openSidePanel();
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.rememberSelection && info.selectionText) {
      const result = await sendDirectLineMessage({
        tab,
        selectionText: info.selectionText.trim(),
        prompt: 'Look at this selection, decide what should be remembered, and tell me what to do next.',
        source: 'context-remember',
      });
      await setWorkspaceState(
        {
          output: result.text || '',
          lastAction: 'selection-memory',
          source: 'context-menu',
        },
        { url: tab?.url || '' },
      );
      await openSidePanel();
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.sendPage) {
      const result = await sendDirectLineMessage({
        tab,
        prompt: 'Take in this whole page and tell me what matters and what I should do next.',
        source: 'context-page',
      });
      await setWorkspaceState(
        {
          output: result.text || '',
          lastAction: 'page-direct-line',
          source: 'context-menu',
        },
        { url: tab?.url || '' },
      );
      await openSidePanel();
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.injectContext) {
      const result = await buildInjectableContext('Continue from the current page and focused task.', 'auto');
      await setWorkspaceState(
        {
          output: result.text || '',
          target: result.target || 'auto',
          lastAction: 'inject-context',
          source: 'context-menu',
        },
        { url: tab?.url || '' },
      );
      await injectIntoActiveTab(result.text);
    }
  } catch (error) {
    await setWorkspaceState(
      {
        output: error.message || String(error),
        lastAction: 'error',
        source: 'context-menu',
      },
      { url: tab?.url || '' },
    );
    await openSidePanel();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'capture-page') {
      const result = await capturePageToHermes();
      await openContextResult(result.text, 'Hermes page capture');
    }

    if (command === 'build-context') {
      const result = await buildInjectableContext('Continue from the current page and focused task.', 'auto');
      await openContextResult(result.text, 'Hermes context bundle');
    }

    if (command === 'inject-context') {
      const recent = await getRecentActions();
      const latestContext = recent.find((item) => item.type === 'build-context' || item.type === 'inject-context');
      if (latestContext?.output) {
        await injectIntoActiveTab(latestContext.output);
      } else {
        const result = await buildInjectableContext('Continue from the current page and focused task.', 'auto');
        await injectIntoActiveTab(result.text);
      }
    }
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'GET_STATUS') {
      sendResponse({
        health: await checkHealth(),
        config: await getConfig(),
      });
      return;
    }

    if (message.type === 'GET_ACTIVE_PAGE_CONTEXT') {
      const tab = await getActiveTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'No active tab available.' });
        return;
      }
      const page = await extractPageContext(tab.id);
      const note = await getPageNote(page.url);
      const continuity = await summarizePageContinuity(page, tab);
      sendResponse({ ok: true, page, tab, note, continuity });
      return;
    }

    if (message.type === 'GET_PAGE_SNAPSHOTS') {
      const url = message.url;
      const snapshots = url ? await getSnapshotsForUrl(url) : await getSnapshots();
      sendResponse({ ok: true, snapshots });
      return;
    }

    if (message.type === 'GET_DIRECT_THREAD') {
      const result = await getDirectThread(message.page || null, null);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'DIRECT_LINE_MESSAGE') {
      const result = await sendDirectLineMessage({
        prompt: message.prompt || '',
        page: message.page || null,
        selectionText: message.selectionText || '',
        source: message.source || 'workspace',
      });
      sendResponse(result);
      return;
    }

    if (message.type === 'CLEAR_DIRECT_THREAD') {
      const thread = await clearDirectThread(message.page || null, null);
      sendResponse({ ok: true, thread });
      return;
    }

    if (message.type === 'GET_TRACKED_PAGES') {
      const trackedPages = await getTrackedPageViews();
      sendResponse({ ok: true, trackedPages });
      return;
    }

    if (message.type === 'SAVE_CONFIG') {
      sendResponse({
        ok: true,
        config: await setConfig(message.config || {}),
      });
      return;
    }

    if (message.type === 'GET_RECENTS') {
      sendResponse({
        ok: true,
        recentActions: await getRecentActions(),
      });
      return;
    }

    if (message.type === 'GET_WORKSPACE_STATE') {
      sendResponse({
        ok: true,
        workspaceState: await getWorkspaceState({
          url: message.url || '',
          useActivePage: Boolean(message.useActivePage),
        }),
      });
      return;
    }

    if (message.type === 'SAVE_WORKSPACE_STATE') {
      sendResponse({
        ok: true,
        workspaceState: await setWorkspaceState(message.patch || {}, {
          url: message.url || '',
          useActivePage: Boolean(message.useActivePage),
        }),
      });
      return;
    }

    if (message.type === 'SAVE_PAGE_NOTE') {
      const saved = await savePageNote(message.url || '', message.note || '');
      sendResponse({ ok: true, note: saved });
      return;
    }

    if (message.type === 'TRACK_PAGE') {
      let page = message.page || null;
      if (!page) {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab available.' });
          return;
        }
        page = await extractPageContext(tab.id);
      }
      const tracked = await upsertTrackedPage(page, message.pinned !== false);
      sendResponse({ ok: true, tracked });
      return;
    }

    if (message.type === 'UNTRACK_PAGE') {
      const result = await removeTrackedPage(message.url || '');
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'UPDATE_TRACKED_PAGE') {
      const tracked = await updateTrackedPage(message.url || '', message.patch || {});
      sendResponse({ ok: true, tracked });
      return;
    }

    if (message.type === 'ASK_PAGE') {
      const result = await askHermesAboutPage(message.prompt || '', message.mode || 'ask');
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'RUN_WORKFLOW') {
      const result = await runWorkflow({
        mode: message.mode || 'ask',
        prompt: message.prompt || '',
        target: message.target || 'generic',
        page: message.page || null,
        title: message.title || '',
        url: message.url || '',
      });
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'RUN_MEMORY_ACTION') {
      const result = await runMemoryAction({
        kind: message.kind || 'fact',
        note: message.note || '',
        page: message.page || null,
      });
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'CAPTURE_PAGE') {
      const result = await capturePageToHermes();
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'BUILD_CONTEXT') {
      const result = await buildInjectableContext(message.prompt || '', message.target || 'auto');
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'SAVE_PAGE_SNAPSHOT') {
      let page = message.page || null;
      if (!page) {
        const tab = await getActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab available.' });
          return;
        }
        page = await extractPageContext(tab.id);
      }
      const result = await saveSnapshot(page, message.source || 'workspace');
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'COMPARE_WITH_SNAPSHOT') {
      const result = await compareWithLatestSnapshot(message.page || null, message.note || '');
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === 'INJECT_CONTEXT') {
      const result = await injectIntoActiveTab(message.text || '');
      sendResponse({ ok: true, result });
      return;
    }

    if (message.type === 'GET_RECENT_DETAIL') {
      const item = await getRecentAction(message.id);
      sendResponse({ ok: !!item, item });
      return;
    }

    if (message.type === 'OPEN_OUTPUT_TAB') {
      await openContextResult(message.text || '', message.label || 'Hermes Relay for Chrome');
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'OPEN_SIDE_PANEL') {
      const result = await openSidePanel();
      sendResponse(result);
      return;
    }

    if (message.type === 'OPEN_TRACKED_PAGE') {
      await chrome.tabs.create({ url: message.url });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type.' });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error.message || String(error),
    });
  });

  return true;
});
