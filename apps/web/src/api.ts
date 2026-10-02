import type { LedgerEntry, Loan, Ore, PublicApplication, TermMonths, TimelineItem } from '@loanflow/core';

export type CompanyOption = { orgNr: string; name: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.detail ?? 'Något gick fel. Försök igen.');
  return body as T;
}

export const api = {
  companies: () => request<CompanyOption[]>('/api/companies'),
  apply: (input: { orgNr: string; amount: Ore; termMonths: TermMonths }, key: string) =>
    request<{ id: string }>('/api/applications', { method: 'POST', body: input, idempotencyKey: key }),
  application: (id: string) => request<PublicApplication>(`/api/applications/${id}`),
  events: (id: string) => request<TimelineItem[]>(`/api/applications/${id}/events`),
  sign: (id: string, key: string) => request<unknown>(`/api/applications/${id}/sign`, { method: 'POST', idempotencyKey: key }),
  loan: (id: string) => request<{ loan: Loan; ledger: LedgerEntry[] }>(`/api/loans/${id}`),
  pay: (id: string, key: string) => request<unknown>(`/api/loans/${id}/payments`, { method: 'POST', idempotencyKey: key }),
};
