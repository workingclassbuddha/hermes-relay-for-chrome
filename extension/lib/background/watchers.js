import { canonicalizeUrl } from '../shared/utils.js';

export function createPageWatcherManager({
  storageApi,
  pageContextApi,
  alarms = globalThis.chrome?.alarms,
  tabs = globalThis.chrome?.tabs,
  alarmName = 'hermes-relay-watch-pages',
} = {}) {
  async function ensureAlarm() {
    if (!alarms?.create) return;
    const tracked = await storageApi.getTrackedPages();
    const hasWatchers = tracked.some((item) => item.watchEnabled);
    if (!hasWatchers) {
      await alarms.clear(alarmName);
      return;
    }
    alarms.create(alarmName, {
      periodInMinutes: 15,
    });
  }

  async function run() {
    const tracked = await storageApi.getTrackedPages();
    const watchers = tracked.filter((item) => item.watchEnabled);
    if (!watchers.length) {
      await ensureAlarm();
      return;
    }

    const openTabs = await tabs.query({});
    const nowIso = new Date().toISOString();
    for (const watcher of watchers) {
      const intervalMs = Math.max(15, Number(watcher.watchIntervalMinutes || 60)) * 60000;
      if (watcher.lastWatchAt && Date.now() - new Date(watcher.lastWatchAt).getTime() < intervalMs) {
        continue;
      }
      const tab = openTabs.find((item) => canonicalizeUrl(item.url || '') === canonicalizeUrl(watcher.url || ''));
      if (!tab?.id) {
        await storageApi.updateTrackedPage(watcher.url, {
          lastWatchAt: nowIso,
          lastWatchStatus: 'skipped-not-open',
        }).catch(() => null);
        continue;
      }
      try {
        const page = await pageContextApi.extractPageContext(tab.id);
        const saved = await storageApi.saveSnapshot(page, 'watcher');
        await storageApi.updateTrackedPage(watcher.url, {
          lastWatchAt: nowIso,
          lastWatchStatus: saved.unchanged ? 'unchanged' : 'changed',
        });
        if (!saved.unchanged) {
          await storageApi.pushRecent({
            type: 'page-watch-change',
            title: page.title || watcher.title || 'Watched page',
            url: page.url || watcher.url,
            summary: 'Watched page changed while open. A new snapshot was saved.',
            output: `Watched page changed: ${page.title || watcher.title || watcher.url}`,
            modeLabel: 'Page Watcher',
            scopeLabel: 'Readable page',
            destinationLabel: 'Workspace history',
            statusLabel: 'Changed',
            provenanceText: 'Used explicit page watcher + redacted readable page snapshot',
          });
        }
      } catch (error) {
        await storageApi.updateTrackedPage(watcher.url, {
          lastWatchAt: nowIso,
          lastWatchStatus: error.message || 'watch failed',
        }).catch(() => null);
      }
    }
  }

  return {
    alarmName,
    ensureAlarm,
    run,
  };
}
