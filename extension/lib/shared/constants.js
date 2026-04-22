export const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:8642',
  apiKey: '',
  model: 'hermes-agent',
  conversationPrefix: 'hermes-relay',
  preferredTarget: 'auto',
  customAssistantHosts: [],
};

export const LOCAL_HERMES_BASE_URLS = [
  DEFAULT_CONFIG.baseUrl,
  'http://localhost:8642',
];

export const HEALTH_TIMEOUT_MS = 4000;
export const RESPONSE_TIMEOUT_MS = 45000;
export const STORAGE_SCHEMA_VERSION = 1;

export const CONTEXT_MENU_IDS = {
  askSelection: 'hermes-relay-ask-selection',
  rememberSelection: 'hermes-relay-remember-selection',
  sendPage: 'hermes-relay-send-page',
  injectContext: 'hermes-relay-inject-context',
};

export const DEFAULT_WORKSPACE_STATE = {
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

export const DEFAULT_WORKSPACE_STORE = {
  global: { ...DEFAULT_WORKSPACE_STATE },
  byPage: {},
};

export const LATEST_CONTEXT_ACTION_TYPES = [
  'build-context',
  'inject-context',
  'workflow-inject',
];
