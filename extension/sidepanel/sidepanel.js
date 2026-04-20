'use strict';

const $ = (id) => document.getElementById(id);

let currentMode = 'ask';
let currentPage = null;
let currentOutput = '';
let currentNote = '';
let currentContinuity = null;
let trackedItems = [];
let trackedSearch = '';
let trackedPinnedOnly = false;
let currentDirectThread = null;
let currentWorkspaceUrl = '';

function setWorkspaceDisabled(disabled) {
  [
    'track-page',
    'save-snapshot',
    'compare-snapshot',
    'refresh-direct',
    'clear-direct',
    'direct-prompt',
    'send-direct',
    'page-note',
    'save-note',
    'workspace-prompt',
    'workspace-target',
    'run-workflow',
    'inject-workflow',
  ].forEach((id) => {
    const element = $(id);
    if (element) {
      element.disabled = disabled;
    }
  });

  document.querySelectorAll('.workflow-btn, .memory-btn').forEach((button) => {
    button.disabled = disabled;
  });
}

function relativeTime(iso) {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.round(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function persistWorkspaceState(extra = {}) {
  sendMessage({
    type: 'SAVE_WORKSPACE_STATE',
    url: currentPage?.url || '',
    useActivePage: !currentPage?.url,
    patch: {
      prompt: $('workspace-prompt')?.value || '',
      directPrompt: $('direct-prompt')?.value || '',
      mode: currentMode,
      target: $('workspace-target')?.value || 'auto',
      output: currentOutput || '',
      trackedSearch,
      trackedPinnedOnly,
      ...extra,
    },
  }).catch(() => {});
}

function applyWorkspaceState(state = {}, { persist = false } = {}) {
  currentMode = state.mode || 'ask';
  trackedSearch = String(state.trackedSearch || '').trim().toLowerCase();
  trackedPinnedOnly = Boolean(state.trackedPinnedOnly);
  $('workspace-prompt').value = state.prompt || '';
  $('direct-prompt').value = state.directPrompt || '';
  $('workspace-target').value = state.target || 'auto';
  $('tracked-search').value = state.trackedSearch || '';
  $('tracked-filter-toggle').textContent = `Pinned Only: ${trackedPinnedOnly ? 'On' : 'Off'}`;
  setMode(currentMode, { persist });
  currentOutput = state.output || '';
  $('workspace-output').textContent = currentOutput || 'Hermes output will appear here.';
}

function setOutput(text) {
  currentOutput = text || '';
  $('workspace-output').textContent = currentOutput || 'Hermes output will appear here.';
  persistWorkspaceState();
}

function renderContinuity(continuity) {
  currentContinuity = continuity || null;
  const banner = $('page-continuity');
  const stats = $('page-memory-stats');
  const seen = Boolean(continuity?.seenBefore);
  banner.classList.toggle('seen', seen);
  banner.classList.toggle('new', !seen);
  banner.textContent = continuity?.message || 'Hermes has not seen this page yet.';

  const chips = [];
  if (continuity?.tracked) chips.push(continuity?.pinned ? 'Tracked + pinned' : 'Tracked');
  if (continuity?.noteCount) chips.push('Has note');
  if (continuity?.snapshotCount) chips.push(`${continuity.snapshotCount} snapshot${continuity.snapshotCount === 1 ? '' : 's'}`);
  if (continuity?.directMessageCount) chips.push(`${continuity.directMessageCount} direct message${continuity.directMessageCount === 1 ? '' : 's'}`);
  stats.innerHTML = chips.length
    ? chips.map((chip) => `<span class="tag">${escapeHtml(chip)}</span>`).join('')
    : '<span class="tag">New to Hermes</span>';
}

async function restoreWorkspaceState() {
  const response = await sendMessage({
    type: 'GET_WORKSPACE_STATE',
    url: currentPage?.url || '',
    useActivePage: !currentPage?.url,
  });
  applyWorkspaceState(response.workspaceState || {}, { persist: false });
}

function renderDirectThread(thread) {
  currentDirectThread = thread || null;
  const root = $('direct-thread');
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) {
    root.innerHTML = '<div class="history-empty">Ask Hermes about this page or use the right-click menu.</div>';
    return;
  }

  root.innerHTML = messages.map((message) => `
    <article class="direct-message ${message.role === 'user' ? 'user' : 'assistant'}">
      <div class="direct-meta">
        <span>${message.role === 'user' ? 'You' : 'Hermes'}</span>
        <span>${relativeTime(message.timestamp)}</span>
      </div>
      <div class="direct-text">${escapeHtml(message.text || '')}</div>
    </article>
  `).join('');
  root.scrollTop = root.scrollHeight;
}

function renderPage(page, tab, note, continuity) {
  setWorkspaceDisabled(false);
  currentPage = page;
  currentNote = note?.text || '';
  currentContinuity = continuity || null;
  $('page-title').textContent = page?.title || tab?.title || 'Untitled page';
  $('page-meta').textContent = [page?.hostname, page?.pageType, page?.url].filter(Boolean).join(' · ');
  $('page-note').value = currentNote;
  $('track-page').textContent = continuity?.tracked ? 'Tracked' : 'Track Page';
  const headings = Array.isArray(page?.headings) ? page.headings : [];
  $('page-headings').innerHTML = headings.length
    ? headings.slice(0, 6).map((heading) => `<span class="tag">${escapeHtml(heading)}</span>`).join('')
    : '<span class="tag">No headings found</span>';
  renderContinuity(continuity);
}

function renderUnavailablePage(message) {
  setWorkspaceDisabled(true);
  currentPage = null;
  currentNote = '';
  currentContinuity = null;
  currentDirectThread = null;
  currentWorkspaceUrl = '';
  $('page-title').textContent = 'This page is unavailable to Hermes Relay';
  $('page-meta').textContent = 'Switch to a normal website tab to use the workspace.';
  $('page-continuity').classList.remove('seen');
  $('page-continuity').classList.add('new');
  $('page-continuity').textContent = message || 'Hermes Relay could not inspect the active tab.';
  $('page-memory-stats').innerHTML = '<span class="tag">Browser-internal page</span>';
  $('page-headings').innerHTML = '<span class="tag">No page context available</span>';
  $('page-note').value = '';
  $('track-page').textContent = 'Track Page';
  $('direct-thread').innerHTML = '<div class="history-empty">Open a normal web page to use the Hermes direct line.</div>';
  $('snapshot-list').innerHTML = '<div class="history-empty">Snapshots are only available for normal web pages.</div>';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHistory(items) {
  const root = $('workspace-history');
  if (!items.length) {
    root.innerHTML = '<div class="history-empty">No workspace runs yet.</div>';
    return;
  }

  root.innerHTML = items.map((item) => `
    <article class="history-item" data-id="${item.id}">
      <div class="history-top">
        <span class="history-type">${escapeHtml(item.type.replace(/-/g, ' '))}</span>
        <span class="history-time">${relativeTime(item.timestamp)}</span>
      </div>
      <div class="history-title">${escapeHtml(item.title || 'Hermes action')}</div>
      <div class="history-summary">${escapeHtml(item.summary || '')}</div>
      <div class="history-actions">
        <button class="history-btn" data-action="use">Use</button>
        <button class="history-btn" data-action="open">Open</button>
      </div>
    </article>
  `).join('');
}

async function refreshHistory() {
  const response = await sendMessage({ type: 'GET_RECENTS' });
  renderHistory(response.recentActions || []);
}

function renderTrackedPages(items) {
  const root = $('tracked-pages');
  const visibleItems = items.filter((item) => {
    if (trackedPinnedOnly && !item.pinned) {
      return false;
    }
    if (!trackedSearch) {
      return true;
    }
    const haystack = [
      item.title,
      item.url,
      item.hostname,
      item.pageType,
      item.notePreview,
    ].join(' ').toLowerCase();
    return haystack.includes(trackedSearch);
  });

  if (!visibleItems.length) {
    root.innerHTML = '<div class="history-empty">No tracked pages yet.</div>';
    return;
  }

  root.innerHTML = visibleItems.map((item) => `
    <article class="tracked-item" data-url="${item.url}">
      <div class="history-top">
        <span class="history-type">tracked</span>
        <span class="history-time">${relativeTime(item.lastSeenAt || item.createdAt)}</span>
      </div>
      <div class="history-title">${escapeHtml(item.title || item.url)}</div>
      <div class="tracked-meta">${escapeHtml([item.hostname, item.pageType].filter(Boolean).join(' · '))}</div>
      <div class="tracked-badges">
        ${item.pinned ? '<span class="tracked-badge">Pinned</span>' : ''}
        ${item.hasNote ? '<span class="tracked-badge">Note</span>' : ''}
        ${item.snapshotCount ? `<span class="tracked-badge">${item.snapshotCount} snapshot${item.snapshotCount === 1 ? '' : 's'}</span>` : ''}
      </div>
      ${item.notePreview ? `<div class="tracked-note">${escapeHtml(item.notePreview)}</div>` : ''}
      <div class="history-actions">
        <button class="history-btn" data-action="open-tracked">Open</button>
        <button class="history-btn" data-action="toggle-pin">${item.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="history-btn" data-action="remove-tracked">Remove</button>
      </div>
    </article>
  `).join('');
}

async function refreshTrackedPages() {
  const response = await sendMessage({ type: 'GET_TRACKED_PAGES' });
  trackedItems = response.trackedPages || [];
  renderTrackedPages(trackedItems);
}

function renderSnapshots(items) {
  const root = $('snapshot-list');
  if (!items.length) {
    root.innerHTML = '<div class="history-empty">No snapshots for this page yet.</div>';
    return;
  }

  root.innerHTML = items.map((item) => `
    <article class="snapshot-item">
      <div class="history-top">
        <span class="history-type">snapshot</span>
        <span class="history-time">${relativeTime(item.timestamp)}</span>
      </div>
      <div class="history-title">${escapeHtml(item.title || 'Page snapshot')}</div>
      <div class="snapshot-summary">${escapeHtml((item.description || item.text || '').slice(0, 180))}</div>
    </article>
  `).join('');
}

async function refreshSnapshots() {
  if (!currentPage?.url) {
    renderSnapshots([]);
    return;
  }
  const response = await sendMessage({
    type: 'GET_PAGE_SNAPSHOTS',
    url: currentPage.url,
  });
  renderSnapshots(response.snapshots || []);
}

async function refreshPage() {
  const previousWorkspaceUrl = currentWorkspaceUrl;
  const response = await sendMessage({ type: 'GET_ACTIVE_PAGE_CONTEXT' });
  if (!response.ok) {
    renderUnavailablePage(response.error || 'Could not read the active page.');
    return;
  }
  renderPage(response.page, response.tab, response.note, response.continuity);
  currentWorkspaceUrl = String(response.page?.url || response.tab?.url || '').split('#')[0];
  if (currentWorkspaceUrl !== previousWorkspaceUrl) {
    await restoreWorkspaceState();
  }
  await refreshSnapshots();
  await refreshDirectThread();
}

async function refreshDirectThread() {
  const response = await sendMessage({
    type: 'GET_DIRECT_THREAD',
    page: currentPage,
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not load the Hermes direct line.');
    return;
  }
  renderDirectThread(response.thread);
}

function setMode(mode, { persist = true } = {}) {
  currentMode = mode;
  document.querySelectorAll('.workflow-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  if (persist) {
    persistWorkspaceState();
  }
}

async function runCurrentWorkflow(injectAfter) {
  if (!currentPage) {
    await refreshPage();
  }

  const executionMode = injectAfter ? 'inject' : currentMode;
  const response = await sendMessage({
    type: 'RUN_WORKFLOW',
    mode: executionMode,
    prompt: $('workspace-prompt').value.trim(),
    target: $('workspace-target').value,
    page: currentPage,
  });

  if (!response.ok) {
    setOutput(response.error || 'Hermes workflow failed.');
    return;
  }

  setOutput(response.text || '');
  persistWorkspaceState({
    lastAction: injectAfter ? 'build-context' : `workflow-${executionMode}`,
    target: $('workspace-target').value,
  });
  await refreshHistory();

  if (injectAfter) {
    const injected = await sendMessage({
      type: 'INJECT_CONTEXT',
      text: response.text || '',
    });
    if (!injected.ok) {
      setOutput(`${response.text || ''}\n\n[Injection failed: ${injected.error || 'unknown error'}]`);
    }
  }
}

$('refresh-page').addEventListener('click', refreshPage);
$('refresh-direct').addEventListener('click', refreshDirectThread);

$('send-direct').addEventListener('click', async () => {
  if (!currentPage) {
    await refreshPage();
  }

  const response = await sendMessage({
    type: 'DIRECT_LINE_MESSAGE',
    prompt: $('direct-prompt').value.trim(),
    page: currentPage,
    source: 'workspace',
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not send your message to Hermes.');
    return;
  }

  $('direct-prompt').value = '';
  persistWorkspaceState({ lastAction: 'direct-line' });
  renderDirectThread(response.thread);
  setOutput(response.text || '');
  await refreshHistory();
  await refreshPage();
});

$('clear-direct').addEventListener('click', async () => {
  const response = await sendMessage({
    type: 'CLEAR_DIRECT_THREAD',
    page: currentPage,
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not clear the Hermes thread.');
    return;
  }
  renderDirectThread(response.thread);
  persistWorkspaceState({ lastAction: 'clear-direct' });
  await refreshPage();
});

$('track-page').addEventListener('click', async () => {
  const response = await sendMessage({
    type: 'TRACK_PAGE',
    page: currentPage,
    pinned: true,
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not track this page.');
    return;
  }
  setOutput(`Tracked ${currentPage?.title || 'this page'}.`);
  persistWorkspaceState({ lastAction: 'track-page' });
  await refreshTrackedPages();
  await refreshPage();
});

$('save-note').addEventListener('click', async () => {
  const response = await sendMessage({
    type: 'SAVE_PAGE_NOTE',
    url: currentPage?.url || '',
    note: $('page-note').value,
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not save note.');
    return;
  }
  setOutput('Page note saved.');
  persistWorkspaceState({ lastAction: 'save-note' });
  await refreshPage();
});

$('save-snapshot').addEventListener('click', async () => {
  const response = await sendMessage({
    type: 'SAVE_PAGE_SNAPSHOT',
    page: currentPage,
    source: 'sidepanel',
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not save snapshot.');
    return;
  }
  if (response.unchanged) {
    setOutput('This page matches the latest saved snapshot.');
  } else {
    setOutput(`Snapshot saved for ${currentPage?.title || 'this page'}.`);
  }
  persistWorkspaceState({ lastAction: 'save-snapshot' });
  await refreshSnapshots();
  await refreshPage();
});

$('compare-snapshot').addEventListener('click', async () => {
  const response = await sendMessage({
    type: 'COMPARE_WITH_SNAPSHOT',
    page: currentPage,
    note: $('workspace-prompt').value.trim(),
  });
  if (!response.ok) {
    setOutput(response.error || 'Could not compare with the last snapshot.');
    return;
  }
  setOutput(response.text || '');
  await refreshHistory();
});

document.querySelectorAll('.workflow-btn').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

$('run-workflow').addEventListener('click', () => {
  runCurrentWorkflow(false);
});

$('inject-workflow').addEventListener('click', () => {
  runCurrentWorkflow(true);
});

document.querySelectorAll('.memory-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const response = await sendMessage({
      type: 'RUN_MEMORY_ACTION',
      kind: button.dataset.kind,
      note: $('workspace-prompt').value.trim(),
      page: currentPage,
    });
    if (!response.ok) {
      setOutput(response.error || 'Hermes memory action failed.');
      return;
    }
    setOutput(response.text || '');
    await refreshHistory();
  });
});

$('copy-workspace-output').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentOutput || '');
  setOutput(`${currentOutput || ''}\n\n[Copied to clipboard]`);
});

$('open-workspace-output').addEventListener('click', async () => {
  await sendMessage({
    type: 'OPEN_OUTPUT_TAB',
    text: currentOutput || '',
    label: 'Hermes Workspace output',
  });
});

$('workspace-history').addEventListener('click', async (event) => {
  const button = event.target.closest('.history-btn');
  const article = event.target.closest('.history-item');
  if (!button || !article) return;

  const detail = await sendMessage({
    type: 'GET_RECENT_DETAIL',
    id: article.dataset.id,
  });

  if (!detail.ok || !detail.item) return;

  if (button.dataset.action === 'use') {
    setOutput(detail.item.output || detail.item.summary || '');
  }

  if (button.dataset.action === 'open') {
    await sendMessage({
      type: 'OPEN_OUTPUT_TAB',
      text: detail.item.output || detail.item.summary || '',
      label: detail.item.title || 'Hermes Workspace history',
    });
  }
});

$('tracked-pages').addEventListener('click', async (event) => {
  const button = event.target.closest('.history-btn');
  const article = event.target.closest('.tracked-item');
  if (!button || !article) return;

  const item = trackedItems.find((entry) => entry.url === article.dataset.url);

  if (button.dataset.action === 'open-tracked') {
    await sendMessage({
      type: 'OPEN_TRACKED_PAGE',
      url: article.dataset.url,
    });
  }

  if (button.dataset.action === 'remove-tracked') {
    await sendMessage({
      type: 'UNTRACK_PAGE',
      url: article.dataset.url,
    });
    await refreshTrackedPages();
  }

  if (button.dataset.action === 'toggle-pin' && item) {
    await sendMessage({
      type: 'UPDATE_TRACKED_PAGE',
      url: article.dataset.url,
      patch: {
        pinned: !item.pinned,
      },
    });
    await refreshTrackedPages();
  }
});

$('workspace-prompt').addEventListener('input', () => persistWorkspaceState());
$('direct-prompt').addEventListener('input', () => persistWorkspaceState());
$('workspace-target').addEventListener('change', () => persistWorkspaceState());

$('tracked-search').addEventListener('input', (event) => {
  trackedSearch = String(event.target.value || '').trim().toLowerCase();
  persistWorkspaceState();
  renderTrackedPages(trackedItems);
});

$('tracked-filter-toggle').addEventListener('click', () => {
  trackedPinnedOnly = !trackedPinnedOnly;
  $('tracked-filter-toggle').textContent = `Pinned Only: ${trackedPinnedOnly ? 'On' : 'Off'}`;
  persistWorkspaceState();
  renderTrackedPages(trackedItems);
});

async function initializeWorkspace() {
  await restoreWorkspaceState();
  await refreshPage();
  await refreshHistory();
  await refreshTrackedPages();
}

window.addEventListener('focus', () => {
  refreshPage().catch((error) => setOutput(error.message || String(error)));
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshPage().catch((error) => setOutput(error.message || String(error)));
  }
});

initializeWorkspace().catch((error) => setOutput(error.message || String(error)));
