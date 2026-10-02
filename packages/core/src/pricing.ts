import { addOre, ore, percentOf, type Ore } from './money';

export const TERMS = [6, 12, 24] as const;
export type TermMonths = (typeof TERMS)[number];

export type RiskBand = 'A' | 'B' | 'C';
/** Made-up pricing: a fixed monthly fee as a share of the loan amount. Not Qred's real model. */
export const MONTHLY_FEE_RATE: Record<RiskBand, number> = { A: 0.012, B: 0.018, C: 0.025 };

export type Instalment = { number: number; principal: Ore; fee: Ore; total: Ore };

export type Offer = {
  amount: Ore;
  termMonths: TermMonths;
  riskBand: RiskBand;
  monthlyFeeRate: number;
  monthlyFee: Ore;
  schedule: Instalment[];
  totalFees: Ore;
  totalCost: Ore;
};

export function buildOffer(amount: Ore, termMonths: TermMonths, riskBand: RiskBand): Offer {
  if (amount <= 0) throw new RangeError('Amount must be positive');
  const monthlyFeeRate = MONTHLY_FEE_RATE[riskBand];
  const monthlyFee = percentOf(amount, monthlyFeeRate);
  const basePrincipal = Math.floor(amount / termMonths);

  const schedule: Instalment[] = Array.from({ length: termMonths }, (_, i) => {
    const isLast = i === termMonths - 1;
    // The last instalment absorbs the rounding remainder, so the parts sum exactly to the amount
    const principal = ore(isLast ? amount - basePrincipal * (termMonths - 1) : basePrincipal);
    return { number: i + 1, principal, fee: monthlyFee, total: addOre(principal, monthlyFee) };
  });

  const totalFees = ore(monthlyFee * termMonths);
  return { amount, termMonths, riskBand, monthlyFeeRate, monthlyFee, schedule, totalFees, totalCost: addOre(amount, totalFees) };
}

export const maxMonthlyCost = (offer: Offer): Ore => ore(Math.max(...offer.schedule.map((i) => i.total)));
