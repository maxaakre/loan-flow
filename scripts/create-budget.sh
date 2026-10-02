#!/usr/bin/env bash
# One-time $5/month cost alert for the account. Usage: scripts/create-budget.sh you@example.com
# Not in the CDK stack: CloudFormation only supports AWS::Budgets::Budget in us-east-1.
set -euo pipefail
EMAIL="${1:?usage: create-budget.sh <alert-email>}"
NAME=loanflow-monthly
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "$NAME" >/dev/null 2>&1; then
  echo "Budget $NAME already exists in $ACCOUNT"
  exit 0
fi

subscriber="[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]"
aws budgets create-budget --account-id "$ACCOUNT" \
  --budget "{\"BudgetName\":\"$NAME\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"5\",\"Unit\":\"USD\"}}" \
  --notifications-with-subscribers "[
    {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":$subscriber},
    {\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":$subscriber}
  ]"
echo "Created budget $NAME (\$5/month) in $ACCOUNT"
