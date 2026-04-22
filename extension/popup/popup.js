'use strict';

const $ = (id) => document.getElementById(id);
let latestSetupText = '';

function setOutput(text) {
  $('output').textContent = text || 'No output yet.';
}

function setPageActionAvailability(enabled) {
  ['summarize-page', 'ask-page', 'build-context'].forEach((id) => {
    const button = $(id);
    if (button) {
      button.disabled = !enabled;
    }
  });
  $('ask-prompt').disabled = !enabled;
}

function relativeTime(iso) {
  if (!iso) return 'just now';
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.round(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function setBusy(buttonId, label, busy) {
  const button = $(buttonId);
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function getEffectiveBaseUrl(health = {}, config = {}) {
  return health.detectedBaseUrl || health.baseUrl || config.baseUrl || 'http://127.0.0.1:8642';
}

function getPreflightState(payload = {}) {
  const preflight = payload.preflight || {};
  const health = payload.health || {};
  const config = payload.config || {};
  const hasApiKey = Boolean(String(config.apiKey || '').trim());
  const authVerified = Boolean(health.ok && preflight.ok);
  const keyNeedsAttention = Boolean(
    (health.authRequired && hasApiKey)
      || preflight.status === 'invalid-api-key',
  );
  const connectionNeedsAttention = Boolean(
    preflight.ran
      && !preflight.ok
      && !keyNeedsAttention,
  );

  return {
    preflight,
    authVerified,
    keyNeedsAttention,
    connectionNeedsAttention,
  };
}

function deriveSetupState(payload = {}, pageResponse = {}) {
  const health = payload.health || {};
  const config = payload.config || {};
  const { preflight, authVerified, keyNeedsAttention, connectionNeedsAttention } = getPreflightState(payload);
  const hasApiKey = Boolean(String(config.apiKey || '').trim());
  const effectiveBaseUrl = getEffectiveBaseUrl(health, config);
  const serverReady = Boolean(health.ok || health.authRequired);
  const serverReachable = Boolean(serverReady || health.reachable);
  const pageReady = Boolean(pageResponse?.ok);
  const ready = Boolean(health.ok && hasApiKey && authVerified);
  const keyPlaceholder = hasApiKey ? '[saved-local-key]' : '[your-local-key]';

  if (!serverReachable) {
    return {
      hasApiKey,
      serverReady,
      serverReachable,
      pageReady,
      keyNeedsAttention,
      ready,
      effectiveBaseUrl,
      summary: 'Start Hermes locally, then paste your API key once.',
      commandText: [
        'Add to ~/.hermes/.env:',
        'API_SERVER_ENABLED=true',
        `API_SERVER_KEY=${keyPlaceholder}`,
        '',
        'Then run:',
        'hermes gateway',
      ].join('\n'),
    };
  }

  if (!serverReady) {
    return {
      hasApiKey,
      serverReady,
      serverReachable,
      pageReady,
      keyNeedsAttention,
      ready,
      effectiveBaseUrl,
      summary: health.message || `Hermes responded at ${effectiveBaseUrl}, but it is not ready yet.`,
      commandText: [
        `Hermes responded at ${effectiveBaseUrl}.`,
        '',
        health.message || 'Hermes needs attention before the relay can use it.',
        '',
        'Check the Hermes logs, then refresh or click Save & Test again.',
      ].join('\n'),
    };
  }

  if (!hasApiKey) {
    return {
      hasApiKey,
      serverReady,
      serverReachable,
      pageReady,
      keyNeedsAttention,
      ready,
      effectiveBaseUrl,
      summary: `Hermes is running at ${effectiveBaseUrl}. Paste your API key once to finish setup.`,
      commandText: [
        `Hermes detected at ${effectiveBaseUrl}.`,
        '',
        'Next:',
        '1. Paste the API key from ~/.hermes/.env into this popup',
        '2. Click Save & Test',
      ].join('\n'),
    };
  }

  if (keyNeedsAttention) {
    return {
      hasApiKey,
      serverReady,
      serverReachable,
      pageReady,
      keyNeedsAttention,
      ready,
      effectiveBaseUrl,
      summary: preflight.message || 'Hermes responded, but the saved API key needs attention.',
      commandText: [
        `Hermes detected at ${effectiveBaseUrl}.`,
        '',
        'Check ~/.hermes/.env:',
        'API_SERVER_ENABLED=true',
        `API_SERVER_KEY=${keyPlaceholder}`,
        '',
        'Then click Save & Test again.',
      ].join('\n'),
    };
  }

  if (connectionNeedsAttention) {
    return {
      hasApiKey,
      serverReady,
      serverReachable,
      pageReady,
      keyNeedsAttention,
      ready,
      effectiveBaseUrl,
      summary: preflight.message || 'Hermes is up, but authenticated requests still need attention.',
      commandText: [
        `Hermes detected at ${effectiveBaseUrl}.`,
        '',
        preflight.message || 'Authenticated requests are failing even though Hermes is reachable.',
        '',
        'Refresh after Hermes is ready, or save your settings again if the server changed.',
      ].join('\n'),
    };
  }

  if (!pageReady) {
    return {
      hasApiKey,
      serverReady,
      serverReachable,
      pageReady,
      keyNeedsAttention,
      ready,
      effectiveBaseUrl,
      summary: 'Hermes Relay is connected. Open a normal website tab to start using it.',
      commandText: [
        `Connected at ${effectiveBaseUrl}.`,
        '',
        'Next:',
        '1. Open any article, app page, or thread',
        '2. Come back here and click Summarize Page or Ask Hermes',
      ].join('\n'),
    };
  }

  return {
    hasApiKey,
    serverReady,
    serverReachable,
    pageReady,
    keyNeedsAttention,
    ready,
    effectiveBaseUrl,
    summary: 'Hermes Relay is ready. Summarize, ask, or build context from this page.',
    commandText: [
      `Connected at ${effectiveBaseUrl}.`,
      '',
      'Good first run:',
      '1. Click Summarize Page',
      '2. Open the Workspace for notes, snapshots, and continuity',
      '3. Build Context, then Insert Latest in Claude, ChatGPT, or Gemini',
    ].join('\n'),
  };
}

function renderStatus(payload) {
  const health = payload.health || {};
  const config = payload.config || {};
  const { preflight, authVerified, keyNeedsAttention, connectionNeedsAttention } = getPreflightState(payload);
  const hasApiKey = Boolean(String(config.apiKey || '').trim());
  const serverReady = Boolean(health.ok || health.authRequired);
  const serverReachable = Boolean(serverReady || health.reachable);
  const effectiveBaseUrl = getEffectiveBaseUrl(health, config);

  $('base-url').value = effectiveBaseUrl;
  $('api-key').value = config.apiKey || '';
  $('conversation-prefix').value = config.conversationPrefix || 'hermes-relay';

  const dot = $('status-dot');
  dot.classList.remove('ok', 'offline');
  dot.classList.add(serverReady ? 'ok' : 'offline');

  if (health.ok && hasApiKey && authVerified) {
    $('status-label').textContent = 'Connected to Hermes';
    $('status-meta').textContent = `Ready at ${effectiveBaseUrl}. ${preflight.message || 'Authenticated API access verified.'}`;
    return;
  }

  if (keyNeedsAttention) {
    $('status-label').textContent = 'Hermes needs the right API key';
    $('status-meta').textContent = preflight.message || `Hermes responded at ${effectiveBaseUrl}. Save the correct key and test again.`;
    return;
  }

  if (serverReachable && !hasApiKey) {
    $('status-label').textContent = 'Hermes found locally';
    $('status-meta').textContent = `Detected at ${effectiveBaseUrl}. Paste your API key once to finish setup.`;
    return;
  }

  if (connectionNeedsAttention) {
    $('status-label').textContent = 'Hermes needs authenticated access';
    $('status-meta').textContent = preflight.message || `Hermes responded at ${effectiveBaseUrl}, but authenticated requests are still failing.`;
    return;
  }

  if (health.reachable) {
    $('status-label').textContent = 'Hermes needs attention';
    $('status-meta').textContent = health.message || `Hermes responded at ${effectiveBaseUrl}.`;
    return;
  }

  if (hasApiKey) {
    $('status-label').textContent = 'Start Hermes locally';
    $('status-meta').textContent = 'Run hermes gateway, then refresh or Save & Test again.';
    return;
  }

  $('status-label').textContent = 'Hermes not running yet';
  $('status-meta').textContent = 'Enable the Hermes API server, run hermes gateway, then paste your API key.';
}

function setSetupStep(id, state, text) {
  const step = $(id);
  if (!step) return;
  step.classList.remove('done', 'current', 'warning', 'todo');
  step.classList.add(state);
  const meta = step.querySelector('.setup-meta');
  if (meta) {
    meta.textContent = text;
  }
}

function renderSetupGuide(payload, pageResponse) {
  const setup = deriveSetupState(payload, pageResponse);
  latestSetupText = setup.commandText;

  $('setup-summary').textContent = setup.summary;
  $('setup-command').textContent = setup.commandText;

  if (setup.serverReady) {
    setSetupStep('setup-step-server', 'done', `Hermes detected at ${setup.effectiveBaseUrl}.`);
  } else if (setup.serverReachable) {
    setSetupStep('setup-step-server', 'warning', payload?.health?.message || 'Hermes responded, but it is not ready yet.');
  } else {
    setSetupStep('setup-step-server', 'current', 'Enable the Hermes API server and run hermes gateway.');
  }

  if (!setup.hasApiKey) {
    setSetupStep(
      'setup-step-key',
      setup.serverReachable ? 'current' : 'todo',
      'Paste the same API key from ~/.hermes/.env into this popup.',
    );
  } else if (setup.keyNeedsAttention) {
    setSetupStep('setup-step-key', 'warning', 'The saved API key needs attention. Save the correct key and test again.');
  } else {
    setSetupStep('setup-step-key', 'done', 'API key saved in Hermes Relay.');
  }

  if (setup.pageReady) {
    setSetupStep('setup-step-page', 'done', 'This page is ready for Summarize, Ask Hermes, and Build Context.');
  } else {
    setSetupStep(
      'setup-step-page',
      setup.ready ? 'current' : 'todo',
      'Open a normal website tab, then click Summarize Page or Ask Hermes.',
    );
  }

  return setup;
}

function renderConfigSource(payload) {
  const health = payload.health || {};
  const config = payload.config || {};
  const localDevConfig = payload.localDevConfig || null;
  const effectiveBaseUrl = getEffectiveBaseUrl(health, config);

  if (localDevConfig?.source) {
    $('config-source-label').textContent = 'Auto-connected from ~/.hermes/.env';
    $('config-source-detail').textContent = [
      localDevConfig.generatedAt ? `Synced ${relativeTime(localDevConfig.generatedAt)}` : 'Synced by the local setup helper',
      `Base URL ${effectiveBaseUrl}`,
    ].join(' · ');
    return;
  }

  $('config-source-label').textContent = 'Using saved popup settings';
  $('config-source-detail').textContent = `Saved in this browser · Base URL ${effectiveBaseUrl}`;
}

function renderPage(response, readyToUse = false) {
  if (!response?.ok) {
    setPageActionAvailability(false);
    $('page-title').textContent = 'No active page found';
    $('page-meta').textContent = 'Open a normal website tab to use Hermes Relay.';
    $('page-continuity').textContent = response?.error || 'Hermes could not inspect the active tab.';
    $('page-continuity').classList.remove('seen');
    $('page-continuity').classList.add('new');
    return;
  }

  setPageActionAvailability(Boolean(readyToUse));
  const { page, tab, continuity } = response;
  $('page-title').textContent = page?.title || tab?.title || 'Untitled page';
  $('page-meta').textContent = [page?.hostname, page?.pageType, page?.url].filter(Boolean).join(' · ');
  $('page-continuity').innerHTML = escapeHtml(continuity?.message || 'Hermes has not seen this page yet.');
  $('page-continuity').classList.toggle('seen', Boolean(continuity?.seenBefore));
  $('page-continuity').classList.toggle('new', !continuity?.seenBefore);
}

function renderHandoff(response) {
  const handoff = response?.handoff || {};
  const insertButton = $('insert-latest');
  const allowButton = $('allow-current-host');
  const canInsert = Boolean(handoff.available && handoff.canInsertHere);
  if (insertButton) {
    insertButton.disabled = !canInsert;
  }
  if (allowButton) {
    allowButton.hidden = !handoff.canAllowCurrentHost;
    allowButton.textContent = handoff.activeHostname
      ? `Allow ${handoff.activeHostname}`
      : 'Allow This AI Site';
  }

  if (!handoff.available) {
    $('handoff-status').textContent = handoff.canAllowCurrentHost
      ? `Hermes can route into ${handoff.activeHostname}. Allow this host first, then build context from a page.`
      : 'Build context from a page before inserting it into a chat.';
    return;
  }

  if (handoff.canAllowCurrentHost) {
    $('handoff-status').textContent = `Latest context is ready. Allow ${handoff.activeHostname} to route Hermes into this site.`;
    return;
  }

  if (!handoff.canInsertHere) {
    $('handoff-status').textContent = `Latest context ready from ${handoff.title || 'a recent page'}. Switch to a supported or allowed AI chat to insert it.`;
    return;
  }

  $('handoff-status').textContent = `Latest context ready from ${handoff.title || 'a recent page'} · ${relativeTime(handoff.timestamp)}`;
}

async function refreshAll() {
  const [status, page, handoff] = await Promise.all([
    sendMessage({ type: 'GET_STATUS' }),
    sendMessage({ type: 'GET_ACTIVE_PAGE_CONTEXT' }),
    sendMessage({ type: 'GET_HANDOFF_STATUS' }),
  ]);
  const workspace = await sendMessage({
    type: 'GET_WORKSPACE_STATE',
    url: page?.page?.url || page?.tab?.url || '',
    useActivePage: !page?.page?.url && !page?.tab?.url,
  });
  renderStatus(status);
  renderConfigSource(status);
  const setup = renderSetupGuide(status, page);
  renderPage(page, setup.ready);
  renderHandoff(handoff);
  $('ask-prompt').value = workspace.workspaceState?.prompt || '';
  setOutput(workspace.workspaceState?.output || 'Hermes responses will appear here.');
}

async function openWorkspace() {
  await sendMessage({ type: 'OPEN_SIDE_PANEL' });
}

async function saveWorkspacePatch(patch) {
  await sendMessage({
    type: 'SAVE_WORKSPACE_STATE',
    patch,
    useActivePage: true,
  });
}

async function runAction(buttonId, busyLabel, fn) {
  setBusy(buttonId, busyLabel, true);
  try {
    const result = await fn();
    if (!result.ok) {
      throw new Error(result.error || 'Hermes request failed.');
    }
    return result;
  } catch (error) {
    setOutput(error.message || String(error));
    await saveWorkspacePatch({ output: error.message || String(error), lastAction: 'error' });
    return null;
  } finally {
    setBusy(buttonId, busyLabel, false);
  }
}

$('save-config').addEventListener('click', async () => {
  const response = await sendMessage({
    type: 'SAVE_CONFIG',
    config: {
      baseUrl: $('base-url').value.trim(),
      apiKey: $('api-key').value.trim(),
      conversationPrefix: $('conversation-prefix').value.trim() || 'hermes-relay',
    },
  });

  if (!response.ok) {
    setOutput(response.error || 'Could not save config.');
    return;
  }

  setOutput('Saved. Trying Hermes now…');
  await refreshAll();
});

$('refresh-status').addEventListener('click', refreshAll);
$('open-workspace').addEventListener('click', openWorkspace);
$('open-workspace-cta').addEventListener('click', openWorkspace);
$('allow-current-host').addEventListener('click', async () => {
  const response = await sendMessage({ type: 'ALLOW_CURRENT_AI_HOST' });
  if (!response.ok) {
    setOutput(response.error || 'Could not allow this host.');
    return;
  }

  setOutput(`Allowed ${response.hostname} as a custom AI host for Hermes routing.`);
  await refreshAll();
});
$('copy-setup').addEventListener('click', async () => {
  const baseUrl = $('base-url').value.trim() || 'http://127.0.0.1:8642';
  const text = [
    'Hermes Relay local setup',
    '',
    '1. Add to ~/.hermes/.env:',
    'API_SERVER_ENABLED=true',
    'API_SERVER_KEY=[your-local-key]',
    '',
    '2. Start Hermes:',
    'hermes gateway',
    '',
    '3. In the Hermes Relay popup:',
    `Base URL: ${baseUrl}`,
    'API key: paste the same value from ~/.hermes/.env',
    '',
    latestSetupText,
  ].filter(Boolean).join('\n');

  await navigator.clipboard.writeText(text);
  setOutput('Copied safe Hermes setup steps to the clipboard.');
});

$('ask-prompt').addEventListener('input', async () => {
  await saveWorkspacePatch({ prompt: $('ask-prompt').value });
});

$('summarize-page').addEventListener('click', async () => {
  const prompt = $('ask-prompt').value.trim();
  const result = await runAction('summarize-page', 'Summarizing…', () => sendMessage({
    type: 'RUN_WORKFLOW',
    mode: 'summarize',
    prompt,
    target: 'generic',
  }));
  if (!result) return;
  setOutput(result.text || 'Done.');
  await saveWorkspacePatch({
    prompt,
    output: result.text || '',
    mode: 'summarize',
    lastAction: 'popup-summarize',
    source: 'popup',
  });
  await openWorkspace();
});

$('ask-page').addEventListener('click', async () => {
  const prompt = $('ask-prompt').value.trim();
  const result = await runAction('ask-page', 'Asking…', () => sendMessage({
    type: 'RUN_WORKFLOW',
    mode: 'ask',
    prompt,
    target: 'generic',
  }));
  if (!result) return;
  setOutput(result.text || 'Done.');
  await saveWorkspacePatch({
    prompt,
    output: result.text || '',
    mode: 'ask',
    lastAction: 'popup-ask',
    source: 'popup',
  });
  await openWorkspace();
});

$('build-context').addEventListener('click', async () => {
  const prompt = $('ask-prompt').value.trim();
  const built = await runAction('build-context', 'Building…', () => sendMessage({
    type: 'BUILD_CONTEXT',
    prompt,
    target: 'auto',
  }));
  if (!built) return;
  setOutput(built.text || 'Done.');
  await saveWorkspacePatch({
    prompt,
    output: built.text || '',
    mode: 'inject',
    target: built.target || 'auto',
    lastAction: 'popup-build-context',
    source: 'popup',
  });
  await refreshAll();
});

$('insert-latest').addEventListener('click', async () => {
  const inserted = await runAction('insert-latest', 'Inserting…', () => sendMessage({
    type: 'INSERT_LATEST_CONTEXT',
  }));
  if (!inserted) return;

  const finalText = `${inserted.text || ''}\n\n[Inserted latest context into active chat]`;
  setOutput(finalText);
  await saveWorkspacePatch({
    prompt: $('ask-prompt').value.trim(),
    output: finalText,
    mode: 'inject',
    lastAction: 'popup-insert-latest-context',
    source: 'popup',
  });
  await refreshAll();
});

$('copy-output').addEventListener('click', async () => {
  const text = $('output').textContent || '';
  await navigator.clipboard.writeText(text);
  setOutput(`${text}\n\n[Copied to clipboard]`);
});

refreshAll().catch((error) => {
  setOutput(error.message || String(error));
});
