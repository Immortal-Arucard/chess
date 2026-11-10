const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mentionParts(body, mentions) {
  const text = String(body || '');
  const spans = (Array.isArray(mentions) ? mentions : [])
    .map((item) => ({
      id: item && typeof item.id === 'string' ? item.id : '',
      start: Number(item && item.start),
      end: Number(item && item.end),
      text: item && typeof item.text === 'string' ? item.text : ''
    }))
    .filter((item) => UUID.test(item.id) && Number.isInteger(item.start) && Number.isInteger(item.end))
    .sort((left, right) => left.start - right.start);
  const parts = [];
  let cursor = 0;
  spans.forEach((span) => {
    if (span.start < cursor || span.end > text.length || span.start >= span.end) return;
    if (text.slice(span.start, span.end) !== span.text) return;
    if (span.start > cursor) parts.push({ type: 'text', text: text.slice(cursor, span.start) });
    parts.push({ type: 'link', text: span.text, href: '/community/profile/?id=' + span.id });
    cursor = span.end;
  });
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}
