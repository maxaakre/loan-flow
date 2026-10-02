# 3. Exactly-once in effect, not exactly-once delivery

**Status:** Accepted

## Context
Streams, EventBridge and SQS all deliver at least once, and EventBridge does not keep order. Clients also retry: double-clicks, timeouts, flaky mobile networks.

## Decision
- **APIs:** an `Idempotency-Key` header on every write. The stored answer is written in the same transaction as the effect. Same key + same request → same answer. Same key + different request → 422.
- **Consumers:** the event id is part of the key they write (`EVT#<eventId>`, `NOTIF#<eventId>`), with `attribute_not_exists`. A duplicate does nothing.
- **Process steps:** check the current status first and use optimistic concurrency (`version`). A retried step finds the work done and returns.
- **Payout:** the bank call uses the application id as its idempotency key.
- **Order:** consumers do not depend on order; the timeline sorts by time and sequence.

## Consequences
- Every handler has an "already done?" path, and tests for it.
- Notifications claim first, then send: at most once. Losing an email is better than sending two.
