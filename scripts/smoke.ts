// End-to-end check against a deployed stack. Usage: tsx scripts/smoke.ts <siteUrl> <apiUrl>
import { randomUUID } from 'node:crypto';

const [site, apiUrl] = process.argv.slice(2).map((u) => u?.replace(/\/$/, ''));
if (!site || !apiUrl) throw new Error('usage: smoke.ts <siteUrl> <apiUrl>');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** CloudFront can answer with HTML (e.g. a 502). Keep the raw text and return null body instead of throwing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- smoke checks poke at arbitrary JSON
function parseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function call(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(`${site}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.key ? { 'idempotency-key': init.key } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: parseJson(text), text };
}

function check(ok: boolean, message: string, res?: { status: number; text: string }) {
  if (!ok) throw new Error(`FAIL ${message}${res ? `\n  status ${res.status}\n  body ${res.text.slice(0, 500)}` : ''}`);
  console.log(`ok   ${message}`);
}

async function waitFor<T>(what: string, load: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await load();
    if (done(value)) return value;
    if (Date.now() > until) throw new Error(`FAIL timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(2000);
  }
}

const status = (id: string) => call(`/api/applications/${id}`).then((r) => r.body?.status as string);

// Site and SPA rewrite
const home = await fetch(`${site}/applications/deep-link`).then((r) => r.text());
check(home.includes('<div id="root">'), 'deep links return the app');

const companies = await call('/api/companies');
check(companies.status === 200 && companies.body?.length === 4, 'four test companies', companies);

const missing = await call('/api/applications/does-not-exist');
check(missing.status === 404 && missing.type.includes('problem+json'), 'unknown application is a problem+json 404', missing);

// Happy path: apply → offer → sign → payout → pay
const applyKey = randomUUID();
const body = { orgNr: '559900-0001', amount: 20_000_000, termMonths: 6 };
const created = await call('/api/applications', { method: 'POST', body, key: applyKey });
check(created.status === 201, 'application created', created);
const id = created.body?.id as string;

const replay = await call('/api/applications', { method: 'POST', body, key: applyKey });
check(replay.body?.id === id, 'same Idempotency-Key returns the same application', replay);

await waitFor('OFFERED', () => status(id), (s) => s === 'OFFERED');
check(true, 'offer created');
const signed = await call(`/api/applications/${id}/sign`, { method: 'POST', key: randomUUID() });
check(signed.status === 202, 'signature accepted', signed);
await waitFor('DISBURSED', () => status(id), (s) => s === 'DISBURSED');
check(true, 'loan disbursed');

const paid = await call(`/api/loans/${id}/payments`, { method: 'POST', key: randomUUID() });
check(paid.status === 201 && paid.body?.instalmentNumber === 1, 'first instalment paid', paid);

await waitFor(
  'timeline',
  () => call(`/api/applications/${id}/events`).then((r) => r.body as { type: string }[]),
  (events) => (events ?? []).some((e) => e.type === 'PaymentReceived'),
  30_000,
);
check(true, 'timeline received every event');

// Failure path: registry down → retries → manual review
const slow = await call('/api/applications', {
  method: 'POST',
  body: { orgNr: '559900-0004', amount: 10_000_000, termMonths: 12 },
  key: randomUUID(),
});
await waitFor('MANUAL_REVIEW', () => status(slow.body?.id), (s) => s === 'MANUAL_REVIEW', 120_000);
check(true, 'registry outage ends in manual review');

// Internal API is not public
const internal = await fetch(`${apiUrl}/internal/applications`);
check(internal.status === 403, 'unsigned internal request is refused', { status: internal.status, text: await internal.text() });

console.log(`Smoke test passed for ${site}`);
