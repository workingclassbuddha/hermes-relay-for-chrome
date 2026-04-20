'use strict';

const $ = (id) => document.getElementById(id);

let lastBuiltContext = '';
let selectedMode = 'ask';
let selectedTarget = 'auto';

function relativeTime(iso) {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.round(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function setOutput(text) {
  $('output').textContent = text || 'No output.';
}

function setActiveChip(selector, value, attr) {
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle('active', button.dataset[attr] === value);
  });
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

function renderStatus(payload) {
  const health = payload.health || {};
  const config = payload.config || {};

  $('base-url').value = config.baseUrl || '';
  $('api-key').value = config.apiKey || '';
  $('conversation-prefix').value = config.conversationPrefix || 'hermes-relay';

  const dot = $('status-dot');
  dot.classList.remove('ok', 'offline');
  dot.classList.add(health.ok ? 'ok' : 'offline');
  $('status-label').textContent = health.ok ? 'Connected to Hermes' : 'Not connected yet';
  $('status-meta').textContent = health.ok
    ? `Ready at ${health.baseUrl || config.baseUrl}`
    : (config.apiKey
      ? 'Hermes was not reachable on your machine. Try opening Hermes, then refresh.'
      : 'Paste your Hermes API key once, then connect.');
}

function renderRecent(recentActions) {
  const root = $('recent-list');
  if (!recentActions.length) {
    root.innerHTML = '<div class="recent-empty">No Hermes actions yet.</div>';
    return;
  }

  root.innerHTML = recentActions.map((item) => `
    <article class="recent-item" data-recent-id="${item.id}">
      <div class="recent-top">
        <span class="recent-type">${item.type.replace(/-/g, ' ')}</span>
        <span class="recent-time">${relativeTime(item.timestamp)}</span>
      </div>
      <div class="recent-title">${escapeHtml(item.title || 'Hermes action')}</div>
      <div class="recent-summary">${escapeHtml(item.summary || '')}</div>
      <div class="recent-actions">
        <button class="recent-btn" data-action="use">Use</button>
        <button class="recent-btn" data-action="copy">Copy</button>
      </div>
    </article>
  `).join('');
}

function renderWatchlist(trackedPages) {
  const root = $('watchlist');
  if (!trackedPages.length) {
    root.innerHTML = '<div class="recent-empty">No tracked pages yet.</div>';
    return;
  }

  root.innerHTML = trackedPages.slice(0, 4).map((item) => `
    <article class="recent-item" data-watch-url="${item.url}">
      <div class="recent-top">
        <span class="recent-type">${item.pinned ? 'pinned' : 'tracked'}</span>
        <span class="recent-time">${relativeTime(item.lastSeenAt || item.createdAt)}</span>
      </div>
      <div class="recent-title">${escapeHtml(item.title || item.url)}</div>
      <div class="recent-meta">${escapeHtml([item.hostname, item.pageType].filter(Boolean).join(' · '))}</div>
      <div class="recent-summary">${escapeHtml(item.notePreview || `${item.snapshotCount || 0} snapshot${item.snapshotCount === 1 ? '' : 's'}`)}</div>
      <div class="recent-actions">
        <button class="recent-btn" data-action="open-watch">Open</button>
        <button class="recent-btn" data-action="toggle-watch-pin">${item.pinned ? 'Unpin' : 'Pin'}</button>
      </div>
    </article>
  `).join('');
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

async function refreshAll() {
  const status = await sendMessage({ type: 'GET_STATUS' });
  renderStatus(status);
  const [recents, tracked] = await Promise.all([
    sendMessage({ type: 'GET_RECENTS' }),
    sendMessage({ type: 'GET_TRACKED_PAGES' }),
  ]);
  renderRecent(recents.recentActions || []);
  renderWatchlist(tracked.trackedPages || []);
}

async function runAction(buttonId, busyLabel, fn) {
  setBusy(buttonId, busyLabel, true);
  try {
    const result = await fn();
    if (!result.ok) {
      throw new Error(result.error || 'Hermes request failed.');
    }
    setOutput(result.text || 'Done.');
    await refreshAll();
    return result;
  } catch (error) {
    setOutput(error.message || String(error));
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

$('open-workspace').addEventListener('click', async () => {
  await sendMessage({ type: 'OPEN_SIDE_PANEL' });
});

document.querySelectorAll('.mode-chip').forEach((button) => {
  button.addEventListener('click', () => {
    selectedMode = button.dataset.mode;
    setActiveChip('.mode-chip', selectedMode, 'mode');
  });
});

document.querySelectorAll('.target-chip').forEach((button) => {
  button.addEventListener('click', () => {
    selectedTarget = button.dataset.target;
    setActiveChip('.target-chip', selectedTarget, 'target');
  });
});

$('ask-page').addEventListener('click', async () => {
  const prompt = $('ask-prompt').value.trim();
  await runAction('ask-page', 'Asking…', () => sendMessage({
    type: 'ASK_PAGE',
    prompt,
    mode: selectedMode,
  }));
});

$('capture-page').addEventListener('click', async () => {
  await runAction('capture-page', 'Capturing…', () => sendMessage({
    type: 'CAPTURE_PAGE',
  }));
});

$('build-context').addEventListener('click', async () => {
  const prompt = $('ask-prompt').value.trim();
  const result = await runAction('build-context', 'Building…', () => sendMessage({
    type: 'BUILD_CONTEXT',
    prompt,
    target: selectedTarget,
  }));
  if (result) {
    lastBuiltContext = result.text || '';
  }
});

$('inject-context').addEventListener('click', async () => {
  let text = lastBuiltContext;
  if (!text) {
    const built = await runAction('build-context', 'Building…', () => sendMessage({
      type: 'BUILD_CONTEXT',
      prompt: $('ask-prompt').value.trim(),
      target: selectedTarget,
    }));
    if (!built) return;
    text = built.text || '';
    lastBuiltContext = text;
  }

  await runAction('inject-context', 'Injecting…', () => sendMessage({
    type: 'INJECT_CONTEXT',
    text,
  }));
});

$('copy-output').addEventListener('click', async () => {
  const text = $('output').textContent || '';
  await navigator.clipboard.writeText(text);
  setOutput(`${text}\n\n[Copied to clipboard]`);
});

$('open-output').addEventListener('click', async () => {
  await sendMessage({
    type: 'OPEN_OUTPUT_TAB',
    text: $('output').textContent || '',
    label: 'Hermes Relay output',
  });
});

$('recent-list').addEventListener('click', async (event) => {
  const button = event.target.closest('.recent-btn');
  const article = event.target.closest('.recent-item');
  if (!button || !article) return;

  const response = await sendMessage({
    type: 'GET_RECENT_DETAIL',
    id: article.dataset.recentId,
  });

  if (!response.ok || !response.item) return;
  const item = response.item;

  if (button.dataset.action === 'use') {
    setOutput(item.output || item.summary || '');
    if (item.type === 'build-context' || item.type === 'inject-context') {
      lastBuiltContext = item.output || '';
    }
  }

  if (button.dataset.action === 'copy') {
    await navigator.clipboard.writeText(item.output || item.summary || '');
    setOutput(`${item.output || item.summary || ''}\n\n[Copied from recents]`);
  }
});

$('watchlist').addEventListener('click', async (event) => {
  const button = event.target.closest('.recent-btn');
  const article = event.target.closest('.recent-item');
  if (!button || !article) return;

  if (button.dataset.action === 'open-watch') {
    await sendMessage({
      type: 'OPEN_TRACKED_PAGE',
      url: article.dataset.watchUrl,
    });
    return;
  }

  if (button.dataset.action === 'toggle-watch-pin') {
    const tracked = await sendMessage({ type: 'GET_TRACKED_PAGES' });
    const item = (tracked.trackedPages || []).find((entry) => entry.url === article.dataset.watchUrl);
    if (!item) return;
    await sendMessage({
      type: 'UPDATE_TRACKED_PAGE',
      url: item.url,
      patch: {
        pinned: !item.pinned,
      },
    });
    await refreshAll();
  }
});

refreshAll().catch((error) => {
  setOutput(error.message || String(error));
});
