# LoanFlow — Design Spec

**Date:** 2026-10-02
**Author:** Max Aakre
**Status:** Draft — awaiting review

## 1. Purpose

A small, live, deployed demo to bring to the **technical interview** for the
**Senior Backend Developer (Node.js)** role at Qred.

It shows a **business loan** going from application to payout and repayment,
built as an **event-driven, serverless** system on AWS in TypeScript.

The demo is a conversation piece. The code matters, but the **reasoning behind
each choice** matters more. Every major choice has a short decision note (ADR).

**What it shows**

- **Event-driven architecture** — orchestration inside the loan process,
  choreography between parts.
- **Money done right** — integer öre, double-entry ledger, append-only.
- **Exactly-once in effect** — idempotent APIs and consumers on top of
  at-least-once delivery.
- **Transactional outbox** — events come only from data that was saved.
- **Failure handling** — retries with backoff, DLQs, race-free signing,
  crash-safe payout.
- **Production ownership** — CI/CD, structured logs, tracing, metrics, alarms.
- **AI in the workflow** — a read-only MCP server for case handlers.

**Success criteria**

- A public URL that works during the interview.
- The full flow works live: apply → decision → offer → sign → payout → repayment.
- The event timeline in the UI shows each step as it happens.
- A failing external service visibly retries, then lands in manual review.
- The MCP server can explain a decision from Claude Code / Claude Desktop.
- Runs inside the **AWS free tier** (plus a few cents of EventBridge).
- No long-lived AWS access keys anywhere.
- Fits in **3–5 days** of work.

## 2. Non-goals

- No real money, no real bank, no real credit bureau.
- No real login or BankID. Test companies are picked from a list.
- No free-text org number field, so no real company data can be entered.
- No Qred branding. The product is called **LoanFlow**.
- No multi-region, no custom domain, no WebSocket push (polling is fine).
- No VPC, NAT Gateway, RDS, Fargate, Secrets Manager or customer KMS keys (cost).
- One UI language: Swedish. Code and docs in English.

## 3. User flow

A **"Demo — inga riktiga lån"** banner is shown on every page.

1. **Apply** — pick a test company, an amount (10 000 – 2 000 000 kr) and a
   term (6, 12, 24 months). Submit.
2. **Application page** — shows status, and polls every 2 s.
   - While assessing: "Vi hämtar uppgifter om företaget…"
   - When offered: the offer with **monthly cost and total cost**, and a
     **Sign** button. The offer expires after 7 days.
   - When declined: a calm message with the reason in plain words.
   - When in manual review: "En handläggare tittar på ansökan."
3. **Timeline** — on the same page, every domain event appears as it happens
   (type, time, short summary).
4. **Loan page** (after payout) — balance, repayment plan, ledger entries and
   a **Simulate payment** button that pays the next instalment.

**Test companies**

| Company | Data | Outcome |
|---|---|---|
| Kafé Solsidan AB | 4 years, good cash flow | Approved |
| Bygg & Montage AB | 2 years, tight cash flow | Approved with lower amount |
| Skuldsatt AB | payment remarks | Declined |
| Långsam Data AB | registry always times out | Retries → manual review |

Any amount over 1 000 000 kr goes to manual review.

## 4. Architecture

```
 Web (React)                            MCP server (local, stdio)
     │ polling                               │ SigV4, read-only
     ▼                                       ▼
 CloudFront ──► API Gateway (HTTP API) ──► API Lambdas
                                             │
                          starts / resumes   │ read / write
                                ▼            ▼
                       Step Functions ──► DynamoDB (one table)
                       (loan process)        │
                                │            │ Streams (outbox rows only)
                                │            ▼
                                │      EventBridge Pipe
                                │            ▼
                                │      EventBridge bus
                                │        │          │
                                │       SQS        SQS     (each with DLQ)
                                │        ▼          ▼
                                │    timeline   notifications
                                ▼
                         Fake services (company registry, bank)
```

**Principle:** orchestration **inside** the loan process (Step Functions owns
order, waiting and compensation). Choreography **between** parts (EventBridge;
new consumers can be added without touching the process).

### 4.1 Components

| Component | Kind | Job |
|---|---|---|
| `applications-api` | Lambda | `POST /api/applications`, `GET /api/applications/{id}`, `POST /api/applications/{id}/sign`, `GET /api/applications/{id}/events` |
| `loans-api` | Lambda | `GET /api/loans/{id}`, `POST /api/loans/{id}/payments` |
| `companies-api` | Lambda | `GET /api/companies` (the test list) |
| `internal-api` | Lambda | `GET /internal/*` read routes for MCP. IAM auth. |
| `LoanApplication` | Step Functions (Standard) | The loan process, see 4.2 |
| step Lambdas | Lambda | `fetch-company`, `assess-credit`, `create-offer`, `mark-signed`, `mark-expired`, `mark-manual-review`, `disburse` |
| `fake-registry` | Lambda | Returns company data. Random latency. `Långsam Data AB` always times out. |
| `fake-bank` | Lambda + table rows | Payout with idempotency key. Same key → same payout id. |
| outbox pipe | EventBridge Pipe | DynamoDB Stream (filter: new `OUTBOX#` rows) → bus |
| `timeline-consumer` | Lambda via SQS | Writes `EVT#` rows for the UI |
| `notifications-consumer` | Lambda via SQS | Logs a fake email per relevant event |
| `web` | S3 + CloudFront | React app; `/api/*` routed to API Gateway |
| `mcp` | Local Node process | Read-only tools over `/internal/*` |

All Lambdas: Node.js 22, ARM, no VPC, one IAM role each with only the
actions they use.

### 4.2 The loan process (Step Functions)

```
FetchCompany ──(retry 3x, backoff + jitter)──► AssessCredit
     │ fails after retries                         │
     ▼                                             ├─ DECLINED ──► end
MarkManualReview ──► end                           ├─ MANUAL_REVIEW ──► end
                                                   ▼
                                              CreateOffer
                                                   ▼
                              WaitForSignature (task token, timeout 7 days)
                                │ success                 │ timeout
                                ▼                         ▼
                            MarkSigned               MarkExpired ──► end
                                ▼
                     Disburse (retry 3x, idempotent)
                                ▼
                               end
```

- The execution name is the application id, so starting twice is a no-op.
- For the live demo, an env flag sets the offer timeout to 5 minutes.

## 5. Data model

### 5.1 Rules

- **Money is integer öre** (branded `Ore` type). Never floats.
- **The ledger is append-only.** Mistakes are fixed with a reversing entry.
- **Things that belong together are saved in one `TransactWriteItems`.**
- **Every aggregate has a `version`.** Writes are conditional on it
  (optimistic concurrency).

### 5.2 Single table `loanflow`

| Item | PK | SK | Fields |
|---|---|---|---|
| Application | `APP#<id>` | `META` | status, orgNr, companyName, amount, termMonths, decision, offer, taskToken, version, createdAt |
| Loan | `LOAN#<id>` | `META` | applicationId, principal, monthlyFee, schedule, balance, nextInstalment, status, version |
| Ledger entry | `LOAN#<id>` | `ENTRY#<ts>#<entryId>` | lines `[{ account, debit, credit }]`, reason, eventId |
| Idempotency | `IDEMP#<key>` | `META` | requestHash, response, TTL 24 h |
| Outbox | `OUTBOX#<eventId>` | `META` | the event envelope, TTL 24 h |
| Timeline | `APP#<id>` | `EVT#<seq>#<eventId>` | type, occurredAt, summary |
| Notification dedupe | `NOTIF#<eventId>` | `META` | TTL 7 days |
| Fake bank payout | `BANKPAYOUT#<key>` | `META` | payoutId, amount |

**GSI1:** `GSI1PK = STATUS#<status>`, `GSI1SK = createdAt` — for the case
handler list (MCP).

### 5.3 Application status

```
SUBMITTED → ASSESSING → OFFERED → SIGNED → DISBURSED
                │           │
                ├─► DECLINED └─► EXPIRED
                └─► MANUAL_REVIEW
```

Allowed transitions live in one pure function in `core`. Anything else throws.

Loan status: `ACTIVE → REPAID`. `POST /api/loans/{id}/payments` always pays
exactly the next instalment (no free amount), conditional on the loan `version`.

### 5.4 Ledger

Accounts: `LOAN_RECEIVABLE`, `BANK_PAYOUT`, `BANK_INCOMING`, `FEE_INCOME`.

| Event | Debit | Credit |
|---|---|---|
| Payout 100 000 kr | `LOAN_RECEIVABLE` 100 000 | `BANK_PAYOUT` 100 000 |
| Instalment 9 000 kr | `BANK_INCOMING` 9 000 | `LOAN_RECEIVABLE` 8 000, `FEE_INCOME` 1 000 |

- Every entry must balance (sum of debits = sum of credits). Enforced in
  `core` when the entry is built.
- The loan `balance` is updated in the same transaction as the entry.
- When the balance reaches 0, the loan status becomes `REPAID` and a
  `LoanRepaid` event is written.

### 5.5 Pricing (simplified)

- **Fixed monthly fee** = amount × monthly fee rate (1.0–2.5 % depending on
  risk band), **straight amortisation** (equal principal each month).
- Last instalment absorbs rounding, so principal parts sum exactly to the amount.
- The offer always shows monthly cost, total fees and total cost.
- This is a made-up model, not Qred's real pricing.

## 6. Events

### 6.1 Envelope

```ts
type DomainEvent<T extends string, D> = {
  eventId: string;        // ULID
  type: T;                // e.g. "CreditDecided"
  version: 1;             // schema version of this event type
  occurredAt: string;     // ISO 8601
  aggregateId: string;    // application id
  sequence: number;       // per-aggregate, from the aggregate version
  correlationId: string;  // follows one application through every service
  data: D;
};
```

### 6.2 Types

`ApplicationSubmitted`, `CompanyDataFetched`, `CreditDecided`, `OfferCreated`,
`OfferSigned`, `OfferExpired`, `ApplicationSentToManualReview`,
`LoanDisbursed`, `PaymentReceived`, `LoanRepaid`.

Schemas are zod schemas in `core`, shared by producers and consumers.

### 6.3 Outbox

- A state change and its outbox row are written in **one transaction**.
- The DynamoDB Stream is filtered to `INSERT` of `OUTBOX#` rows only.
- The Pipe sends the event to the bus with `detail-type = type`,
  `source = loanflow.applications` or `loanflow.loans`.
- No code calls `PutEvents` directly.

## 7. Failure handling

### 7.1 Delivery

- Streams, Pipes, EventBridge and SQS are all **at-least-once**, and
  EventBridge does not keep order. We build **exactly-once in effect**.
- **Timeline consumer:** conditional put on the `EVT#` key → duplicates are ignored.
  Sorted by `sequence`, so arrival order does not matter.
- **Notifications consumer:** conditional put of `NOTIF#<eventId>` before
  "sending" → no double emails.
- SQS: `ReportBatchItemFailures`, `maxReceiveCount = 3`, then DLQ.
  Visibility timeout = 6 × Lambda timeout.
- Pipe and EventBridge rule targets also have DLQs.

### 7.2 API idempotency

- `POST /applications`, `POST /sign` and `POST /payments` require an
  `Idempotency-Key` header (the web app sends a UUID per user action).
- The `IDEMP#` row is written in the same transaction as the effect.
- Same key + same body → stored response is returned.
- Same key + different body → `422`.

### 7.3 External service failure

- `FetchCompany` retries 3 times (2 s, ×2, full jitter).
- Still failing → `MarkManualReview`. A provider outage never becomes a decline.

### 7.4 Signing vs. expiry race

- `POST /sign` only calls `SendTaskSuccess`. It does **not** write status.
- A task token completes exactly once: either success or timeout.
  **Step Functions is the arbiter.**
- `MarkSigned` / `MarkExpired` write the status (condition: `OFFERED`).
- Token already used or timed out → `409` "Erbjudandet har gått ut".
- The API returns `202 Accepted`; the UI sees `SIGNED` via polling.

### 7.5 Crash-safe payout

`Disburse` does:

1. Call `fake-bank` with idempotency key = application id.
2. One transaction: application → `DISBURSED`, create loan, ledger entry,
   outbox row. Condition: application status is `SIGNED`.

If the Lambda dies between 1 and 2, Step Functions retries. The bank returns
the same payout. If the condition fails because status is already
`DISBURSED`, the step returns success. **There is never a second payout.**

### 7.6 Errors at the edge

- zod validates every request body and path parameter.
- One error shape: `application/problem+json` with `type`, `title`, `status`,
  `detail`, `correlationId`.

## 8. Credit rules

- A pure function in `core`: `assess(company, request) → Decision`.
- `Decision = { outcome, reasons: ReasonCode[], rulesVersion, riskBand, maxAmount? }`.
- `outcome`: `APPROVED`, `APPROVED_WITH_CHANGES`, `DECLINED`, `MANUAL_REVIEW`.
- `rulesVersion` is stored with every decision.

Rules, in order:

1. Bankrupt or payment remarks → `DECLINED` (`PAYMENT_REMARKS`, `BANKRUPTCY`).
2. Company younger than 6 months → `DECLINED` (`COMPANY_TOO_YOUNG`).
3. Amount over 1 000 000 kr → `MANUAL_REVIEW` (`AMOUNT_ABOVE_AUTO_LIMIT`).
4. Monthly cost over 15 % of average monthly inflow → `APPROVED_WITH_CHANGES`
   with the highest amount that fits (`LOW_CASHFLOW`). If that is under
   10 000 kr → `DECLINED`.
5. Otherwise → `APPROVED`.

## 9. MCP server

- TypeScript, `@modelcontextprotocol/sdk`, stdio transport. Runs locally.
- Calls `GET /internal/*` on the deployed API, signed with **SigV4** using the
  developer's local credentials (`aws login`). No secrets.
- The `/internal/*` routes use IAM auth. A dedicated role may only call
  `execute-api:Invoke` on `GET /internal/*`.

| Tool | Returns |
|---|---|
| `list_applications` | by status (uses GSI1) |
| `get_application` | full application incl. offer |
| `explain_decision` | outcome, reason codes, rule inputs, `rulesVersion` |
| `list_events` | the timeline |
| `get_ledger` | ledger entries and balance for a loan |

The MCP server is **read-only**. It cannot decide, sign or pay. The model
explains; `core` computes.

## 10. Observability

- AWS Lambda Powertools (TypeScript): logger, tracer, metrics.
- `correlationId` on every log line, event and error response.
- X-Ray tracing on Lambdas and Step Functions.
- Metrics: `Applications` by outcome, `TimeToDecision`, `Payouts`, `PaymentsReceived`.
- One CloudWatch dashboard. Alarms: any DLQ depth > 0, Step Functions
  `ExecutionsFailed` > 0, API 5xx rate.
- An **AWS Budget alert at $5**.

## 11. Testing

| Level | What | Tool |
|---|---|---|
| `core` unit | credit rules, status transitions, pricing, event schemas | Vitest |
| `core` property | every ledger entry balances; principal parts sum to amount; balance never negative | fast-check |
| handlers | idempotency, conditional writes, error paths, duplicate events | Vitest + `aws-sdk-client-mock` |
| infra | least privilege per role, DLQ on every queue, retries on the state machine | CDK assertions |
| post-deploy | apply → offered → sign → disbursed → pay; Långsam Data → manual review | smoke script in CI |

## 12. Repo layout

```
apps/web          React + Vite UI
packages/core     money, pricing, credit rules, status machine, ledger, event schemas
services/api      all Lambdas (api, steps, consumers, fakes) + shared http/db helpers
services/mcp      MCP server
infra             CDK app (one stack)
docs/decisions    ADRs
docs/superpowers  spec and plan
```

pnpm workspaces, TypeScript strict, ESLint, Prettier. Region `eu-north-1`.

## 13. Delivery

- GitHub Actions: lint, typecheck, test on every push; deploy + smoke test on `main`.
- GitHub OIDC role for deploys. No access keys.

## 14. Decision notes (ADRs) to write

1. Orchestration inside the process, choreography between parts.
2. Transactional outbox with DynamoDB Streams + EventBridge Pipes.
3. Exactly-once in effect: idempotency everywhere.
4. Double-entry, append-only ledger in DynamoDB (and what we give up vs Postgres).
5. Step Functions as the arbiter for the signing race.
6. Free-tier constraints: no VPC, polling over WebSocket.
7. Read-only MCP with IAM auth.

## 15. Interview notes

A private `interview.md` (excluded from git) with: 30-second pitch, demo
script, architecture walkthrough, "what I would do next in production",
and likely questions with answers.
