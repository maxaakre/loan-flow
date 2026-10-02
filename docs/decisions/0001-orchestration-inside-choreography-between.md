# 1. Orchestration inside the loan process, choreography between parts

**Status:** Accepted

## Context
A loan application has steps that must happen in order, can wait for days (signing), and need clear failure paths (registry down, offer expired, payout retried). Other parts (timeline, notifications, future analytics) only need to *know* that something happened.

## Decision
- **Step Functions (Standard)** owns the loan process: order, waiting, retries, timeouts.
- **EventBridge** carries domain events to everyone else. Consumers subscribe without the process knowing about them.

## Consequences
- You can see where every application is in the Step Functions console.
- Adding a consumer is a new rule + queue + Lambda. The process does not change.
- Two patterns to understand instead of one. I think that is the right price: pure choreography makes "where is application X?" hard to answer, and pure orchestration couples every consumer to the process.
