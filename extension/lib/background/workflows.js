import { findLatestContextAction, describeLatestContext } from './handoff.js';
import {
  escapeHtml,
  buildConversationId,
  canonicalizeUrl,
  hashString,
  inferAssistantTarget,
  isSupportedChatUrl,
  summarizeNote,
  getHostname,
  isKnownAssistantHost,
} from '../shared/utils.js';

export function getModeDefinition(mode) {
  const table = {
    'explain-selection': {
      label: 'Explain Selection',
      userPromptFallback: 'Explain the selected text and why it matters here.',
      instructions:
        'You are Hermes Relay. Explain the selected text first. If no explicit selection is present, explain the most relevant passage on the page. Clarify the meaning, relevance, and next useful takeaway.',
      task:
        'Explain the selected text in page context. Define key terms, surface why it matters, and end with the most useful takeaway.',
    },
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
    'extract-facts': {
      label: 'Extract Facts',
      userPromptFallback: 'Extract the key facts and claims from this page.',
      instructions:
        'You are Hermes Relay. Extract durable facts, claims, entities, numbers, dates, and named references from the page. Separate confirmed details from uncertain or implied claims.',
      task:
        'Extract the key facts from the page. Use a compact list and clearly mark anything that sounds uncertain, inferred, or worth verifying.',
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

const CONTEXT_SCOPE_LABELS = {
  selection: 'Selection first',
  article: 'Visible article',
  'visible-surface': 'Visible app surface',
  'full-page': 'Readable page',
  metadata: 'Page metadata',
};

export function deriveContextScope(page = {}) {
  if (String(page?.selection || '').trim()) {
    return 'selection';
  }
  if (page?.pageType === 'article') {
    return 'article';
  }
  if (String(page?.text || '').trim()) {
    return page?.pageType === 'app' ? 'visible-surface' : 'full-page';
  }
  return 'metadata';
}

export function getContextScopeLabel(scope = '') {
  return CONTEXT_SCOPE_LABELS[scope] || CONTEXT_SCOPE_LABELS['full-page'];
}

function detectPageSignals(page = {}) {
  const haystack = [
    page?.title || '',
    page?.description || '',
    page?.text || '',
  ].join(' ').toLowerCase();

  return {
    noisyPageLikely: page?.pageType === 'app' || (Array.isArray(page?.headings) && page.headings.length >= 6),
    loginWallLikely: /\b(sign in|log in|login|subscribe to continue|create account|join to continue|members only)\b/.test(haystack),
  };
}

export function listContextInputs(page = {}) {
  const inputs = ['page title', 'URL'];

  if (String(page?.selection || '').trim()) {
    inputs.push('selected text');
  }
  if (String(page?.description || '').trim()) {
    inputs.push('description');
  }
  if (Array.isArray(page?.headings) && page.headings.length) {
    inputs.push('visible headings');
  }
  if (String(page?.text || '').trim()) {
    inputs.push(page?.pageType === 'article' ? 'article body' : 'readable page body');
  }

  return inputs;
}

export function buildBrowserContextEnvelope(page = {}, {
  mode = 'ask',
  userPrompt = '',
  target = 'generic',
  timestamp = new Date().toISOString(),
} = {}) {
  const modeDef = getModeDefinition(mode);
  const scope = deriveContextScope(page);
  const scopeLabel = getContextScopeLabel(scope);
  const provenance = listContextInputs(page);
  const signals = detectPageSignals(page);
  const sections = [
    'Browser context envelope:',
    `- Action type: ${modeDef.label}`,
    `- User instruction: ${userPrompt || modeDef.userPromptFallback || '(none provided)'}`,
    `- Scope: ${scopeLabel}`,
    `- Page title: ${page?.title || '(untitled)'}`,
    `- URL: ${page?.url || ''}`,
    `- Hostname: ${page?.hostname || ''}`,
    `- Page type: ${page?.pageType || 'page'}`,
    `- Timestamp: ${timestamp}`,
    `- Login wall likely: ${signals.loginWallLikely ? 'yes' : 'no'}`,
    `- Noisy page likely: ${signals.noisyPageLikely ? 'yes' : 'no'}`,
    `- Content priority: ${scope === 'selection'
      ? 'selected text, then readable page body, then page metadata'
      : 'readable page body, then visible headings and description, then page metadata'}`,
  ];

  if (page?.selection) {
    sections.push(`Selected text:\n${page.selection}`);
  }

  if (page?.description) {
    sections.push(`Page description:\n${page.description}`);
  }

  if (Array.isArray(page?.headings) && page.headings.length) {
    sections.push(`Visible headings:\n- ${page.headings.join('\n- ')}`);
  }

  if (page?.text) {
    sections.push(`Readable page body:\n${page.text}`);
  } else {
    sections.push('Readable page body:\n(no readable text found)');
  }

  if (mode === 'inject') {
    sections.push(`Target assistant: ${target}`);
  }

  sections.push(`Task:\n${modeDef.task}`);
  sections.push(`User request:\n${userPrompt || modeDef.userPromptFallback || ''}`);

  return {
    scope,
    scopeLabel,
    provenance,
    provenanceText: provenance.length ? `Used ${provenance.join(' + ')}` : '',
    prompt: sections.join('\n\n'),
  };
}

function buildRunMeta({
  mode = 'ask',
  target = 'generic',
  page = null,
  source = 'standalone',
  sessionId = '',
  scope = '',
  provenance = [],
  timestamp = '',
} = {}) {
  const modeDef = getModeDefinition(mode);
  return {
    mode,
    modeLabel: modeDef.label,
    target,
    scope,
    scopeLabel: getContextScopeLabel(scope),
    source,
    sessionId,
    status: 'done',
    statusLabel: 'Done',
    destination: source === 'live-session' ? 'shared-session' : 'popup-workspace',
    destinationLabel: source === 'live-session' ? 'Current terminal session' : 'Popup and workspace',
    provenance,
    provenanceText: provenance.length ? `Used ${provenance.join(' + ')}` : '',
    pageTitle: page?.title || '',
    pageUrl: page?.url || '',
    timestamp,
  };
}

export function getTargetGuidance(target) {
  const table = {
    claude: 'Format the context so it reads naturally in Claude. Clean headings, high signal, no filler.',
    chatgpt: 'Format the context so it works cleanly in ChatGPT. Direct, structured, and easy to continue from.',
    gemini: 'Format the context so it works cleanly in Gemini. Be crisp, neutral, and task-oriented.',
    generic: 'Format the context so it works in any assistant. Keep it portable and compact.',
  };

  return table[target] || table.generic;
}

export function composeDirectPrompt(page, userPrompt) {
  const envelope = buildBrowserContextEnvelope(page, {
    mode: 'ask',
    userPrompt,
    target: 'generic',
  });
  return [
    'Direct browser message for Hermes.',
    'Prioritize any selected text first, then the readable page body, then page metadata.',
    '',
    envelope.prompt,
  ].filter(Boolean).join('\n\n');
}

export function composePagePrompt(page, userPrompt, mode, target) {
  return buildBrowserContextEnvelope(page, {
    mode,
    userPrompt,
    target,
  }).prompt;
}

export function composeLiveSessionPrompt(page, userPrompt, mode, target) {
  const modeDef = getModeDefinition(mode);
  const envelope = buildBrowserContextEnvelope(page, {
    mode,
    userPrompt,
    target,
  });
  const guidance = mode === 'inject'
    ? `${modeDef.instructions} ${getTargetGuidance(target)}`
    : modeDef.instructions;
  return [
    `[Browser command: ${modeDef.label}]`,
    'Treat this as input from Hermes Relay attached to the user\'s live terminal session.',
    'Use the browser context envelope below and answer directly in the shared session.',
    'Be explicit about what you used: selection first when present, then readable body, then page metadata.',
    '',
    `Guidance:\n${guidance}`,
    '',
    envelope.prompt,
  ].join('\n');
}

export function buildDirectThreadMeta(config, page, tab) {
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

export function createRelayOperations({
  storageApi,
  pageContextApi,
  hermesClient,
  getConfig = async () => (typeof storageApi.getConfig === 'function' ? storageApi.getConfig() : {}),
  browser = globalThis.chrome,
  uuid = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  async function getCurrentPageContext(page = null, tab = null) {
    let activeTab = tab;
    let activePage = page;

    if (!activeTab) {
      activeTab = await pageContextApi.getActiveTab();
    }
    if (!activePage && activeTab?.id) {
      activePage = await pageContextApi.extractPageContext(activeTab.id);
    }

    return {
      tab: activeTab,
      page: activePage,
    };
  }

  async function getDirectThread(page = null, tab = null) {
    const current = await getCurrentPageContext(page, tab);
    if (!current.tab && !current.page) {
      throw new Error('No active tab available.');
    }

    if (current.page?.url) {
      current.page = {
        ...current.page,
        url: canonicalizeUrl(current.page.url),
      };
    }

    const config = await getConfig();
    const meta = buildDirectThreadMeta(config, current.page, current.tab);
    const threads = await storageApi.getDirectThreads();
    return {
      threadKey: meta.threadKey,
      thread: threads[meta.threadKey] || {
        ...meta,
        messages: [],
        updatedAt: '',
      },
      page: current.page,
      tab: current.tab,
    };
  }

  async function clearDirectThread(page = null, tab = null) {
    const { threadKey, thread } = await getDirectThread(page, tab);
    const cleared = {
      ...thread,
      messages: [],
      updatedAt: now(),
    };
    await storageApi.saveDirectThread(threadKey, cleared);
    return cleared;
  }

  async function summarizePageContinuity(page = null, tab = null) {
    const current = await getCurrentPageContext(page, tab);
    if (!current.page?.url) {
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

    const canonicalUrl = canonicalizeUrl(current.page.url);
    const [notes, snapshots, trackedPages, direct] = await Promise.all([
      storageApi.getPageNotes(),
      storageApi.getSnapshots(),
      storageApi.getTrackedPages(),
      getDirectThread({ ...current.page, url: canonicalUrl }, current.tab),
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

  async function sendDirectLineMessage({
    prompt = '',
    page = null,
    tab = null,
    selectionText = '',
    source = 'workspace',
  }) {
    const current = await getCurrentPageContext(page, tab);
    if (!current.page) {
      throw new Error('No active page available.');
    }

    const activePage = selectionText
      ? { ...current.page, selection: selectionText }
      : current.page;

    const config = await getConfig();
    const meta = buildDirectThreadMeta(config, activePage, current.tab);
    const promptText = prompt.trim() || 'Take in this page and tell me what matters.';
    const contextEnvelope = buildBrowserContextEnvelope(activePage, {
      mode: 'ask',
      userPrompt: promptText,
      target: 'generic',
      timestamp: now(),
    });
    const result = await hermesClient.callResponse(config, {
      prompt: composeDirectPrompt(activePage, promptText),
      instructions: 'You are Hermes receiving live browser context from Hermes Relay. Treat the browser as your eyes and ears. Answer directly, ground yourself in the supplied page, and stay useful.',
      conversation: meta.conversation,
    });

    const existing = await storageApi.getDirectThreads();
    const prior = existing[meta.threadKey] || {
      ...meta,
      messages: [],
      updatedAt: '',
    };
    const timestamp = now();
    const nextThread = {
      ...prior,
      ...meta,
      updatedAt: timestamp,
      messages: [
        ...prior.messages,
        {
          id: uuid(),
          role: 'user',
          text: promptText,
          timestamp,
          source,
          selection: selectionText || activePage.selection || '',
        },
        {
          id: uuid(),
          role: 'assistant',
          text: result.text,
          timestamp: now(),
          source,
        },
      ].slice(-24),
    };

    await storageApi.saveDirectThread(meta.threadKey, nextThread);
    await storageApi.pushRecent({
      type: 'direct-line',
      title: activePage.title || current.tab?.title || 'Current page',
      url: activePage.url || current.tab?.url || '',
      prompt: promptText,
      summary: result.text.slice(0, 280),
      output: result.text,
      source,
      modeLabel: 'Direct Line',
      scope: contextEnvelope.scope,
      scopeLabel: contextEnvelope.scopeLabel,
      destination: 'popup-workspace',
      destinationLabel: 'Popup and workspace',
      status: 'done',
      statusLabel: 'Done',
      provenance: contextEnvelope.provenance,
      provenanceText: contextEnvelope.provenanceText,
    });

    return {
      ok: true,
      thread: nextThread,
      threadKey: meta.threadKey,
      page: activePage,
      text: result.text,
      raw: result.raw,
      meta: {
        ...buildRunMeta({
          mode: 'ask',
          target: 'generic',
          page: activePage,
          source: 'standalone',
          scope: contextEnvelope.scope,
          provenance: contextEnvelope.provenance,
          timestamp: now(),
        }),
        modeLabel: 'Direct Line',
      },
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
    const current = await getCurrentPageContext(page, null);
    if (!current.page) {
      throw new Error('No active tab available.');
    }

    const config = await getConfig();
    const effectiveTarget = mode === 'inject'
      ? (target === 'auto' ? inferAssistantTarget(current.page.url) : target)
      : 'generic';
    const contextEnvelope = buildBrowserContextEnvelope(current.page, {
      mode,
      userPrompt: prompt,
      target: effectiveTarget,
      timestamp: now(),
    });
    const promptBody = contextEnvelope.prompt;
    const instructions = mode === 'inject'
      ? `${getModeDefinition(mode).instructions} ${getTargetGuidance(effectiveTarget)}`
      : getModeDefinition(mode).instructions;

    const liveSession = await hermesClient.getCurrentLiveSession(config);
    if (liveSession?.ok && liveSession.session?.session_id) {
      const livePrompt = composeLiveSessionPrompt(current.page, prompt, mode, effectiveTarget);
      const liveResult = await hermesClient.sendLiveCommand(config, {
        sessionId: liveSession.session.session_id,
        type: mode === 'inject' ? 'handoff.build' : 'workflow.run',
        prompt: livePrompt,
        metadata: {
          mode,
          target: effectiveTarget,
          pageUrl: current.page.url || '',
          pageTitle: current.page.title || title || 'Current page',
          scope: contextEnvelope.scope,
          provenance: contextEnvelope.provenance,
        },
      });

      const resultMeta = buildRunMeta({
        mode,
        target: effectiveTarget,
        page: current.page,
        source: 'live-session',
        sessionId: liveResult.sessionId || liveSession.session.session_id,
        scope: contextEnvelope.scope,
        provenance: contextEnvelope.provenance,
        timestamp: now(),
      });

      await storageApi.pushRecent({
        type: `workflow-${mode}`,
        title: current.page.title || title || 'Current page',
        url: current.page.url || url || '',
        prompt,
        summary: liveResult.text.slice(0, 280),
        output: liveResult.text,
        mode,
        modeLabel: getModeDefinition(mode).label,
        target: effectiveTarget,
        source: 'live-session',
        sessionId: liveResult.sessionId || liveSession.session.session_id,
        scope: contextEnvelope.scope,
        scopeLabel: contextEnvelope.scopeLabel,
        destination: resultMeta.destination,
        destinationLabel: resultMeta.destinationLabel,
        status: resultMeta.status,
        statusLabel: resultMeta.statusLabel,
        provenance: contextEnvelope.provenance,
        provenanceText: contextEnvelope.provenanceText,
      });

      return {
        page: current.page,
        text: liveResult.text,
        raw: liveResult.raw,
        mode,
        target: effectiveTarget,
        sessionId: liveResult.sessionId || liveSession.session.session_id,
        source: 'live-session',
        meta: resultMeta,
      };
    }

    const conversation = buildConversationId(config, `workflow-${mode}`);
    const result = await hermesClient.callResponse(config, {
      prompt: promptBody,
      instructions,
      conversation,
    });

    const resultMeta = buildRunMeta({
      mode,
      target: effectiveTarget,
      page: current.page,
      source: 'standalone',
      scope: contextEnvelope.scope,
      provenance: contextEnvelope.provenance,
      timestamp: now(),
    });

    await storageApi.pushRecent({
      type: `workflow-${mode}`,
      title: current.page.title || title || 'Current page',
      url: current.page.url || url || '',
      prompt,
      summary: result.text.slice(0, 280),
      output: result.text,
      mode,
      modeLabel: getModeDefinition(mode).label,
      target: effectiveTarget,
      source: 'standalone',
      scope: contextEnvelope.scope,
      scopeLabel: contextEnvelope.scopeLabel,
      destination: resultMeta.destination,
      destinationLabel: resultMeta.destinationLabel,
      status: resultMeta.status,
      statusLabel: resultMeta.statusLabel,
      provenance: contextEnvelope.provenance,
      provenanceText: contextEnvelope.provenanceText,
    });

    return {
      page: current.page,
      text: result.text,
      raw: result.raw,
      mode,
      target: effectiveTarget,
      source: 'standalone',
      meta: resultMeta,
    };
  }

  async function runMemoryAction({ kind = 'fact', note = '', page = null }) {
    const modeMap = {
      fact: 'remember-fact',
      preference: 'remember-preference',
      workflow: 'remember-workflow',
    };

    return runWorkflow({
      mode: modeMap[kind] || 'remember-fact',
      prompt: note,
      target: 'generic',
      page,
    });
  }

  async function capturePageToHermes() {
    return runWorkflow({
      mode: 'capture',
      prompt: '',
      target: 'generic',
    });
  }

  async function buildInjectableContext(userPrompt, requestedTarget = 'auto') {
    const current = await getCurrentPageContext();
    if (!current.page) {
      throw new Error('No active tab available.');
    }

    const config = await getConfig();
    const target = requestedTarget === 'auto'
      ? inferAssistantTarget(current.tab?.url || current.page.url)
      : requestedTarget;
    const contextEnvelope = buildBrowserContextEnvelope(current.page, {
      mode: 'inject',
      userPrompt,
      target,
      timestamp: now(),
    });
    const prompt = contextEnvelope.prompt;
    const instructions = `${getModeDefinition('inject').instructions} ${getTargetGuidance(target)}`;

    const liveSession = await hermesClient.getCurrentLiveSession(config);
    if (liveSession?.ok && liveSession.session?.session_id) {
      const livePrompt = composeLiveSessionPrompt(current.page, userPrompt, 'inject', target);
      const liveResult = await hermesClient.sendLiveCommand(config, {
        sessionId: liveSession.session.session_id,
        type: 'handoff.build',
        prompt: livePrompt,
        metadata: {
          mode: 'inject',
          target,
          pageUrl: current.page.url || '',
          pageTitle: current.page.title || current.tab?.title || 'Current page',
          scope: contextEnvelope.scope,
          provenance: contextEnvelope.provenance,
        },
      });

      const resultMeta = buildRunMeta({
        mode: 'inject',
        target,
        page: current.page,
        source: 'live-session',
        sessionId: liveResult.sessionId || liveSession.session.session_id,
        scope: contextEnvelope.scope,
        provenance: contextEnvelope.provenance,
        timestamp: now(),
      });

      await storageApi.pushRecent({
        type: 'build-context',
        title: current.page.title || current.tab?.title || 'Current page',
        url: current.page.url || current.tab?.url || '',
        summary: liveResult.text.slice(0, 280),
        output: liveResult.text,
        target,
        mode: 'inject',
        source: 'live-session',
        sessionId: liveResult.sessionId || liveSession.session.session_id,
        modeLabel: getModeDefinition('inject').label,
        scope: contextEnvelope.scope,
        scopeLabel: contextEnvelope.scopeLabel,
        destination: resultMeta.destination,
        destinationLabel: resultMeta.destinationLabel,
        status: resultMeta.status,
        statusLabel: resultMeta.statusLabel,
        provenance: contextEnvelope.provenance,
        provenanceText: contextEnvelope.provenanceText,
      });

      return {
        page: current.page,
        target,
        text: liveResult.text,
        raw: liveResult.raw,
        sessionId: liveResult.sessionId || liveSession.session.session_id,
        source: 'live-session',
        meta: resultMeta,
      };
    }

    const conversation = buildConversationId(config, 'inject');
    const result = await hermesClient.callResponse(config, {
      prompt,
      instructions,
      conversation,
    });

    const resultMeta = buildRunMeta({
      mode: 'inject',
      target,
      page: current.page,
      source: 'standalone',
      scope: contextEnvelope.scope,
      provenance: contextEnvelope.provenance,
      timestamp: now(),
    });

    await storageApi.pushRecent({
      type: 'build-context',
      title: current.page.title || current.tab?.title || 'Current page',
      url: current.page.url || current.tab?.url || '',
      summary: result.text.slice(0, 280),
      output: result.text,
      target,
      mode: 'inject',
      source: 'standalone',
      modeLabel: getModeDefinition('inject').label,
      scope: contextEnvelope.scope,
      scopeLabel: contextEnvelope.scopeLabel,
      destination: resultMeta.destination,
      destinationLabel: resultMeta.destinationLabel,
      status: resultMeta.status,
      statusLabel: resultMeta.statusLabel,
      provenance: contextEnvelope.provenance,
      provenanceText: contextEnvelope.provenanceText,
    });

    return {
      page: current.page,
      target,
      text: result.text,
      raw: result.raw,
      source: 'standalone',
      meta: resultMeta,
    };
  }

  async function getLatestContextStatus() {
    const [recentActions, activeTab, config] = await Promise.all([
      storageApi.getRecentActions(),
      pageContextApi.getActiveTab(),
      getConfig(),
    ]);
    const item = findLatestContextAction(recentActions);
    const activeHostname = getHostname(activeTab?.url || '');
    const customAssistantHosts = config?.customAssistantHosts || [];
    const canInsertHere = isSupportedChatUrl(activeTab?.url || '', customAssistantHosts);

    return {
      ...describeLatestContext(item),
      canInsertHere,
      activeTarget: inferAssistantTarget(activeTab?.url || '', customAssistantHosts),
      activeHostname,
      canAllowCurrentHost: Boolean(
        activeHostname
        && !canInsertHere
        && !pageContextApi.isRestrictedBrowserUrl(activeTab?.url || '')
        && !isKnownAssistantHost(activeHostname),
      ),
      item,
    };
  }

  async function insertLatestContext() {
    const status = await getLatestContextStatus();
    if (!status.item?.output) {
      throw new Error('No saved context yet. Build context from a page first.');
    }

    await injectIntoActiveTab(status.item.output);
    return {
      text: status.item.output,
      item: status.item,
    };
  }

  async function compareWithLatestSnapshot(page = null, note = '') {
    const current = await getCurrentPageContext(page, null);
    if (!current.page) {
      throw new Error('No active tab available.');
    }

    const snapshots = await storageApi.getSnapshotsForUrl(current.page.url);
    const previous = snapshots[0];
    if (!previous) {
      throw new Error('No earlier snapshot exists for this page yet.');
    }

    const config = await getConfig();
    const conversation = buildConversationId(config, 'snapshot-compare');
    const prompt = [
      `Current page title: ${current.page.title || '(untitled)'}`,
      `Current page URL: ${current.page.url}`,
      `User note:\n${note || 'Describe what changed in a high-signal way.'}`,
      'Previous snapshot:',
      `Title: ${previous.title || '(untitled)'}`,
      `Description: ${previous.description || ''}`,
      `Headings:\n- ${(previous.headings || []).join('\n- ')}`,
      `Text excerpt:\n${previous.text || ''}`,
      'Current page:',
      `Description: ${current.page.description || ''}`,
      `Headings:\n- ${(current.page.headings || []).join('\n- ')}`,
      `Text excerpt:\n${(current.page.text || '').slice(0, 8000)}`,
      'Task:\nCompare the previous snapshot against the current page. Explain what changed, what stayed the same, what matters, and any likely implications.',
    ].join('\n\n');
    const result = await hermesClient.callResponse(config, {
      prompt,
      instructions: 'You are Hermes Relay. Produce a compact diff-style comparison between the earlier page snapshot and the current page. Focus on meaningful changes, not trivial wording drift.',
      conversation,
    });

    await storageApi.pushRecent({
      type: 'snapshot-compare',
      title: current.page.title || previous.title || 'Current page',
      url: current.page.url || '',
      prompt: note,
      summary: result.text.slice(0, 280),
      output: result.text,
      mode: 'snapshot-compare',
      modeLabel: 'Snapshot Compare',
      scope: deriveContextScope(current.page),
      scopeLabel: getContextScopeLabel(deriveContextScope(current.page)),
      destination: 'popup-workspace',
      destinationLabel: 'Popup and workspace',
      status: 'done',
      statusLabel: 'Done',
      provenance: listContextInputs(current.page),
      provenanceText: `Used ${listContextInputs(current.page).join(' + ')} + previous snapshot`,
    });

    return {
      page: current.page,
      previous,
      text: result.text,
      raw: result.raw,
      meta: {
        ...buildRunMeta({
          mode: 'compare',
          target: 'generic',
          page: current.page,
          source: 'standalone',
          scope: deriveContextScope(current.page),
          provenance: [...listContextInputs(current.page), 'previous snapshot'],
          timestamp: now(),
        }),
        modeLabel: 'Snapshot Compare',
      },
    };
  }

  async function injectIntoActiveTab(text) {
    const activeTab = await pageContextApi.getActiveTab();
    const config = await getConfig();
    const customAssistantHosts = config?.customAssistantHosts || [];
    if (!activeTab?.id) {
      throw new Error('No active tab available.');
    }
    if (pageContextApi.isRestrictedBrowserUrl(activeTab?.url || '')) {
      throw new Error('Hermes Relay cannot insert context into browser-internal pages like chrome:// tabs.');
    }
    if (!isSupportedChatUrl(activeTab?.url || '', customAssistantHosts)) {
      throw new Error('Open a supported AI chat or allow this site as a custom AI host first.');
    }

    await pageContextApi.ensureChatBridge(activeTab.id);
    const reply = await browser.tabs.sendMessage(activeTab.id, {
      type: 'INSERT_HERMES_CONTEXT',
      text,
    });
    if (!reply?.ok) {
      throw new Error(reply?.error || 'No compatible chat input found.');
    }

    await storageApi.pushRecent({
      type: 'inject-context',
      title: activeTab.title || 'Active tab',
      url: activeTab.url || '',
      summary: text.slice(0, 280),
      output: text,
    });

    return reply;
  }

  async function addCustomAssistantHost(url = '') {
    const hostname = getHostname(url);
    if (!hostname) {
      throw new Error('No valid hostname found for this page.');
    }

    if (isKnownAssistantHost(hostname)) {
      return {
        ok: true,
        hostname,
        config: await getConfig(),
      };
    }

    const config = await getConfig();
    return {
      ok: true,
      hostname,
      config: await storageApi.setConfig({
        customAssistantHosts: [...(config.customAssistantHosts || []), hostname],
      }),
    };
  }

  async function openContextResult(text, label) {
    const safeLabel = escapeHtml(label || 'Hermes Relay for Chrome');
    const safeText = escapeHtml(text || '');
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${safeLabel}</title>
          <style>
            body { margin: 0; padding: 24px; background: #202316; color: #f2ead7; font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
            main { max-width: 860px; margin: 0 auto; }
            h1 { margin: 0 0 16px; font-size: 18px; }
            pre { white-space: pre-wrap; word-break: break-word; background: #2a311f; border: 1px solid #586546; padding: 18px; border-radius: 12px; }
          </style>
        </head>
        <body>
          <main>
            <h1>${safeLabel}</h1>
            <pre>${safeText}</pre>
          </main>
        </body>
      </html>`;

    await browser.tabs.create({
      url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    });
  }

  async function openSidePanel() {
    const activeTab = await pageContextApi.getActiveTab();
    if (!activeTab?.windowId) {
      throw new Error('No active window available.');
    }

    await browser.sidePanel.setOptions({
      path: 'sidepanel/sidepanel.html',
      enabled: true,
    });
    await browser.sidePanel.open({ windowId: activeTab.windowId });
    return { ok: true };
  }

  return {
    getCurrentPageContext,
    getDirectThread,
    clearDirectThread,
    summarizePageContinuity,
    sendDirectLineMessage,
    runWorkflow,
    runMemoryAction,
    capturePageToHermes,
    buildInjectableContext,
    getLatestContextStatus,
    insertLatestContext,
    compareWithLatestSnapshot,
    injectIntoActiveTab,
    addCustomAssistantHost,
    openContextResult,
    openSidePanel,
  };
}
