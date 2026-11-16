// Human-readable summaries shared by the service worker and the popup.

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** "2 groups created · 1 tab moved" */
export function summarizeRun(applied) {
  const created = applied.filter((item) => !item.existing).length;
  const moved = applied.filter((item) => item.existing).reduce((total, item) => total + item.count, 0);
  const parts = [];
  if (created) parts.push(`${plural(created, 'group')} ${created > 1 ? 'created' : 'created'}`);
  if (moved) parts.push(`${plural(moved, 'tab')} ${moved > 1 ? 'moved' : 'moved'}`);
  return parts.join(' · ') || 'No relevant grouping found';
}

/** "<title> (4) · <title> (+1)" */
export function describeApplied(applied) {
  return applied.map((item) => `${item.title || 'Sans nom'} (${item.existing ? '+' : ''}${item.count})`).join(' · ');
}

export function sourceLabel(source, model) {
  switch (source) {
    case 'gemini':
      return model ? `Gemini (${model})` : 'Gemini';
    case 'cache':
      return 'local cache';
    case 'heuristic':
      return 'local heuristic';
    default:
      return source ?? '';
  }
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** "19:00" in the user's time zone ('demain' when the date is unusable). */
export function formatTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'tomorrow';
  return new Date(time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/** "12/50 aujourd'hui"; '' without a daily limit (owner token). */
export function formatQuota(quota) {
  if (!quota || !Number.isFinite(quota.used) || !Number.isFinite(quota.limit)) return '';
  return `${quota.used}/${quota.limit} today`;
}
