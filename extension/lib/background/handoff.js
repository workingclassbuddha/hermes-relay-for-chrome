import { LATEST_CONTEXT_ACTION_TYPES } from '../shared/constants.js';

export function findLatestContextAction(items = []) {
  return items.find((item) => (
    LATEST_CONTEXT_ACTION_TYPES.includes(item?.type) &&
    item?.status !== 'queued' &&
    item?.status !== 'failed' &&
    String(item?.output || '').trim()
  )) || null;
}

export function describeLatestContext(action) {
  if (!action) {
    return {
      available: false,
      title: '',
      timestamp: '',
      target: 'generic',
      type: '',
    };
  }

  return {
    available: true,
    title: action.title || 'Latest context',
    timestamp: action.timestamp || '',
    target: action.target || 'generic',
    type: action.type || '',
  };
}
