# 4. Double-entry, append-only ledger in DynamoDB

**Status:** Accepted

## Context
Money needs an audit trail that cannot be edited, and balances that always add up.

## Decision
- Integer öre everywhere, with a branded `Ore` type.
- Each money movement is a ledger entry whose debits equal its credits (checked in `core`, property-tested).
- Entries are never updated or deleted (`attribute_not_exists`). Mistakes get a reversing entry.
- The loan balance is updated in the same transaction as the entry, with an optimistic `version` check.

## What I give up compared to Postgres
- No SQL for ad-hoc reporting (I would stream to S3 + Athena, or a read model).
- No database-level constraints: balance rules live in code and tests.
- Transactions are limited to 100 items; fine for one loan, not for batch jobs.

For a real lending ledger I would seriously consider Postgres (Aurora) or a dedicated ledger. Here DynamoDB keeps the demo serverless and inside the free tier.
