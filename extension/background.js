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
  return {
    health,
    preflight,
    liveSession,
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
