# LoanFlow

A demo **business-loan process** — apply, credit decision, offer, sign, payout, repayment — built as an **event-driven, serverless** system on AWS in TypeScript.

> ⚠️ Demo only. No real money, no real companies, no real credit data.

## What it shows

- **Orchestration inside the process** (Step Functions), **choreography between parts** (EventBridge).
- **Transactional outbox**: state and event are saved in one DynamoDB transaction; a stream Lambda publishes.
- **Exactly-once in effect**: idempotency keys on the API, idempotent consumers, crash-safe payout.
- **Money done right**: integer öre, double-entry append-only ledger, property-based tests.
- **Failure handling**: retries with jitter, DLQs with alarms, race-free signing vs. expiry.
- **Production basics**: CI/CD with OIDC (no keys), structured logs, tracing, metrics, dashboard, smoke test.
- **AI in the workflow**: a read-only MCP server for case handlers.

## Architecture

```mermaid
flowchart LR
  web[React app] -->|/api| cf[CloudFront] --> api[API Gateway]
  mcp[MCP server<br/>local, SigV4] -->|/internal| api
  api --> lambdas[API Lambdas]
  lambdas -->|state + outbox<br/>one transaction| ddb[(DynamoDB)]
  ddb -->|stream: OUTBOX# rows| relay[outbox-relay]
  relay --> bus{{EventBridge}}
  bus --> q1[SQS] --> start[start-process] --> sfn[Step Functions<br/>loan process]
  bus --> q2[SQS] --> timeline[timeline]
  bus --> q3[SQS] --> notify[notifications]
  sfn --> steps[step Lambdas] --> ddb
  lambdas -.->|SendTaskSuccess| sfn
```

### The loan process

```mermaid
stateDiagram-v2
  [*] --> FetchCompany
  FetchCompany --> ManualReview: registry down after retries
  FetchCompany --> AssessCredit
  AssessCredit --> Declined
  AssessCredit --> ManualReview: amount > 1 MSEK
  AssessCredit --> OfferAndWait: approved
  OfferAndWait --> Expired: timeout
  OfferAndWait --> Signed: customer signs
  Signed --> Disburse
  Disburse --> [*]
```

## Test companies

| Company | Outcome |
|---|---|
| Kafé Solsidan AB | Approved |
| Bygg & Montage AB | Approved with a lower amount |
| Skuldsatt AB | Declined (payment remarks) |
| Långsam Data AB | Registry down → retries → manual review |

## Run it

```bash
pnpm install
pnpm test                         # all unit, property and CDK tests
aws login                         # short-lived credentials, no keys
pnpm --filter @loanflow/web build
cd infra && pnpm exec cdk deploy LoanFlow -c alertEmail=you@example.com -c offerTimeoutSeconds=300
```

Smoke test: `pnpm exec tsx scripts/smoke.ts <SiteUrl> <ApiUrl>`.

### MCP server

Add a profile to `~/.aws/config` (use the `McpReaderRoleArn` stack output; `source_profile` is the profile `aws login` writes to, usually `default`):

```ini
[profile loanflow-mcp]
role_arn = <McpReaderRoleArn>
source_profile = default
region = eu-north-1
```

Then register the server with Claude Code:

```bash
API_URL=$(jq -r '.LoanFlow.ApiUrl' infra/cdk-outputs.json)
claude mcp add loanflow -e LOANFLOW_API_URL="$API_URL" -e AWS_PROFILE=loanflow-mcp -- \
  "$PWD/services/mcp/node_modules/.bin/tsx" "$PWD/services/mcp/src/server.ts"
```

In a new session ask: *"Which applications are in manual review, and why?"*

## CI setup

The PR workflow runs lint, typecheck and tests, and posts a `cdk diff`. It needs:

- **GitHub variables** (Settings → Secrets and variables → Actions → Variables): `AWS_ACCOUNT_ID`, `ALERT_EMAIL`, `OFFER_TIMEOUT_SECONDS`.
- **One-time deploy** of the OIDC role the workflow assumes (no stored AWS keys):

```bash
cd infra && pnpm exec cdk deploy LoanFlowGithubOidc
```

## Decisions

See [`docs/decisions`](docs/decisions): why each choice was made and what it costs.
