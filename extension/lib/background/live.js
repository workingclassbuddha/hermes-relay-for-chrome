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

function eventCommandId(event = {}) {
  return event.command_id
    || event.commandId
    || event.payload?.command_id
    || event.payload?.commandId
    || event.payload?.command?.command_id
    || event.payload?.command?.id
    || '';
}

function compactPayloadText(payload = {}) {
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.result?.text === 'string') return payload.result.text;
  if (typeof payload.result?.summary === 'string') return payload.result.summary;
  if (typeof payload.result?.error === 'string') return payload.result.error;
  return '';
}

function recentPatchForLiveEvent(event = {}) {
  const commandId = eventCommandId(event);
  if (!commandId) {
    return null;
  }

  const payload = event.payload || {};
  const text = compactPayloadText(payload);

  if (event.type === 'assistant.final') {
    return {
      status: 'done',
      statusLabel: 'Done',
      summary: text.slice(0, 280),
      output: text,
    };
  }

  if (event.type === 'browser.action.result') {
    const failed = payload.result?.ok === false || event.status === 'failed';
    const output = text || (failed ? 'Browser action failed.' : 'Browser action completed.');
    return {
      status: failed ? 'failed' : 'done',
      statusLabel: failed ? 'Failed' : 'Done',
      summary: output.slice(0, 280),
      output,
    };
  }

  if (event.type === 'error') {
    const output = text || 'Hermes live command failed.';
    return {
      status: 'failed',
      statusLabel: 'Failed',
      summary: output.slice(0, 280),
      output,
    };
  }

  return null;
}

export function summarizeLiveTimeline(events = [], streamState = {}) {
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
    status: streamState.status || 'idle',
    error: streamState.error || '',
    eventCount: sorted.length,
    pendingApproval: pendingApproval || null,
    lastResult: lastResult || null,
    activeCommand: activeCommand || null,
    lastEvent: sorted[sorted.length - 1] || null,
  };
}

export function createLiveEventManager({
  storageApi,
  hermesClient,
  runtime = globalThis.chrome?.runtime,
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  const state = {
    sessionId: '',
    status: 'idle',
    error: '',
    eventSource: null,
  };

  function getState() {
    return {
      sessionId: state.sessionId,
      status: state.status,
      error: state.error,
    };
  }

  function stop() {
    if (state.eventSource) {
      state.eventSource.close();
    }
    state.sessionId = '';
    state.status = 'idle';
    state.error = '';
    state.eventSource = null;
  }

  async function record(event) {
    if (!event?.session_id) return;
    await storageApi.pushLiveEvents([event]);
    const patch = recentPatchForLiveEvent(event);
    if (patch) {
      await storageApi.updateRecentActionByCommandId(eventCommandId(event), patch).catch(() => null);
    }
    runtime?.sendMessage?.({ type: 'LIVE_EVENT_UPDATE', event })?.catch?.(() => {});
  }

  async function ensureStream(config, liveSession) {
    const sessionId = liveSession?.session?.session_id || '';
    if (!sessionId || !config?.apiKey || typeof EventSourceImpl === 'undefined') {
      if (!sessionId) {
        stop();
      }
      return;
    }
    if (state.eventSource && state.sessionId === sessionId) {
      return;
    }

    stop();
    const existing = await storageApi.getLiveEvents(sessionId);
    const after = existing.reduce((max, event) => Math.max(max, Number(event.sequence || 0)), 0);
    const source = new EventSourceImpl(hermesClient.buildLiveEventsUrl(config, { sessionId, after }));
    state.sessionId = sessionId;
    state.status = 'connecting';
    state.eventSource = source;

    const handleEvent = (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        state.status = 'connected';
        state.error = '';
        record(payload).catch(() => {});
      } catch (error) {
        state.status = 'error';
        state.error = error.message || String(error);
      }
    };

    LIVE_EVENT_TYPES.forEach((eventType) => {
      source.addEventListener(eventType, handleEvent);
    });
    source.onmessage = handleEvent;
    source.onerror = () => {
      state.status = 'reconnecting';
      state.error = 'Live event stream reconnecting.';
    };
  }

  function summarize(events = []) {
    return summarizeLiveTimeline(events, state);
  }

  return {
    ensureStream,
    getState,
    record,
    stop,
    summarize,
  };
}
