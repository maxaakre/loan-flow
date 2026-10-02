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
- AWS also returns `TaskTimedOut` for an already-used token. So `sign` answers `202` when the token is gone but `offerExpiresAt` has not passed (a retried sign after a lost response), and `409` only after the deadline.
- The API answers `202 Accepted`; the UI sees `SIGNED` a moment later by polling.
