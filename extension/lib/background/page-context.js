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

        return {
          title,
          url,
          hostname,
          selection,
          description,
          headings,
          pageType,
          text,
        };
      },
    });

    return result;
  }

  async function ensureChatBridge(tabId) {
    await scripting.executeScript({
      target: { tabId },
      files: ['content/chat.js'],
    });
  }

  return {
    ensureChatBridge,
    getActiveTab,
    isRestrictedBrowserUrl,
    unsupportedPageMessage,
    extractPageContext,
  };
}
