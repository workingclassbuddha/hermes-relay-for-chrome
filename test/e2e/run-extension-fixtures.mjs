import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const sourceExtensionDir = path.join(root, 'extension');

async function copyDir(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'local-dev-config.json' || entry.name === '.DS_Store') {
      continue;
    }
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
    } else {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(payload));
}

async function createServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fixtureHtml(pathname) {
  if (pathname === '/chat-textarea') {
    return `<!doctype html>
      <html><body>
        <h1>Fixture Chat Textarea</h1>
        <textarea id="prompt-textarea" placeholder="Message"></textarea>
      </body></html>`;
  }

  if (pathname === '/chat-editable') {
    return `<!doctype html>
      <html><body>
        <h1>Fixture Chat Editable</h1>
        <div id="editor" contenteditable="true" role="textbox"></div>
      </body></html>`;
  }

  return `<!doctype html>
    <html>
      <head>
        <meta name="description" content="Bearer abcdefghijklmnop123456">
        <title>Fixture Article sk_live_12345678901234567890</title>
      </head>
      <body>
        <main>
          <h1>Fixture Article</h1>
          <p>Useful public context stays visible.</p>
          <p>Secret line: api_key=sk_test_12345678901234567890</p>
          <table>
            <tr><th>token</th><th>card</th></tr>
            <tr><td>ghp_123456789012345678901234567890123456</td><td>4111 1111 1111 1111</td></tr>
          </table>
          <input id="secret-input" name="session_token" value="focused-value-should-not-leak">
        </main>
      </body>
    </html>`;
}

async function prepareExtensionCopy({ hermesOrigin, fixtureOrigin }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-relay-e2e-'));
  const extensionDir = path.join(tempRoot, 'extension');
  await copyDir(sourceExtensionDir, extensionDir);

  await fs.writeFile(path.join(extensionDir, 'local-dev-config.json'), JSON.stringify({
    baseUrl: hermesOrigin,
    apiKey: 'local-key',
    source: 'e2e-fixture',
    generatedAt: new Date().toISOString(),
  }, null, 2));

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    `${hermesOrigin}/*`,
    `${fixtureOrigin}/*`,
  ])];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    tempRoot,
    extensionDir,
  };
}

async function extensionIdFor(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  return worker.url().split('/')[2];
}

async function sendExtensionMessage(extensionPage, message) {
  return extensionPage.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
}

async function runFixtureTests() {
  const hermesRequests = [];
  const hermes = await createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (url.pathname === '/v1/models') {
      sendJson(response, 200, { data: [{ id: 'hermes-agent' }] });
      return;
    }
    if (url.pathname === '/v1/live-sessions/current') {
      sendJson(response, 404, { error: 'none' });
      return;
    }
    if (url.pathname === '/v1/responses') {
      const body = await readJsonRequest(request);
      hermesRequests.push(body);
      sendJson(response, 200, {
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Fixture handoff bundle from Hermes.' },
            ],
          },
        ],
      });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });

  const fixture = await createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(fixtureHtml(url.pathname));
  });

  const { tempRoot, extensionDir } = await prepareExtensionCopy({
    hermesOrigin: hermes.origin,
    fixtureOrigin: fixture.origin,
  });
  const userDataDir = path.join(tempRoot, 'profile');
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });

    const extensionId = await extensionIdFor(context);
    const articlePage = await context.newPage();
    await articlePage.goto(`${fixture.origin}/article`);
    await articlePage.focus('#secret-input');

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await extensionPage.waitForSelector('#status-label');

    await sendExtensionMessage(extensionPage, {
      type: 'SAVE_CONFIG',
      config: {
        baseUrl: hermes.origin,
        apiKey: 'local-key',
        conversationPrefix: 'e2e-relay',
        customAssistantHosts: ['127.0.0.1'],
      },
    });

    await articlePage.bringToFront();
    const built = await sendExtensionMessage(extensionPage, {
      type: 'BUILD_CONTEXT',
      prompt: 'Build context for fixture.',
      target: 'generic',
    });
    assert.equal(built.ok, true, `${built.error || JSON.stringify(built)} requests=${JSON.stringify(hermesRequests)}`);
    assert.equal(built.queued, undefined);
    assert.match(built.text, /Fixture handoff bundle/);

    const responseRequest = hermesRequests.find((item) => String(item.input || '').includes('Browser context envelope'));
    assert.ok(responseRequest, 'expected Hermes /v1/responses to receive browser context');
    const sentPrompt = responseRequest.input;
    assert.match(sentPrompt, /Useful public context stays visible/);
    assert.match(sentPrompt, /\[redacted\]/);
    assert.doesNotMatch(sentPrompt, /sk_test|sk_live|ghp_|4111 1111|focused-value-should-not-leak|abcdefghijklmnop123456/);

    const textareaPage = await context.newPage();
    await textareaPage.goto(`${fixture.origin}/chat-textarea`);
    await textareaPage.bringToFront();
    const insertedTextarea = await sendExtensionMessage(extensionPage, { type: 'INSERT_LATEST_CONTEXT' });
    assert.equal(insertedTextarea.ok, true);
    await textareaPage.waitForFunction(() => document.querySelector('#prompt-textarea').value.includes('Fixture handoff bundle'));

    const editablePage = await context.newPage();
    await editablePage.goto(`${fixture.origin}/chat-editable`);
    await editablePage.bringToFront();
    const insertedEditable = await sendExtensionMessage(extensionPage, { type: 'INSERT_LATEST_CONTEXT' });
    assert.equal(insertedEditable.ok, true);
    await editablePage.waitForFunction(() => document.querySelector('#editor').textContent.includes('Fixture handoff bundle'));

    const sidepanelPage = await context.newPage();
    await sidepanelPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await sidepanelPage.waitForSelector('text=Hermes Workspace');

    await sendExtensionMessage(extensionPage, {
      type: 'SAVE_WORKSPACE_STATE',
      url: `${fixture.origin}/article`,
      patch: {
        prompt: 'persist me',
        output: 'persisted output',
      },
    });
    const state = await sendExtensionMessage(extensionPage, {
      type: 'GET_WORKSPACE_STATE',
      url: `${fixture.origin}/article`,
    });
    assert.equal(state.ok, true);
    assert.equal(state.workspaceState.prompt, 'persist me');
    assert.equal(state.workspaceState.output, 'persisted output');

    if (process.env.HERMES_RELAY_LIVE_PROVIDER_SMOKE === '1') {
      const liveUrl = process.env.HERMES_RELAY_LIVE_PROVIDER_URL || 'https://chatgpt.com/';
      const livePage = await context.newPage();
      await livePage.goto(liveUrl, { waitUntil: 'domcontentloaded' });
      assert.ok(await livePage.title());
    }
  } finally {
    await context?.close();
    await hermes.close();
    await fixture.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

runFixtureTests().then(() => {
  console.log('extension fixture e2e ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
