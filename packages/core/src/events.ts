import { z } from 'zod';
import { DECISION_OUTCOMES, REASON_CODES } from './credit';
import { OUTCOME_SV } from './labels';
import { formatKr, OreSchema } from './money';
import { TERMS } from './pricing';

const outcome = z.enum(DECISION_OUTCOMES);
const reason = z.enum(REASON_CODES);

/** Shared by producers and consumers. Bump `version` in the envelope if a schema breaks. */
export const EVENT_SCHEMAS = {
  ApplicationSubmitted: z.object({
    orgNr: z.string(),
    companyName: z.string(),
    amount: OreSchema,
    termMonths: z.literal([...TERMS]),
  }),
  CompanyDataFetched: z.object({ orgNr: z.string(), ageMonths: z.number().int() }),
  CreditDecided: z.object({
    outcome,
    reasons: z.array(reason),
    rulesVersion: z.string(),
    approvedAmount: OreSchema.optional(),
  }),
  OfferCreated: z.object({
    amount: OreSchema,
    termMonths: z.literal([...TERMS]),
    monthlyFee: OreSchema,
    totalCost: OreSchema,
    expiresAt: z.string(),
  }),
  OfferSigned: z.object({ signedAt: z.string() }),
  OfferExpired: z.object({}),
  ApplicationSentToManualReview: z.object({ reason }),
  LoanDisbursed: z.object({ loanId: z.string(), amount: OreSchema, payoutId: z.string() }),
  PaymentReceived: z.object({
    loanId: z.string(),
    instalmentNumber: z.number().int(),
    amount: OreSchema,
    balance: OreSchema,
  }),
  LoanRepaid: z.object({ loanId: z.string() }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as [EventType, ...EventType[]];
export type EventData<T extends EventType> = z.output<(typeof EVENT_SCHEMAS)[T]>;

export type EventMeta = {
  eventId: string;
  occurredAt: string;
  aggregateId: string;
  /** Aggregate version × 10 + index within the write. Used for ordering only. */
  sequence: number;
  correlationId: string;
};

export type DomainEvent<T extends EventType = EventType> = {
  [K in T]: EventMeta & { type: K; version: 1; data: EventData<K> };
}[T];

/** Events that send the customer an email. The notifications rule only forwards these. */
export const NOTIFY_TYPES = [
  'OfferCreated',
  'OfferExpired',
  'ApplicationSentToManualReview',
  'LoanDisbursed',
  'LoanRepaid',
] as const satisfies readonly EventType[];
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export function makeEvent<T extends EventType>(type: T, meta: EventMeta, data: EventData<T>): DomainEvent<T> {
  const parsed = (EVENT_SCHEMAS[type] as z.ZodType).parse(data);
  return { ...meta, type, version: 1, data: parsed } as DomainEvent<T>;
}

const envelope = z.object({
  eventId: z.string(),
  occurredAt: z.string(),
  aggregateId: z.string(),
  sequence: z.number().int(),
  correlationId: z.string(),
  type: z.enum(EVENT_TYPES),
  version: z.literal(1),
  data: z.unknown(),
});

export function parseEvent(raw: unknown): DomainEvent {
  const e = envelope.parse(raw);
  const data = EVENT_SCHEMAS[e.type].parse(e.data);
  return { ...e, data } as DomainEvent;
}

/** One short Swedish line for the timeline. */
export function summarize(event: DomainEvent): string {
  switch (event.type) {
    case 'ApplicationSubmitted':
      return `Ansökan mottagen: ${formatKr(event.data.amount)} på ${event.data.termMonths} mån`;
    case 'CompanyDataFetched':
      return `Företagsdata hämtad (${event.data.ageMonths} mån gammalt)`;
    case 'CreditDecided':
      return event.data.approvedAmount !== undefined
        ? `${OUTCOME_SV[event.data.outcome]}: ${formatKr(event.data.approvedAmount)}`
        : OUTCOME_SV[event.data.outcome];
    case 'OfferCreated':
      return `Erbjudande: totalt ${formatKr(event.data.totalCost)}`;
    case 'OfferSigned':
      return 'Erbjudandet signerat';
    case 'OfferExpired':
      return 'Erbjudandet gick ut';
    case 'ApplicationSentToManualReview':
      return 'Skickad till handläggare';
    case 'LoanDisbursed':
      return `Utbetalt: ${formatKr(event.data.amount)}`;
    case 'PaymentReceived':
      return `Inbetalning ${event.data.instalmentNumber}: ${formatKr(event.data.amount)}`;
    case 'LoanRepaid':
      return 'Lånet är återbetalt';
  }
}
