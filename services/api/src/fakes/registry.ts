import { findCompany, type CreditInput } from '@loanflow/core';

export class RegistryUnavailableError extends Error {
  // Step Functions matches retries on this name
  override name = 'RegistryUnavailableError';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pretends to call a company registry: a bit slow, and down for Långsam Data AB. */
export async function lookupCompany(orgNr: string): Promise<CreditInput> {
  const company = findCompany(orgNr);
  if (!company) throw new Error(`Unknown org number ${orgNr}`);
  await sleep(Math.floor(Math.random() * Number(process.env.FAKE_LATENCY_MAX_MS ?? 500)));
  if (company.registryBehaviour === 'unavailable') {
    throw new RegistryUnavailableError(`Registry did not answer for ${orgNr}`);
  }
  const { ageMonths, avgMonthlyInflow, paymentRemarks, bankrupt } = company;
  return { ageMonths, avgMonthlyInflow, paymentRemarks, bankrupt };
}
