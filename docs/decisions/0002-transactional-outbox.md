# 2. Transactional outbox with DynamoDB Streams and a relay Lambda

**Status:** Accepted

## Context
"Save to the database, then publish an event" is a dual write. If the publish fails after the save, other parts never hear about it. If we publish first and the save fails, we announce something that did not happen.

## Decision
- Business code writes the state change **and** an `OUTBOX#` row in one `TransactWriteItems`.
- The table stream (filtered to new `OUTBOX#` rows) triggers `outbox-relay`, which calls `PutEvents`.
- Only the relay publishes. Outbox rows expire after 24 h via TTL.
- The process is started by a consumer of `ApplicationSubmitted`, so the API also avoids a dual write with Step Functions.

## Why not EventBridge Pipes
Pipes can read the stream, but turning a DynamoDB item into a clean event needs an enrichment Lambda anyway. A plain stream Lambda is fewer moving parts and easier to test.

## Consequences
- Events are at-least-once (the relay may retry). Consumers must be idempotent, see ADR 3.
- If EventBridge is down longer than the relay's retries (10 attempts, 1 day max record age), the record goes to the DLQ (alarm). The `OUTBOX#` row (24 h TTL) is the replay source: republish by re-putting the row.
- A small delay (usually well under a second) between the write and the event.
