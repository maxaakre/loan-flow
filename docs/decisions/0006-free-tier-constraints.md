# 6. Built for the AWS free tier

**Status:** Accepted

## Decision
- No VPC, so no NAT Gateway (~$35/month).
- No RDS, Aurora or Fargate (hourly cost).
- No Secrets Manager or customer KMS keys: nothing secret is needed.
- The UI **polls** every 2 s instead of a WebSocket or AppSync subscription.
- Step Functions **Standard**: 4 000 free transitions a month, and waiting is free.
- A $5 AWS Budget alert, created once with `scripts/create-budget.sh` (CloudFormation only supports budgets in us-east-1, so it is not in the stack).

## In production I would
- Push timeline updates over WebSocket/AppSync.
- Put Lambdas that reach private systems in a VPC with endpoints.
- Use a managed secrets store for real third-party credentials.
