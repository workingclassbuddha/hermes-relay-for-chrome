import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, LOCAL_HERMES_BASE_URLS } from '../extension/lib/shared/constants.js';
import { normalizeBaseUrl } from '../extension/lib/shared/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const envPath = path.join(os.homedir(), '.hermes', '.env');
const extensionPath = path.join(workspaceRoot, 'extension');
const zipPath = path.join(workspaceRoot, 'dist', 'hermes-relay-chrome.zip');
const baseUrls = [...new Set(
  [DEFAULT_CONFIG.baseUrl, ...LOCAL_HERMES_BASE_URLS].map((url) => normalizeBaseUrl(url)),
)];

function formatCheck(ok, label, detail = '') {
  return `${ok ? '[ok]' : '[ ]'} ${label}${detail ? `: ${detail}` : ''}`;
}

function parseEnv(text) {
  const env = {};

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }

  return env;
}

async function probe(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    });

    return {
      baseUrl,
      reachable: true,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      baseUrl,
      reachable: false,
      ok: false,
      status: 'offline',
      message: error?.message || 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

function hasHermesCli() {
  const result = spawnSync('hermes', ['--help'], { stdio: 'ignore' });
  return !result.error;
}

async function main() {
  const envExists = fs.existsSync(envPath);
  const env = envExists ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const apiServerEnabled = String(env.API_SERVER_ENABLED || '').toLowerCase() === 'true';
  const apiKeyPresent = Boolean(String(env.API_SERVER_KEY || '').trim());
  const hermesCliPresent = hasHermesCli();
  const probes = await Promise.all(baseUrls.map((baseUrl) => probe(baseUrl)));
  const live = probes.find((item) => item.ok || item.status === 401 || item.status === 403)
    || probes.find((item) => item.reachable)
    || null;

  console.log('Hermes Relay local setup\n');
  console.log(formatCheck(hermesCliPresent, 'Hermes CLI available', hermesCliPresent ? 'hermes command found' : 'install Hermes Agent first'));
  console.log(formatCheck(envExists, 'Hermes env file', envPath));
  console.log(formatCheck(apiServerEnabled, 'API server enabled', apiServerEnabled ? 'API_SERVER_ENABLED=true' : 'add API_SERVER_ENABLED=true'));
  console.log(formatCheck(apiKeyPresent, 'API key configured', apiKeyPresent ? 'API_SERVER_KEY is set' : 'add API_SERVER_KEY=change-me-local-dev'));
  console.log(formatCheck(Boolean(live), 'Hermes API reachable', live ? `${live.baseUrl} (${live.status})` : 'not responding on 127.0.0.1 or localhost'));
  console.log(formatCheck(fs.existsSync(extensionPath), 'Extension folder ready', extensionPath));
  console.log(formatCheck(fs.existsSync(zipPath), 'Chrome zip available', zipPath));

  console.log('\nNext steps\n');

  if (!envExists || !apiServerEnabled || !apiKeyPresent) {
    console.log('Add this to ~/.hermes/.env:\n');
    console.log('API_SERVER_ENABLED=true');
    console.log(`API_SERVER_KEY=${apiKeyPresent ? '[your-existing-key]' : 'change-me-local-dev'}`);
    console.log('');
  }

  if (!live) {
    console.log('Start Hermes with:\n');
    console.log('hermes gateway');
    console.log('');
  }

  console.log('Load unpacked in Chrome from:\n');
  console.log(extensionPath);
  console.log('');
  console.log('Or use the packaged zip:\n');
  console.log(zipPath);
  console.log('');
  console.log('Then open the Hermes Relay popup, paste the same API key once, and click Save & Test.');
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
