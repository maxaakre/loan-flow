export const appKey = (id: string) => ({ PK: `APP#${id}`, SK: 'META' });
export const loanKey = (id: string) => ({ PK: `LOAN#${id}`, SK: 'META' });
export const entryKey = (loanId: string, occurredAt: string, entryId: string) => ({
  PK: `LOAN#${loanId}`,
  SK: `ENTRY#${occurredAt}#${entryId}`,
});
export const idempKey = (key: string) => ({ PK: `IDEMP#${key}`, SK: 'META' });
export const outboxKey = (eventId: string) => ({ PK: `OUTBOX#${eventId}`, SK: 'META' });
export const timelineKey = (applicationId: string, eventId: string) => ({ PK: `APP#${applicationId}`, SK: `EVT#${eventId}` });
export const notifKey = (eventId: string) => ({ PK: `NOTIF#${eventId}`, SK: 'META' });
/** One counter per UTC day (`yyyy-mm-dd`) for the daily cap on new applications. */
export const appCountKey = (day: string) => ({ PK: `APPCOUNT#${day}`, SK: 'COUNT' });
export const bankPayoutKey = (key: string) => ({ PK: `BANKPAYOUT#${key}`, SK: 'META' });

export const ONE_DAY = 24 * 60 * 60;
/** Epoch seconds for the DynamoDB TTL attribute `ttl`. */
export const ttlIn = (seconds: number, nowMs = Date.now()): number => Math.floor(nowMs / 1000) + seconds;
