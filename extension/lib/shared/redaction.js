const REDACTED = '[redacted]';

const SENSITIVE_FIELD_RE = /\b(pass(word|code|phrase)?|api[_-]?key|access[_-]?token|auth(orization)?|bearer|client[_-]?secret|secret|private[_-]?key|credential|ssn|credit[_-]?card|card[_-]?number)\b/i;

const SENSITIVE_VALUE_RULES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|secret|password|passwd)\s*[:=]\s*["']?[^"'\s,;]{4,}/gi,
  /\b(?:sk|pk|rk|ghp|gho|github_pat|AIza|xox[baprs]?|hf)_[A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Za-z0-9+/=_-]{40,}\b/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

export function redactText(value = '') {
  let text = String(value || '');
  for (const rule of SENSITIVE_VALUE_RULES) {
    text = text.replace(rule, REDACTED);
  }
  return text;
}

export function isSensitiveFieldName(value = '') {
  return SENSITIVE_FIELD_RE.test(String(value || ''));
}

function redactFieldValue(value = '') {
  const text = String(value || '');
  return isSensitiveFieldName(text) ? REDACTED : redactText(text);
}

function redactLink(link = {}) {
  return {
    ...link,
    text: redactText(link.text || ''),
    href: redactText(link.href || ''),
  };
}

function redactForm(form = {}) {
  return {
    ...form,
    id: redactFieldValue(form.id || ''),
    name: redactFieldValue(form.name || ''),
    action: redactText(form.action || ''),
    fields: (Array.isArray(form.fields) ? form.fields : []).map((field = {}) => ({
      ...field,
      type: redactFieldValue(field.type || ''),
      name: redactFieldValue(field.name || ''),
      id: redactFieldValue(field.id || ''),
      placeholder: redactFieldValue(field.placeholder || ''),
      label: redactFieldValue(field.label || ''),
    })),
  };
}

function redactTable(table = {}) {
  return {
    ...table,
    caption: redactText(table.caption || ''),
    headers: (Array.isArray(table.headers) ? table.headers : []).map(redactText),
    rows: (Array.isArray(table.rows) ? table.rows : []).map((row) => (
      (Array.isArray(row) ? row : []).map(redactText)
    )),
  };
}

function redactFocusedElement(focusedElement = null) {
  if (!focusedElement || typeof focusedElement !== 'object') {
    return focusedElement;
  }

  const editable = Boolean(focusedElement.editable);
  return {
    ...focusedElement,
    type: redactFieldValue(focusedElement.type || ''),
    name: redactFieldValue(focusedElement.name || ''),
    id: redactFieldValue(focusedElement.id || ''),
    placeholder: redactFieldValue(focusedElement.placeholder || ''),
    text: editable ? '' : redactText(focusedElement.text || ''),
    redacted: editable || Boolean(focusedElement.redacted),
  };
}

export function redactPageContext(page = {}) {
  const next = {
    ...page,
    title: redactText(page.title || ''),
    url: redactText(page.url || ''),
    description: redactText(page.description || ''),
    selection: redactText(page.selection || ''),
    headings: (Array.isArray(page.headings) ? page.headings : []).map(redactText),
    links: (Array.isArray(page.links) ? page.links : []).map(redactLink),
    forms: (Array.isArray(page.forms) ? page.forms : []).map(redactForm),
    tables: (Array.isArray(page.tables) ? page.tables : []).map(redactTable),
    focusedElement: redactFocusedElement(page.focusedElement || null),
    text: redactText(page.text || ''),
  };

  next.redacted = true;
  return next;
}
