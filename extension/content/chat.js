(function () {
  'use strict';

  let toastEl = null;

  function showToast(message, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.position = 'fixed';
      toastEl.style.right = '16px';
      toastEl.style.bottom = '16px';
      toastEl.style.zIndex = '2147483647';
      toastEl.style.maxWidth = '320px';
      toastEl.style.padding = '10px 14px';
      toastEl.style.borderRadius = '10px';
      toastEl.style.font = '13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif';
      toastEl.style.boxShadow = '0 12px 34px rgba(0,0,0,0.35)';
      toastEl.style.transition = 'opacity 140ms ease';
      document.body.appendChild(toastEl);
    }

    toastEl.textContent = message;
    toastEl.style.background = isError ? '#4a161c' : '#111827';
    toastEl.style.border = isError ? '1px solid #9f3040' : '1px solid #2a3550';
    toastEl.style.color = '#f5f7fb';
    toastEl.style.opacity = '1';

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      if (toastEl) {
        toastEl.style.opacity = '0';
      }
    }, 2400);
  }

  function findInput() {
    const selectors = [
      '#prompt-textarea',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"][data-slate-editor="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }

    return null;
  }

  function insertText(el, text) {
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'INSERT_HERMES_CONTEXT') {
      return;
    }

    try {
      const input = findInput();
      if (!input) {
        sendResponse({ ok: false, error: 'No compatible chat input found on this page.' });
        return;
      }

      const ok = insertText(input, message.text || '');
      if (!ok) {
        sendResponse({ ok: false, error: 'Could not insert text into chat input.' });
        return;
      }

      showToast('Hermes context inserted.', false);
      sendResponse({ ok: true });
    } catch (error) {
      showToast(error.message || 'Hermes insertion failed.', true);
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  });
})();
