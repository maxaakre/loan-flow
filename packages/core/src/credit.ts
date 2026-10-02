import type { Company } from './companies';
import { kr, ore, percentOf, type Ore } from './money';
import { buildOffer, maxMonthlyCost, MONTHLY_FEE_RATE, type RiskBand, type TermMonths } from './pricing';

export const RULES_VERSION = '2026-10-01';
export const MIN_AMOUNT = kr(10_000);
export const MAX_AMOUNT = kr(2_000_000);
export const AUTO_LIMIT = kr(1_000_000);
const CASHFLOW_SHARE = 0.15;
const AMOUNT_STEP = kr(1_000);

export type DecisionOutcome = 'APPROVED' | 'APPROVED_WITH_CHANGES' | 'DECLINED' | 'MANUAL_REVIEW';
export type ReasonCode =
  | 'BANKRUPTCY'
  | 'PAYMENT_REMARKS'
  | 'COMPANY_TOO_YOUNG'
  | 'AMOUNT_ABOVE_AUTO_LIMIT'
  | 'LOW_CASHFLOW'
  | 'REGISTRY_UNAVAILABLE';

export type CreditInput = Pick<Company, 'ageMonths' | 'avgMonthlyInflow' | 'paymentRemarks' | 'bankrupt'>;
export type CreditRequest = { amount: Ore; termMonths: TermMonths };

export type Decision = {
  outcome: DecisionOutcome;
  reasons: ReasonCode[];
  rulesVersion: string;
  riskBand: RiskBand;
  /** Set when the outcome is APPROVED or APPROVED_WITH_CHANGES. */
  approvedAmount?: Ore;
  /** Everything the rules looked at, so a decision can be explained later. */
  inputs: CreditInput & CreditRequest & { monthlyCostLimit: Ore };
};

export const riskBandFor = (ageMonths: number): RiskBand => (ageMonths >= 36 ? 'A' : ageMonths >= 12 ? 'B' : 'C');

/** Highest amount (in 1 000 kr steps) whose largest instalment fits under the limit. */
function maxAffordableAmount(limit: Ore, termMonths: TermMonths, band: RiskBand): Ore {
  const perOre = 1 / termMonths + MONTHLY_FEE_RATE[band];
  let candidate = Math.floor(limit / perOre / AMOUNT_STEP) * AMOUNT_STEP;
  // The formula ignores rounding of the last instalment, so step down until it really fits
  while (candidate > 0 && maxMonthlyCost(buildOffer(ore(candidate), termMonths, band)) > limit) {
    candidate -= AMOUNT_STEP;
  }
  return ore(Math.max(candidate, 0));
}

export function assess(input: CreditInput, request: CreditRequest): Decision {
  const riskBand = riskBandFor(input.ageMonths);
  const monthlyCostLimit = percentOf(input.avgMonthlyInflow, CASHFLOW_SHARE);
  const base = {
    rulesVersion: RULES_VERSION,
    riskBand,
    inputs: {
      ageMonths: input.ageMonths,
      avgMonthlyInflow: input.avgMonthlyInflow,
      paymentRemarks: input.paymentRemarks,
      bankrupt: input.bankrupt,
      ...request,
      monthlyCostLimit,
    },
  };
  const decline = (reason: ReasonCode): Decision => ({ ...base, outcome: 'DECLINED', reasons: [reason] });

  // Rules run in order; the first one that matches decides
  if (input.bankrupt) return decline('BANKRUPTCY');
  if (input.paymentRemarks) return decline('PAYMENT_REMARKS');
  if (input.ageMonths < 6) return decline('COMPANY_TOO_YOUNG');
  if (request.amount > AUTO_LIMIT) return { ...base, outcome: 'MANUAL_REVIEW', reasons: ['AMOUNT_ABOVE_AUTO_LIMIT'] };

  const requested = buildOffer(request.amount, request.termMonths, riskBand);
  if (maxMonthlyCost(requested) <= monthlyCostLimit) {
    return { ...base, outcome: 'APPROVED', reasons: [], approvedAmount: request.amount };
  }
  const affordable = maxAffordableAmount(monthlyCostLimit, request.termMonths, riskBand);
  if (affordable < MIN_AMOUNT) return decline('LOW_CASHFLOW');
  return { ...base, outcome: 'APPROVED_WITH_CHANGES', reasons: ['LOW_CASHFLOW'], approvedAmount: affordable };
}
