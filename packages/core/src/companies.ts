import { kr, type Ore } from './money';

export type Company = {
  orgNr: string;
  name: string;
  ageMonths: number;
  avgMonthlyInflow: Ore;
  paymentRemarks: boolean;
  bankrupt: boolean;
  /** How the fake company registry behaves for this company. */
  registryBehaviour: 'ok' | 'unavailable';
};

/** Made-up companies. There is no free-text org number field, so real data cannot be entered. */
export const TEST_COMPANIES: readonly Company[] = [
  { orgNr: '559900-0001', name: 'Kafé Solsidan AB', ageMonths: 48, avgMonthlyInflow: kr(400_000), paymentRemarks: false, bankrupt: false, registryBehaviour: 'ok' },
  { orgNr: '559900-0002', name: 'Bygg & Montage AB', ageMonths: 24, avgMonthlyInflow: kr(60_000), paymentRemarks: false, bankrupt: false, registryBehaviour: 'ok' },
  { orgNr: '559900-0003', name: 'Skuldsatt AB', ageMonths: 36, avgMonthlyInflow: kr(200_000), paymentRemarks: true, bankrupt: false, registryBehaviour: 'ok' },
  { orgNr: '559900-0004', name: 'Långsam Data AB', ageMonths: 60, avgMonthlyInflow: kr(500_000), paymentRemarks: false, bankrupt: false, registryBehaviour: 'unavailable' },
];

export const findCompany = (orgNr: string): Company | undefined => TEST_COMPANIES.find((c) => c.orgNr === orgNr);
