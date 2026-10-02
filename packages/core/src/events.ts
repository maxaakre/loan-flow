import { z } from 'zod';
import { formatKr, OreSchema } from './money';
import { TERMS } from './pricing';

const outcome = z.enum(['APPROVED', 'APPROVED_WITH_CHANGES', 'DECLINED', 'MANUAL_REVIEW']);
const reason = z.enum([
  'BANKRUPTCY',
  'PAYMENT_REMARKS',
  'COMPANY_TOO_YOUNG',
  'AMOUNT_ABOVE_AUTO_LIMIT',
  'LOW_CASHFLOW',
  'REGISTRY_UNAVAILABLE',
]);

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
    termMonths: z.number().int(),
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

export function makeEvent<T extends EventType>(type: T, meta: EventMeta, data: EventData<T>): DomainEvent<T> {
  EVENT_SCHEMAS[type].parse(data);
  return { ...meta, type, version: 1, data } as DomainEvent<T>;
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

const OUTCOME_SV = {
  APPROVED: 'Beviljad',
  APPROVED_WITH_CHANGES: 'Beviljad med ändring',
  DECLINED: 'Nekad',
  MANUAL_REVIEW: 'Manuell granskning',
} as const;

/** One short Swedish line for the timeline. */
export function summarize(event: DomainEvent): string {
  switch (event.type) {
    case 'ApplicationSubmitted':
      return `Ansökan mottagen: ${formatKr(event.data.amount)} på ${event.data.termMonths} mån`;
    case 'CompanyDataFetched':
      return `Företagsdata hämtad (${event.data.ageMonths} mån gammalt)`;
    case 'CreditDecided':
      return event.data.approvedAmount
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
