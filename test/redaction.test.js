import assert from 'node:assert/strict';
import test from 'node:test';

import { redactPageContext, redactText } from '../extension/lib/shared/redaction.js';

test('redactText removes credential-like values', () => {
  const redacted = redactText([
    'Authorization: Bearer abcdefghijklmnop123456',
    'api_key=sk_test_1234567890abcdef',
    'card 4111 1111 1111 1111',
    'ssn 123-45-6789',
  ].join('\n'));

  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /sk_test/);
  assert.doesNotMatch(redacted, /4111/);
  assert.doesNotMatch(redacted, /123-45-6789/);
  assert.match(redacted, /\[redacted\]/);
});

test('redactPageContext redacts page text, tables, links, forms, and focused editable values', () => {
  const page = redactPageContext({
    title: 'Secret sk_live_12345678901234567890',
    url: 'https://example.com/?access_token=secret-token-value',
    description: 'Bearer abcdefghijklmnop123456',
    selection: 'password=hunter2',
    headings: ['API key: ghp_123456789012345678901234567890123456'],
    links: [
      {
        text: 'Open token',
        href: 'https://example.com/callback?token=abcdef1234567890abcdef1234567890',
      },
    ],
    forms: [
      {
        id: 'login-form',
        name: 'password',
        action: 'https://example.com/post?api_key=abcdef1234567890abcdef',
        fields: [
          {
            tag: 'input',
            type: 'password',
            name: 'api_key',
            id: 'secret-field',
            placeholder: 'Paste API token',
            label: 'Client secret',
          },
        ],
      },
    ],
    tables: [
      {
        caption: 'Secrets',
        headers: ['token'],
        rows: [['4111 1111 1111 1111', '123-45-6789']],
      },
    ],
    focusedElement: {
      tag: 'input',
      type: 'text',
      name: 'query',
      id: 'focused',
      placeholder: 'Search',
      text: 'do not leak this focused value',
      editable: true,
    },
    text: 'The page contains api_key=abcdef1234567890abcdef and normal context.',
  });

  assert.equal(page.redacted, true);
  assert.equal(page.focusedElement.text, '');
  assert.equal(page.focusedElement.redacted, true);
  assert.doesNotMatch(JSON.stringify(page), /hunter2|sk_live|ghp_|4111|123-45-6789|do not leak/);
  assert.match(page.text, /normal context/);
});
