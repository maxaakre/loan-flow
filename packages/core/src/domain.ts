import type { CreditInput, Decision, ReasonCode } from './credit';
import type { Ore } from './money';
import type { Instalment, Offer, TermMonths } from './pricing';
import type { ApplicationStatus } from './status';

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
