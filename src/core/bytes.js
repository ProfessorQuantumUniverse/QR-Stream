/** Small byte-wrangling helpers shared across the protocol and UI layers. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(text) {
  return encoder.encode(text);
}

export function utf8Decode(bytes) {
  return decoder.decode(bytes);
}

/** Human-readable byte counts, e.g. "1.4 MB". */
export function formatBytes(count) {
  if (count < 1024) return `${count} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Human-readable durations, e.g. "1m 20s". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
