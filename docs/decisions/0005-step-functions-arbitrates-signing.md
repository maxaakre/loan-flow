# 5. Step Functions decides between "signed" and "expired"

**Status:** Accepted

## Context
A customer can press "Sign" in the same second the offer expires. If both the API and a timer write the status, one write can overwrite the other.

## Decision
- The offer step waits with a **task token** and a timeout.
- `POST /sign` only calls `SendTaskSuccess`. It never writes the status.
- A token completes once: either success or timeout. The next state writes `SIGNED` or `EXPIRED`.
- A late signature gets `TaskTimedOut` → `409 "Erbjudandet har gått ut"`.

## Consequences
- No race in our code: the arbiter is a managed service.
- AWS also returns `TaskTimedOut` for an already-used token. So when the token is gone, `sign` re-reads the application: `SIGNED`/`DISBURSED` → `202`; a newer token (create-offer was retried) → one retry with that token; still `OFFERED` with the same token before `offerExpiresAt` → `202` (an earlier sign is still being written); anything else → `409`.
- The API answers `202 Accepted`; the UI sees `SIGNED` a moment later by polling.
