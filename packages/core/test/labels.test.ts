import { describe, expect, it } from 'vitest';
import { amountRangeMessage } from '../src/credit';
import { compareTimeline, ID_PATTERN, type TimelineItem } from '../src/domain';
import { STATUS_SV } from '../src/labels';

describe('shared helpers', () => {
  it('has a Swedish label for every status', () => {
    expect(STATUS_SV.MANUAL_REVIEW).toBe('Manuell granskning');
  });

  it('builds the amount range message from the limits', () => {
    expect(amountRangeMessage().replace(/\s/g, ' ')).toBe('Beloppet måste vara mellan 10 000 kr och 2 000 000 kr.');
  });

  it('sorts the timeline by time, then sequence', () => {
    const item = (eventId: string, occurredAt: string, sequence: number): TimelineItem => ({
      eventId,
      type: 'X',
      occurredAt,
      sequence,
      summary: '',
    });
    const items = [item('c', '2026-10-02T10:00:01Z', 10), item('b', '2026-10-02T10:00:00Z', 11), item('a', '2026-10-02T10:00:00Z', 10)];
    expect(items.sort(compareTimeline).map((i) => i.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('accepts ULIDs and rejects path tricks', () => {
    expect(ID_PATTERN.test('01JAPP0000000000000000000A')).toBe(true);
    expect(ID_PATTERN.test('../x')).toBe(false);
  });
});
