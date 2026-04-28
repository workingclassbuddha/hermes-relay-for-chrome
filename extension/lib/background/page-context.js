import { redactPageContext } from '../shared/redaction.js';

export function createPageContextApi({
  tabs = globalThis.chrome?.tabs,
  scripting = globalThis.chrome?.scripting,
} = {}) {
  async function getActiveTab() {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function isRestrictedBrowserUrl(url) {
    const value = String(url || '').toLowerCase();
    return (
      value.startsWith('chrome://') ||
      value.startsWith('chrome-extension://') ||
      value.startsWith('edge://') ||
      value.startsWith('about:') ||
      value.startsWith('devtools://')
    );
  }

  function unsupportedPageMessage(url) {
    if (String(url || '').toLowerCase().startsWith('chrome://')) {
      return 'Hermes Relay cannot inspect browser-internal Chrome pages like chrome:// URLs.';
    }
    return 'Hermes Relay can only work with normal web pages, not browser-internal tabs.';
  }

  async function extractPageContext(tabId) {
    const tab = await tabs.get(tabId);
    if (isRestrictedBrowserUrl(tab?.url || '')) {
      throw new Error(unsupportedPageMessage(tab.url));
    }

    const [{ result }] = await scripting.executeScript({
      target: { tabId },
      func: () => {
        const title = document.title || '';
        const url = window.location.href;
        const hostname = window.location.hostname || '';
        const selection = window.getSelection?.().toString().trim() || '';
        const description = document.querySelector('meta[name="description"]')?.content?.trim() || '';
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 8)
          .map((el) => (el.textContent || '').trim())
          .filter(Boolean);
        const links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 25)
          .map((el) => ({
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            href: el.href,
          }))
          .filter((item) => item.text || item.href);
        const forms = Array.from(document.querySelectorAll('form'))
          .slice(0, 8)
          .map((form, index) => ({
            index,
            id: form.id || '',
            name: form.getAttribute('name') || '',
            action: form.action || '',
            method: form.method || 'get',
            fields: Array.from(form.querySelectorAll('input, textarea, select'))
              .slice(0, 20)
              .map((field) => ({
                tag: field.tagName.toLowerCase(),
                type: field.getAttribute('type') || '',
                name: field.getAttribute('name') || '',
                id: field.id || '',
                placeholder: field.getAttribute('placeholder') || '',
                label: field.labels?.[0]?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) || '',
              })),
          }));
        const tables = Array.from(document.querySelectorAll('table'))
          .slice(0, 5)
          .map((table, index) => ({
            index,
            caption: table.caption?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) || '',
            headers: Array.from(table.querySelectorAll('th')).slice(0, 20).map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim()),
            rows: Array.from(table.querySelectorAll('tr')).slice(0, 8).map((row) => (
              Array.from(row.children).slice(0, 8).map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120))
            )),
          }));
        const active = document.activeElement;
        const activeIsEditable = Boolean(active?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName));
        const focusedElement = active && active !== document.body
          ? {
              tag: active.tagName.toLowerCase(),
              type: active.getAttribute('type') || '',
              name: active.getAttribute('name') || '',
              id: active.id || '',
              placeholder: active.getAttribute('placeholder') || '',
              text: activeIsEditable ? '' : (active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
              editable: activeIsEditable,
              redacted: activeIsEditable,
            }
          : null;
        const root =
          document.querySelector('main') ||
          document.querySelector('article') ||
          document.body;
        const text = (root?.innerText || document.body?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 12000);

        const pageType =
          document.querySelector('article') ? 'article' :
          document.querySelector('form') ? 'form' :
          document.querySelector('[role="main"]') ? 'app' :
          'page';
        const loginWallLikely = /\b(sign in|log in|login|subscribe to continue|create account|join to continue|members only)\b/i.test(
          `${title} ${description} ${text}`,
        );
        const noisyPageLikely = pageType === 'app' || headings.length >= 6;

        return {
          title,
          url,
          hostname,
          selection,
          description,
          headings,
          links,
          forms,
          tables,
          focusedElement,
          pageType,
          signals: {
            loginWallLikely,
            noisyPageLikely,
          },
          text,
        };
      },
    });

    return redactPageContext(result);
  }

  async function ensureChatBridge(tabId) {
    await scripting.executeScript({
      target: { tabId },
      files: ['content/chat.js'],
    });
  }

  async function executeApprovedBrowserAction(tabId, action = {}) {
    const actionType = String(action?.action_type || action?.type || '').trim();
    const payload = action?.payload && typeof action.payload === 'object' ? action.payload : action;

    if (actionType === 'open_url') {
      const url = String(payload.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('Approved open_url action requires an http(s) URL.');
      }
      const tab = await tabs.create({ url });
      return { ok: true, action_type: actionType, tabId: tab?.id || null, url };
    }

    if (actionType === 'read_active_tab_snapshot' || actionType === 'extract_page_data') {
      return {
        ok: true,
        action_type: actionType,
        page: await extractPageContext(tabId),
      };
    }

    const [{ result }] = await scripting.executeScript({
      target: { tabId },
      args: [actionType, payload],
      func: (type, data) => {
        function setElementValue(el, value) {
          if (!el) return false;
          const nextValue = String(value || '');
          if ('value' in el) {
            el.focus();
            el.value = nextValue;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          if (el.isContentEditable) {
            el.focus();
            el.textContent = nextValue;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
            return true;
          }
          return false;
        }

        if (type === 'fill_focused_field' || type === 'insert_text') {
          const target = document.activeElement;
          if (!setElementValue(target, data.text || data.value || '')) {
            return { ok: false, error: 'No focused editable field found.' };
          }
          return {
            ok: true,
            action_type: type,
            target: {
              tag: target.tagName.toLowerCase(),
              id: target.id || '',
              name: target.getAttribute('name') || '',
            },
          };
        }

        if (type === 'click_element') {
          const selector = String(data.selector || '').trim();
          if (!selector) {
            return { ok: false, error: 'click_element requires a selector.' };
          }
          const el = document.querySelector(selector);
          if (!el) {
            return { ok: false, error: `No element matched selector ${selector}.` };
          }
          const text = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const expectedText = String(data.expectedText || data.previewText || '').trim();
          if (expectedText && !text.includes(expectedText)) {
            return { ok: false, error: 'Element text no longer matches the approved preview.' };
          }
          el.click();
          return {
            ok: true,
            action_type: type,
            selector,
            text: text.slice(0, 160),
          };
        }

        return { ok: false, error: `Unsupported browser action: ${type}` };
      },
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Approved browser action failed.');
    }
    return result;
  }

  return {
    ensureChatBridge,
    getActiveTab,
    isRestrictedBrowserUrl,
    unsupportedPageMessage,
    extractPageContext,
    executeApprovedBrowserAction,
  };
}
