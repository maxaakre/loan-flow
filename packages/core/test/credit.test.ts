import { describe, expect, it } from 'vitest';
import { findCompany, TEST_COMPANIES } from '../src/companies';
import { assess, riskBandFor, RULES_VERSION } from '../src/credit';
import { kr } from '../src/money';
import { buildOffer, maxMonthlyCost } from '../src/pricing';

const company = (orgNr: string) => {
  const c = findCompany(orgNr);
  if (!c) throw new Error(`missing ${orgNr}`);
  return c;
};

describe('test companies', () => {
  it('has four companies with unique org numbers', () => {
    expect(new Set(TEST_COMPANIES.map((c) => c.orgNr)).size).toBe(4);
  });
});

describe('riskBandFor', () => {
  it('maps company age to a band', () => {
    expect(riskBandFor(48)).toBe('A');
    expect(riskBandFor(24)).toBe('B');
    expect(riskBandFor(8)).toBe('C');
  });
});

describe('assess', () => {
  it('approves Kafé Solsidan for 200 000 kr over 12 months', () => {
    const d = assess(company('559900-0001'), { amount: kr(200_000), termMonths: 12 });
    expect(d.outcome).toBe('APPROVED');
    expect(d.approvedAmount).toBe(kr(200_000));
    expect(d.riskBand).toBe('A');
    expect(d.rulesVersion).toBe(RULES_VERSION);
  });

  it('approves Bygg & Montage with a lower amount that fits 15 % of cash flow', () => {
    const c = company('559900-0002');
    const d = assess(c, { amount: kr(200_000), termMonths: 12 });
    expect(d.outcome).toBe('APPROVED_WITH_CHANGES');
    expect(d.reasons).toEqual(['LOW_CASHFLOW']);
    expect(d.approvedAmount).toBe(kr(88_000));
    const offer = buildOffer(d.approvedAmount!, 12, d.riskBand);
    expect(maxMonthlyCost(offer)).toBeLessThanOrEqual(Math.floor(c.avgMonthlyInflow * 0.15));
  });

  it('declines Skuldsatt AB for payment remarks', () => {
    const d = assess(company('559900-0003'), { amount: kr(50_000), termMonths: 6 });
    expect(d.outcome).toBe('DECLINED');
    expect(d.reasons).toEqual(['PAYMENT_REMARKS']);
    expect(d.approvedAmount).toBeUndefined();
  });

  it('declines bankrupt companies first', () => {
    const d = assess({ ...company('559900-0001'), bankrupt: true }, { amount: kr(50_000), termMonths: 6 });
    expect(d.reasons).toEqual(['BANKRUPTCY']);
  });

  it('declines companies younger than 6 months', () => {
    const d = assess({ ...company('559900-0001'), ageMonths: 5 }, { amount: kr(50_000), termMonths: 6 });
    expect(d).toMatchObject({ outcome: 'DECLINED', reasons: ['COMPANY_TOO_YOUNG'] });
  });

  it('sends amounts over 1 000 000 kr to manual review', () => {
    const d = assess(company('559900-0001'), { amount: kr(1_000_001), termMonths: 24 });
    expect(d).toMatchObject({ outcome: 'MANUAL_REVIEW', reasons: ['AMOUNT_ABOVE_AUTO_LIMIT'] });
  });

  it('declines when even the minimum amount does not fit cash flow', () => {
    const d = assess(
      { ...company('559900-0002'), avgMonthlyInflow: kr(5_000) },
      { amount: kr(100_000), termMonths: 6 },
    );
    expect(d).toMatchObject({ outcome: 'DECLINED', reasons: ['LOW_CASHFLOW'] });
  });

  it('records the inputs it used', () => {
    const d = assess(company('559900-0001'), { amount: kr(200_000), termMonths: 12 });
    expect(d.inputs).toMatchObject({ ageMonths: 48, amount: kr(200_000), termMonths: 12, monthlyCostLimit: kr(60_000) });
  });
});
