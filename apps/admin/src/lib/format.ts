export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = bytes;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1_024;
    unit = candidate;
    if (amount < 1_024 || candidate === 'GiB') break;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}
