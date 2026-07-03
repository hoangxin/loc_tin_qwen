// "DD/MM/YY - HH:mm" in Vietnam time, regardless of the viewer's own timezone.
export function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} - ${get('hour')}:${get('minute')}`;
}

// The summarization prompt tags PR/native-ads items by prefixing the summary
// with "(PR/native ads)" - pull that prefix out so the UI can show it next
// to the title instead of buried at the start of the summary paragraph.
const PR_TAG_PATTERN = /^\(\s*PR\s*\/\s*native\s*ads\s*\)[:.,]?\s*/i;

export function splitPrTag(summary: string): { prTag: string | null; summary: string } {
  const match = summary.match(PR_TAG_PATTERN);
  if (!match) return { prTag: null, summary };
  return { prTag: '(PR/native ads)', summary: summary.slice(match[0].length) };
}
