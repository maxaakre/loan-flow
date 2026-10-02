import { render, screen } from '@testing-library/react';
import { Timeline } from './Timeline';

describe('Timeline (Review Focus 4)', () => {
  it('sorts by occurredAt then sequence, whatever order the items arrive in', () => {
    render(
      <Timeline
        items={[
          { eventId: 'c', type: 'OfferCreated', occurredAt: '2026-10-02T10:00:01Z', sequence: 40, summary: 'third' },
          { eventId: 'a', type: 'ApplicationSubmitted', occurredAt: '2026-10-02T10:00:00Z', sequence: 10, summary: 'first' },
          { eventId: 'b', type: 'CreditDecided', occurredAt: '2026-10-02T10:00:01Z', sequence: 30, summary: 'second' },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.dataset.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('shows a waiting message when empty', () => {
    render(<Timeline items={[]} />);
    expect(screen.getByText('Väntar på händelser…')).toBeTruthy();
  });
});
