# 7. A read-only MCP server with IAM auth

**Status:** Accepted

## Context
Case handlers want to ask "why was this declined?" in plain language. An AI should help explain, but must never decide, sign or pay.

## Decision
- A local MCP server with five **read-only** tools over `GET /internal/*`.
- The internal routes use **IAM auth (SigV4)**. They are not routed through CloudFront.
- A dedicated role (`loanflow-mcp-reader`) may only call `GET /internal/*`.
- `explain_decision` returns reason codes, the exact inputs and `rulesVersion`. The model explains facts; `core` computes them.

## Consequences
- No API keys or secrets: it uses the developer's short-lived AWS credentials.
- Write tools would need a human approval step, audit logging and a separate role. Out of scope on purpose.
