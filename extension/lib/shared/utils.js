import { DEFAULT_CONFIG } from './constants.js';

const KNOWN_ASSISTANT_HOSTS = new Map([
  ['claude.ai', 'claude'],
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['gemini.google.com', 'gemini'],
  ['perplexity.ai', 'perplexity'],
  ['poe.com', 'poe'],
  ['grok.com', 'grok'],
  ['x.ai', 'grok'],
  ['deepseek.com', 'deepseek'],
  ['chat.deepseek.com', 'deepseek'],
  ['mistral.ai', 'mistral'],
  ['chat.mistral.ai', 'mistral'],
  ['you.com', 'you'],
  ['openrouter.ai', 'openrouter'],
]);

export function canonicalizeUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return String(url || '').split('#')[0];
  }
}

export function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
}

export function hashString(input) {
  let hash = 0;
  const text = String(input || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function parseIsoTime(value) {
  const stamp = Date.parse(value || '');
  return Number.isFinite(stamp) ? stamp : 0;
}

export function summarizeNote(text, limit = 160) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}

export function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
}

export function getHostname(url) {
  try {
    return normalizeHostname(new URL(String(url || '')).hostname);
  } catch (_) {
    return '';
  }
}

export function normalizeAssistantHosts(hosts = []) {
  return [...new Set(
    (Array.isArray(hosts) ? hosts : [])
      .map((host) => normalizeHostname(host))
      .filter(Boolean),
  )];
}

export function isKnownAssistantHost(hostname = '') {
  const normalized = normalizeHostname(hostname);
  for (const knownHost of KNOWN_ASSISTANT_HOSTS.keys()) {
    if (normalized === knownHost || normalized.endsWith(`.${knownHost}`)) {
      return true;
    }
  }
  return false;
}

export function resolveAssistantTarget(hostname = '', customHosts = []) {
  const normalized = normalizeHostname(hostname);
  for (const [knownHost, target] of KNOWN_ASSISTANT_HOSTS.entries()) {
    if (normalized === knownHost || normalized.endsWith(`.${knownHost}`)) {
      return target;
    }
  }

  if (normalizeAssistantHosts(customHosts).includes(normalized)) {
    return 'custom';
  }

  return 'generic';
}

export function inferAssistantTarget(url, customHosts = []) {
  return resolveAssistantTarget(getHostname(url), customHosts);
}

export function isSupportedChatUrl(url, customHosts = []) {
  return inferAssistantTarget(url, customHosts) !== 'generic';
}

export function buildConversationId(config, suffix) {
  const safeSuffix = String(suffix || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'general';
  return `${config.conversationPrefix}-${safeSuffix}`;
}
