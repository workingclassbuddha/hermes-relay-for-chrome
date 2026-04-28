export const $ = (id) => document.getElementById(id);

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function relativeTime(iso) {
  if (!iso) return 'just now';
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return 'just now';
  const mins = Math.round(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function setBusy(button, label, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.wasDisabled = button.disabled ? 'true' : 'false';
    button.textContent = label;
    button.disabled = true;
    return;
  }

  button.textContent = button.dataset.label || button.textContent;
  button.disabled = button.dataset.wasDisabled === 'true';
}
