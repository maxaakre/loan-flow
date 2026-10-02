import type { DecisionOutcome, ReasonCode } from './credit';
import type { ApplicationStatus } from './status';

/** Swedish labels shown to customers. One place, so the timeline and the web never disagree. */
export const OUTCOME_SV: Record<DecisionOutcome, string> = {
  APPROVED: 'Beviljad',
  APPROVED_WITH_CHANGES: 'Beviljad med ändring',
  DECLINED: 'Nekad',
  MANUAL_REVIEW: 'Manuell granskning',
};

export const STATUS_SV: Record<ApplicationStatus, string> = {
  SUBMITTED: 'Mottagen',
  ASSESSING: 'Bedöms',
  OFFERED: 'Erbjudande klart',
  SIGNED: 'Signerad',
  DISBURSED: 'Utbetald',
  DECLINED: 'Nekad',
  EXPIRED: 'Erbjudandet gick ut',
  MANUAL_REVIEW: 'Manuell granskning',
};

export const REASON_SV: Record<ReasonCode, string> = {
  BANKRUPTCY: 'Företaget är i konkurs.',
  PAYMENT_REMARKS: 'Företaget har betalningsanmärkningar.',
  COMPANY_TOO_YOUNG: 'Företaget är yngre än 6 månader.',
  AMOUNT_ABOVE_AUTO_LIMIT: 'Beloppet är för stort för ett automatiskt beslut.',
  LOW_CASHFLOW: 'Kassaflödet räcker inte för beloppet.',
  REGISTRY_UNAVAILABLE: 'Företagsregistret svarade inte.',
  PROCESS_FAILED: 'Något gick fel i handläggningen.',
};
