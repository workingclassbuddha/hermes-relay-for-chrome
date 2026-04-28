(function () {
  'use strict';

  if (window.__hermesChatBridgeInstalled) {
    return;
  }
  window.__hermesChatBridgeInstalled = true;

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
    toastEl.style.background = isError ? '#4b2720' : '#2b311f';
    toastEl.style.border = isError ? '1px solid #a56f58' : '1px solid #5d6c46';
    toastEl.style.color = '#f2ead7';
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

  function insertionText(el, text) {
    const value = String(text || '');
    const currentText = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
      ? el.value
      : el.textContent;
    return currentText?.trim() ? `\n\n${value}` : value;
  }

  function setTextControlValue(el, value) {
    const prototype = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
  }

  function insertIntoTextControl(el, text) {
    const start = Number.isInteger(el.selectionStart) ? el.selectionStart : el.value.length;
    const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : start;
    const value = el.value || '';
    const insert = insertionText(el, text);
    const nextValue = `${value.slice(0, start)}${insert}${value.slice(end)}`;
    const nextCursor = start + insert.length;

    setTextControlValue(el, nextValue);
    el.setSelectionRange(nextCursor, nextCursor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function ensureSelectionInElement(el) {
    const selection = window.getSelection();
    if (!selection) return null;
    if (selection.rangeCount && el.contains(selection.anchorNode)) {
      return selection;
    }

    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  function insertIntoEditable(el, text) {
    const selection = ensureSelectionInElement(el);
    if (!selection) return false;

    const insert = insertionText(el, text);
    if (document.queryCommandSupported?.('insertText')) {
      document.execCommand('insertText', false, insert);
    } else {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(insert));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: insert, inputType: 'insertText' }));
    return true;
  }

  function insertText(el, text) {
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return insertIntoTextControl(el, text);
    }

    return insertIntoEditable(el, text);
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
