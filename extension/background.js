import { CONTEXT_MENU_IDS } from './lib/shared/constants.js';
import { canonicalizeUrl } from './lib/shared/utils.js';
import { createStorageApi } from './lib/background/storage.js';
import { createPageContextApi } from './lib/background/page-context.js';
import { createHermesClient } from './lib/background/hermes-client.js';
import { buildLocalDevConfigPatch, loadLocalDevConfig } from './lib/background/local-dev-config.js';
import { createRelayOperations } from './lib/background/workflows.js';

const storageApi = createStorageApi();
const pageContextApi = createPageContextApi();
const hermesClient = createHermesClient();
const readStoredConfig = storageApi.getConfig.bind(storageApi);
const permissionsApi = globalThis.chrome?.permissions;
const WATCH_ALARM_NAME = 'hermes-relay-watch-pages';

function getOriginPattern(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch (_) {
    return '';
  }
}

async function requestSitePermission(url = '') {
  const origin = getOriginPattern(url);
  if (!origin) {
    throw new Error('Open a normal website tab before allowing it as an AI host.');
  }

  if (!permissionsApi?.request || !permissionsApi?.contains) {
    return origin;
  }

  if (await permissionsApi.contains({ origins: [origin] })) {
    return origin;
  }

  const granted = await permissionsApi.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`Hermes needs permission for ${origin} before it can route into this site.`);
  }

  return origin;
}

async function syncLocalDevConfig() {
  const [config, localDevConfig] = await Promise.all([
    readStoredConfig(),
    loadLocalDevConfig(),
  ]);

  const patch = buildLocalDevConfigPatch(config, localDevConfig);
  if (!Object.keys(patch).length) {
    return {
      config,
      localDevConfig,
    };
  }

  return {
    config: await storageApi.setConfig(patch),
    localDevConfig,
  };
}

async function getRuntimeConfig({ ensureReachable = false } = {}) {
  let { config, localDevConfig } = await syncLocalDevConfig();

  if (!ensureReachable) {
    return {
      config,
      localDevConfig,
      health: null,
    };
  }

  let health = await hermesClient.checkHealth(config);
  const detectedBaseUrl = health.detectedBaseUrl || '';
  if ((health.ok || health.authRequired) && detectedBaseUrl && detectedBaseUrl !== config.baseUrl) {
    config = await storageApi.setConfig({ baseUrl: detectedBaseUrl });
    health = await hermesClient.checkHealth(config);
  }

  return {
    config,
    localDevConfig,
    health,
  };
}

async function getAuthenticatedPreflight(config, health) {
  if (!health?.ok) {
    if (health?.authRequired) {
      return {
        ok: false,
        ran: false,
        authRequired: true,
        status: 'invalid-api-key',
        message: 'Hermes rejected the saved API key during the health check.',
      };
    }

    return {
      ok: false,
      ran: false,
      status: 'server-not-ready',
      message: 'Hermes must be healthy before authenticated access can be verified.',
    };
  }

  if (!String(config?.apiKey || '').trim()) {
    return {
      ok: false,
      ran: false,
      status: 'missing-api-key',
      message: 'Paste your API key once to verify authenticated access.',
    };
  }

  return hermesClient.preflightAccess(config);
}

const operations = createRelayOperations({
  storageApi,
  pageContextApi,
  hermesClient,
  getConfig: async () => (await getRuntimeConfig({ ensureReachable: true })).config,
});

const LIVE_EVENT_TYPES = [
  'session.attached',
  'command.created',
  'command.claimed',
  'assistant.delta',
  'assistant.final',
  'tool.status',
  'browser.context',
  'browser.action.requested',
  'browser.action.result',
  'approval.requested',
  'approval.resolved',
  'error',
];

const liveStreamState = {
  sessionId: '',
  status: 'idle',
  error: '',
  eventSource: null,
};

function stopLiveEventStream() {
  if (liveStreamState.eventSource) {
    liveStreamState.eventSource.close();
  }
  liveStreamState.sessionId = '';
  liveStreamState.status = 'idle';
  liveStreamState.error = '';
  liveStreamState.eventSource = null;
}

async function recordLiveEvent(event) {
  if (!event?.session_id) return;
  await storageApi.pushLiveEvents([event]);
  chrome.runtime.sendMessage({ type: 'LIVE_EVENT_UPDATE', event }).catch(() => {});
}

async function ensureLiveEventStream(config, liveSession) {
  const sessionId = liveSession?.session?.session_id || '';
  if (!sessionId || !config?.apiKey || typeof EventSource === 'undefined') {
    if (!sessionId) {
      stopLiveEventStream();
    }
    return;
  }
  if (liveStreamState.eventSource && liveStreamState.sessionId === sessionId) {
    return;
  }

  stopLiveEventStream();
  const existing = await storageApi.getLiveEvents(sessionId);
  const after = existing.reduce((max, event) => Math.max(max, Number(event.sequence || 0)), 0);
  const source = new EventSource(hermesClient.buildLiveEventsUrl(config, { sessionId, after }));
  liveStreamState.sessionId = sessionId;
  liveStreamState.status = 'connecting';
  liveStreamState.eventSource = source;

  const handleEvent = (event) => {
    try {
      const payload = JSON.parse(event.data || '{}');
      liveStreamState.status = 'connected';
      liveStreamState.error = '';
      recordLiveEvent(payload).catch(() => {});
    } catch (error) {
      liveStreamState.status = 'error';
      liveStreamState.error = error.message || String(error);
    }
  };

  LIVE_EVENT_TYPES.forEach((eventType) => {
    source.addEventListener(eventType, handleEvent);
  });
  source.onmessage = handleEvent;
  source.onerror = () => {
    liveStreamState.status = 'reconnecting';
    liveStreamState.error = 'Live event stream reconnecting.';
  };
}

function summarizeLiveTimeline(events = []) {
  const sorted = [...events].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const resolvedApprovals = new Set(
    sorted
      .filter((event) => event.type === 'approval.resolved')
      .map((event) => event.payload?.approval_id)
      .filter(Boolean),
  );
  const pendingApproval = [...sorted]
    .reverse()
    .find((event) => event.type === 'approval.requested' && !resolvedApprovals.has(event.payload?.approval_id));
  const lastResult = [...sorted]
    .reverse()
    .find((event) => ['assistant.final', 'browser.action.result', 'error'].includes(event.type));
  const activeCommand = [...sorted]
    .reverse()
    .find((event) => ['command.created', 'command.claimed', 'tool.status', 'assistant.delta'].includes(event.type));

  return {
    status: liveStreamState.status,
    error: liveStreamState.error,
    eventCount: sorted.length,
    pendingApproval: pendingApproval || null,
    lastResult: lastResult || null,
    activeCommand: activeCommand || null,
    lastEvent: sorted[sorted.length - 1] || null,
  };
}

function contextMenuCreate(menu) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(menu, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function contextMenusRemoveAll() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      resolve();
    });
  });
}

async function ensureContextMenus() {
  await contextMenusRemoveAll();
  await Promise.all([
    contextMenuCreate({
      id: CONTEXT_MENU_IDS.askSelection,
      title: 'Explain this selection with Hermes',
      contexts: ['selection'],
    }),
    contextMenuCreate({
      id: CONTEXT_MENU_IDS.rememberSelection,
      title: 'Save this selection to Hermes memory',
      contexts: ['selection'],
    }),
    contextMenuCreate({
      id: CONTEXT_MENU_IDS.sendPage,
      title: 'Open this page in Hermes Workspace',
      contexts: ['page'],
    }),
    contextMenuCreate({
      id: CONTEXT_MENU_IDS.injectContext,
      title: 'Insert latest Hermes context here',
      contexts: ['editable'],
    }),
  ]);
}

async function initializeRelay() {
  await storageApi.ensureStorageSchema();
  await syncLocalDevConfig();
  await ensureContextMenus();
  await ensureWatcherAlarm();
}

let ready = Promise.resolve();

function refreshReady() {
  ready = initializeRelay().catch((error) => {
    console.error('Hermes Relay initialization failed.', error);
  });
  return ready;
}

function scheduleInitialization() {
  refreshReady().catch((error) => {
    console.error('Hermes Relay re-initialization failed.', error);
  });
}

async function resolveWorkspaceStateKey({ url = '', useActivePage = false } = {}) {
  if (url) {
    return canonicalizeUrl(url);
  }

  if (!useActivePage) {
    return '';
  }

  const activeTab = await pageContextApi.getActiveTab();
  if (!activeTab?.id) {
    return canonicalizeUrl(activeTab?.url || '');
  }

  try {
    const activePage = await pageContextApi.extractPageContext(activeTab.id);
    return canonicalizeUrl(activePage?.url || activeTab?.url || '');
  } catch (_) {
    return canonicalizeUrl(activeTab?.url || '');
  }
}

async function getWorkspaceState(scope = {}) {
  const key = await resolveWorkspaceStateKey(scope);
  return storageApi.getWorkspaceStateByKey(key);
}

async function setWorkspaceState(patch = {}, scope = {}) {
  const key = await resolveWorkspaceStateKey(scope);
  return storageApi.setWorkspaceStateByKey(key, patch);
}

async function ensureWatcherAlarm() {
  if (!chrome.alarms?.create) return;
  const tracked = await storageApi.getTrackedPages();
  const hasWatchers = tracked.some((item) => item.watchEnabled);
  if (!hasWatchers) {
    await chrome.alarms.clear(WATCH_ALARM_NAME);
    return;
  }
  chrome.alarms.create(WATCH_ALARM_NAME, {
    periodInMinutes: 15,
  });
}

async function runPageWatchers() {
  const tracked = await storageApi.getTrackedPages();
  const watchers = tracked.filter((item) => item.watchEnabled);
  if (!watchers.length) {
    await ensureWatcherAlarm();
    return;
  }

  const tabs = await chrome.tabs.query({});
  const nowIso = new Date().toISOString();
  for (const watcher of watchers) {
    const intervalMs = Math.max(15, Number(watcher.watchIntervalMinutes || 60)) * 60000;
    if (watcher.lastWatchAt && Date.now() - new Date(watcher.lastWatchAt).getTime() < intervalMs) {
      continue;
    }
    const tab = tabs.find((item) => canonicalizeUrl(item.url || '') === canonicalizeUrl(watcher.url || ''));
    if (!tab?.id) {
      await storageApi.updateTrackedPage(watcher.url, {
        lastWatchAt: nowIso,
        lastWatchStatus: 'skipped-not-open',
      }).catch(() => null);
      continue;
    }
    try {
      const page = await pageContextApi.extractPageContext(tab.id);
      const saved = await storageApi.saveSnapshot(page, 'watcher');
      await storageApi.updateTrackedPage(watcher.url, {
        lastWatchAt: nowIso,
        lastWatchStatus: saved.unchanged ? 'unchanged' : 'changed',
      });
      if (!saved.unchanged) {
        await storageApi.pushRecent({
          type: 'page-watch-change',
          title: page.title || watcher.title || 'Watched page',
          url: page.url || watcher.url,
          summary: 'Watched page changed while open. A new snapshot was saved.',
          output: `Watched page changed: ${page.title || watcher.title || watcher.url}`,
          modeLabel: 'Page Watcher',
          scopeLabel: 'Readable page',
          destinationLabel: 'Workspace history',
          statusLabel: 'Changed',
          provenanceText: 'Used explicit page watcher + readable page snapshot',
        });
      }
    } catch (error) {
      await storageApi.updateTrackedPage(watcher.url, {
        lastWatchAt: nowIso,
        lastWatchStatus: error.message || 'watch failed',
      }).catch(() => null);
    }
  }
}

async function requirePage(page = null) {
  const current = await operations.getCurrentPageContext(page, null);
  if (!current.page) {
    throw new Error('No active tab available.');
  }
  return current.page;
}

async function messageGetStatus() {
  const { config, health, localDevConfig } = await getRuntimeConfig({
    ensureReachable: true,
  });
  const [preflight, liveSession] = await Promise.all([
    getAuthenticatedPreflight(config, health),
    hermesClient.getCurrentLiveSession(config),
  ]);
  await ensureLiveEventStream(config, liveSession);
  const liveEvents = liveSession?.session?.session_id
    ? await storageApi.getLiveEvents(liveSession.session.session_id)
    : [];
  return {
    health,
    preflight,
    liveSession,
    liveTimeline: summarizeLiveTimeline(liveEvents),
    config,
    localDevConfig: localDevConfig ? {
      source: localDevConfig.source,
      generatedAt: localDevConfig.generatedAt,
    } : null,
  };
}

async function messageGetActivePageContext() {
  const current = await operations.getCurrentPageContext();
  if (!current.tab?.id) {
    return { ok: false, error: 'No active tab available.' };
  }
  if (!current.page) {
    return { ok: false, error: 'Hermes could not inspect the active tab.' };
  }

  const [note, continuity] = await Promise.all([
    storageApi.getPageNote(current.page.url),
    operations.summarizePageContinuity(current.page, current.tab),
  ]);

  return {
    ok: true,
    page: current.page,
    tab: current.tab,
    note,
    continuity,
  };
}

async function messageGetHandoffStatus() {
  const status = await operations.getLatestContextStatus();
  return {
    ok: true,
    handoff: {
      available: status.available,
      title: status.title,
      timestamp: status.timestamp,
      target: status.target,
      type: status.type,
      canInsertHere: status.canInsertHere,
      activeTarget: status.activeTarget,
      activeHostname: status.activeHostname,
      canAllowCurrentHost: status.canAllowCurrentHost,
    },
  };
}

const messageHandlers = {
  async GET_STATUS() {
    return messageGetStatus();
  },

  async GET_ACTIVE_PAGE_CONTEXT() {
    return messageGetActivePageContext();
  },

  async GET_HANDOFF_STATUS() {
    return messageGetHandoffStatus();
  },

  async GET_PAGE_SNAPSHOTS(message) {
    const snapshots = message.url
      ? await storageApi.getSnapshotsForUrl(message.url)
      : await storageApi.getSnapshots();
    return { ok: true, snapshots };
  },

  async GET_DIRECT_THREAD(message) {
    return {
      ok: true,
      ...(await operations.getDirectThread(message.page || null, null)),
    };
  },

  async DIRECT_LINE_MESSAGE(message) {
    return operations.sendDirectLineMessage({
      prompt: message.prompt || '',
      page: message.page || null,
      selectionText: message.selectionText || '',
      source: message.source || 'workspace',
    });
  },

  async CLEAR_DIRECT_THREAD(message) {
    return {
      ok: true,
      thread: await operations.clearDirectThread(message.page || null, null),
    };
  },

  async GET_TRACKED_PAGES() {
    return {
      ok: true,
      trackedPages: await storageApi.getTrackedPageViews(),
    };
  },

  async SAVE_CONFIG(message) {
    await storageApi.setConfig(message.config || {});
    return {
      ok: true,
      ...(await messageGetStatus()),
    };
  },

  async GET_RECENTS() {
    return {
      ok: true,
      recentActions: await storageApi.getRecentActions(),
    };
  },

  async GET_LIVE_TIMELINE(message) {
    const { config } = await getRuntimeConfig({ ensureReachable: true });
    const sessionId = message.sessionId || liveStreamState.sessionId || '';
    const events = await storageApi.getLiveEvents(sessionId);
    return {
      ok: true,
      stream: {
        sessionId,
        status: liveStreamState.status,
        error: liveStreamState.error,
      },
      summary: summarizeLiveTimeline(events),
      events,
      config: {
        baseUrl: config.baseUrl,
      },
    };
  },

  async POST_BROWSER_CONTEXT_EVENT(message) {
    const { config } = await getRuntimeConfig({ ensureReachable: true });
    const liveSession = await hermesClient.getCurrentLiveSession(config);
    const sessionId = message.sessionId || liveSession?.session?.session_id || '';
    if (!sessionId) {
      throw new Error('No live Hermes session is attached.');
    }
    const current = await operations.getCurrentPageContext(message.page || null, null);
    if (!current.page) {
      throw new Error('No active page available.');
    }
    const posted = await hermesClient.postLiveBrowserEvent(config, {
      sessionId,
      type: 'browser.context',
      payload: {
        source: message.source || 'extension',
        page: current.page,
      },
    });
    if (posted?.event) {
      await storageApi.pushLiveEvents([posted.event]);
    }
    return {
      ok: true,
      event: posted.event,
      page: current.page,
    };
  },

  async RESOLVE_LIVE_APPROVAL(message) {
    const { config } = await getRuntimeConfig({ ensureReachable: true });
    const sessionId = message.sessionId || liveStreamState.sessionId || '';
    const approvalId = message.approvalId || message.approval_id || '';
    const decision = message.decision === 'approved' ? 'approved' : 'denied';
    const action = message.action && typeof message.action === 'object' ? message.action : {};
    let actionResult = null;

    if (!sessionId || !approvalId) {
      throw new Error('Missing live session or approval ID.');
    }

    if (decision === 'approved') {
      try {
        const activeTab = await pageContextApi.getActiveTab();
        if (!activeTab?.id) {
          throw new Error('No active tab available for the approved browser action.');
        }
        actionResult = await pageContextApi.executeApprovedBrowserAction(activeTab.id, action);
        const posted = await hermesClient.postLiveBrowserResult(config, {
          sessionId,
          status: 'ok',
          commandId: message.commandId || '',
          payload: {
            approval_id: approvalId,
            action,
            result: actionResult,
          },
        });
        if (posted?.event) {
          await storageApi.pushLiveEvents([posted.event]);
        }
      } catch (error) {
        actionResult = {
          ok: false,
          error: error.message || String(error),
        };
        const posted = await hermesClient.postLiveBrowserResult(config, {
          sessionId,
          status: 'failed',
          commandId: message.commandId || '',
          payload: {
            approval_id: approvalId,
            action,
            result: actionResult,
          },
        });
        if (posted?.event) {
          await storageApi.pushLiveEvents([posted.event]);
        }
      }
    }

    const resolved = await hermesClient.resolveLiveApproval(config, {
      sessionId,
      approvalId,
      decision,
      payload: {
        action,
        result: actionResult,
      },
    });
    if (resolved?.approval) {
      chrome.runtime.sendMessage({ type: 'LIVE_APPROVAL_RESOLVED', approval: resolved.approval }).catch(() => {});
    }
    return {
      ok: true,
      approval: resolved.approval,
      result: actionResult,
    };
  },

  async GET_RECENT_DETAIL(message) {
    const item = await storageApi.getRecentAction(message.id);
    return { ok: !!item, item };
  },

  async GET_WORKSPACE_STATE(message) {
    return {
      ok: true,
      workspaceState: await getWorkspaceState({
        url: message.url || '',
        useActivePage: Boolean(message.useActivePage),
      }),
    };
  },

  async SAVE_WORKSPACE_STATE(message) {
    return {
      ok: true,
      workspaceState: await setWorkspaceState(message.patch || {}, {
        url: message.url || '',
        useActivePage: Boolean(message.useActivePage),
      }),
    };
  },

  async SAVE_PAGE_NOTE(message) {
    return {
      ok: true,
      note: await storageApi.savePageNote(message.url || '', message.note || ''),
    };
  },

  async TRACK_PAGE(message) {
    return {
      ok: true,
      tracked: await storageApi.upsertTrackedPage(await requirePage(message.page || null), message.pinned !== false),
    };
  },

  async WATCH_PAGE(message) {
    const page = message.page?.url ? message.page : await requirePage(message.page || null);
    const tracked = await storageApi.upsertTrackedPage(page, true);
    const updated = await storageApi.updateTrackedPage(tracked.url, {
      watchEnabled: true,
      watchIntervalMinutes: Math.max(15, Number(message.intervalMinutes || 60)),
      lastWatchStatus: 'watching',
    });
    await ensureWatcherAlarm();
    return {
      ok: true,
      tracked: updated,
    };
  },

  async UNWATCH_PAGE(message) {
    const url = message.url || message.page?.url || '';
    const updated = await storageApi.updateTrackedPage(url, {
      watchEnabled: false,
      lastWatchStatus: 'paused',
    });
    await ensureWatcherAlarm();
    return {
      ok: true,
      tracked: updated,
    };
  },

  async UNTRACK_PAGE(message) {
    return {
      ok: true,
      ...(await storageApi.removeTrackedPage(message.url || '')),
    };
  },

  async UPDATE_TRACKED_PAGE(message) {
    return {
      ok: true,
      tracked: await storageApi.updateTrackedPage(message.url || '', message.patch || {}),
    };
  },

  async ASK_PAGE(message) {
    return {
      ok: true,
      ...(await operations.runWorkflow({
        mode: message.mode || 'ask',
        prompt: message.prompt || '',
        target: 'generic',
      })),
    };
  },

  async RUN_WORKFLOW(message) {
    return {
      ok: true,
      ...(await operations.runWorkflow({
        mode: message.mode || 'ask',
        prompt: message.prompt || '',
        target: message.target || 'generic',
        page: message.page || null,
        title: message.title || '',
        url: message.url || '',
      })),
    };
  },

  async RUN_MEMORY_ACTION(message) {
    return {
      ok: true,
      ...(await operations.runMemoryAction({
        kind: message.kind || 'fact',
        note: message.note || '',
        page: message.page || null,
      })),
    };
  },

  async CAPTURE_PAGE() {
    return {
      ok: true,
      ...(await operations.capturePageToHermes()),
    };
  },

  async BUILD_CONTEXT(message) {
    return {
      ok: true,
      ...(await operations.buildInjectableContext(message.prompt || '', message.target || 'auto')),
    };
  },

  async INSERT_LATEST_CONTEXT() {
    return {
      ok: true,
      ...(await operations.insertLatestContext()),
    };
  },

  async ALLOW_CURRENT_AI_HOST() {
    const activeTab = await pageContextApi.getActiveTab();
    await requestSitePermission(activeTab?.url || '');
    return {
      ok: true,
      ...(await operations.addCustomAssistantHost(activeTab?.url || '')),
    };
  },

  async SAVE_PAGE_SNAPSHOT(message) {
    return {
      ok: true,
      ...(await storageApi.saveSnapshot(await requirePage(message.page || null), message.source || 'workspace')),
    };
  },

  async COMPARE_WITH_SNAPSHOT(message) {
    return {
      ok: true,
      ...(await operations.compareWithLatestSnapshot(message.page || null, message.note || '')),
    };
  },

  async INJECT_CONTEXT(message) {
    return {
      ok: true,
      result: await operations.injectIntoActiveTab(message.text || ''),
    };
  },

  async OPEN_OUTPUT_TAB(message) {
    await operations.openContextResult(message.text || '', message.label || 'Hermes Relay for Chrome');
    return { ok: true };
  },

  async OPEN_SIDE_PANEL() {
    return operations.openSidePanel();
  },

  async OPEN_TRACKED_PAGE(message) {
    await chrome.tabs.create({ url: message.url });
    return { ok: true };
  },
};

chrome.runtime.onInstalled.addListener(() => {
  scheduleInitialization();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleInitialization();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready;

  try {
    if (info.menuItemId === CONTEXT_MENU_IDS.askSelection && info.selectionText) {
      const result = await operations.sendDirectLineMessage({
        tab,
        selectionText: info.selectionText.trim(),
        prompt: 'Focus on this selection and tell me what matters.',
        source: 'context-selection',
      });
      await setWorkspaceState({
        output: result.text || '',
        lastAction: 'selection-explain',
        source: 'context-menu',
      }, { url: tab?.url || '' });
      await operations.openSidePanel();
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.rememberSelection && info.selectionText) {
      const result = await operations.sendDirectLineMessage({
        tab,
        selectionText: info.selectionText.trim(),
        prompt: 'Look at this selection, decide what should be remembered, and tell me what to do next.',
        source: 'context-remember',
      });
      await setWorkspaceState({
        output: result.text || '',
        lastAction: 'selection-memory',
        source: 'context-menu',
      }, { url: tab?.url || '' });
      await operations.openSidePanel();
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.sendPage) {
      const result = await operations.sendDirectLineMessage({
        tab,
        prompt: 'Take in this whole page and tell me what matters and what I should do next.',
        source: 'context-page',
      });
      await setWorkspaceState({
        output: result.text || '',
        lastAction: 'page-direct-line',
        source: 'context-menu',
      }, { url: tab?.url || '' });
      await operations.openSidePanel();
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.injectContext) {
      const result = await operations.insertLatestContext();
      await setWorkspaceState({
        output: result.text || '',
        lastAction: 'insert-latest-context',
        source: 'context-menu',
      }, { url: tab?.url || '' });
    }
  } catch (error) {
    await setWorkspaceState({
      output: error.message || String(error),
      lastAction: 'error',
      source: 'context-menu',
    }, { url: tab?.url || '' });
    await operations.openSidePanel();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  await ready;

  try {
    if (command === 'capture-page') {
      const result = await operations.capturePageToHermes();
      await operations.openContextResult(result.text, 'Hermes page capture');
      return;
    }

    if (command === 'build-context') {
      const result = await operations.buildInjectableContext('Continue from the current page and focused task.', 'auto');
      await operations.openContextResult(result.text, 'Hermes context bundle');
      return;
    }

    if (command === 'inject-context') {
      await operations.insertLatestContext();
    }
  } catch (error) {
    await setWorkspaceState({
      output: error.message || String(error),
      lastAction: 'error',
      source: 'command',
    }, { useActivePage: true });
  }
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== WATCH_ALARM_NAME) return;
    runPageWatchers().catch((error) => {
      console.error('Hermes Relay watcher failed.', error);
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ready;

    const handler = messageHandlers[message?.type];
    if (!handler) {
      sendResponse({ ok: false, error: 'Unknown message type.' });
      return;
    }

    sendResponse(await handler(message));
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error.message || String(error),
    });
  });

  return true;
});

refreshReady();
