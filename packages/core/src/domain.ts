import { z } from 'zod';
import type { CreditInput, Decision, ReasonCode } from './credit';
import type { Ore } from './money';
import type { Instalment, Offer, TermMonths } from './pricing';
import type { ApplicationStatus } from './status';

/** Application and loan ids (ULIDs) as they may appear in a URL path. */
export const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const IdSchema = z.string().regex(ID_PATTERN, 'not a valid id');

export type Application = {
  id: string;
  correlationId: string;
  orgNr: string;
  companyName: string;
  amount: Ore;
  termMonths: TermMonths;
  status: ApplicationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  company?: CreditInput;
  decision?: Decision;
  offer?: Offer;
  offerExpiresAt?: string;
  /** Step Functions task token while waiting for signature. Never sent to clients. */
  taskToken?: string;
  manualReviewReason?: ReasonCode;
};

export type PublicApplication = Omit<Application, 'taskToken'>;

export function toPublicApplication(app: Application): PublicApplication {
  const { taskToken: _secret, ...rest } = app;
  return rest;
}

/** What a customer may see: no task token, no company credit data, no decision inputs. */
export type CustomerApplication = Omit<Application, 'taskToken' | 'company' | 'decision'> & {
  decision?: Omit<Decision, 'inputs'>;
};

export function toCustomerApplication(app: Application): CustomerApplication {
  const { taskToken: _token, company: _company, decision, ...rest } = app;
  if (!decision) return rest;
  const { inputs: _inputs, ...safeDecision } = decision;
  return { ...rest, decision: safeDecision };
}

export type LoanStatus = 'ACTIVE' | 'REPAID';

/** The loan id is the application id. */
export type Loan = {
  id: string;
  applicationId: string;
  correlationId: string;
  principal: Ore;
  schedule: Instalment[];
  paidInstalments: number;
  balance: Ore;
  status: LoanStatus;
  payoutId: string;
  version: number;
  disbursedAt: string;
};

export const nextInstalment = (loan: Loan): Instalment | undefined => loan.schedule[loan.paidInstalments];

/** One row of an application's timeline, as stored by the timeline consumer. */
export type TimelineItem = { eventId: string; type: string; occurredAt: string; sequence: number; summary: string };

/** Events can arrive out of order: sort by time, then by sequence within the same write. */
export const compareTimeline = (a: TimelineItem, b: TimelineItem): number =>
  a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence;
