import { compareTimeline, type TimelineItem } from '@loanflow/core';
import { formatTime } from '../format';

export function Timeline({ items }: { items: TimelineItem[] }) {
  // Events can arrive out of order, so sort here as well as on the server
  const sorted = [...items].sort(compareTimeline);
  if (sorted.length === 0) return <p className="muted">Väntar på händelser…</p>;
  return (
    <ol className="timeline">
      {sorted.map((e) => (
        <li key={e.eventId} data-event-id={e.eventId}>
          <time>{formatTime(e.occurredAt)}</time>
          <code>{e.type}</code>
          <span>{e.summary}</span>
        </li>
      ))}
    </ol>
  );
}
