#!/usr/bin/env bash
# One-step setup of the read-only LoanFlow MCP server in Claude Code.
# Usage: scripts/setup-mcp.sh [login-profile]   (default: loanflow)
# Safe to run again: it updates the profile and re-registers the server.
set -euo pipefail

LOGIN_PROFILE="${1:-loanflow}"
MCP_PROFILE=loanflow-mcp
REGION=eu-north-1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Read the stack outputs from AWS (no local files needed)
output() {
  AWS_PROFILE="$LOGIN_PROFILE" aws cloudformation describe-stacks --stack-name LoanFlow --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
ROLE_ARN=$(output McpReaderRoleArn)
API_URL=$(output ApiUrl)
[[ -n "$ROLE_ARN" && -n "$API_URL" ]] || { echo "Stack outputs not found. Is LoanFlow deployed and are you logged in (aws login --profile $LOGIN_PROFILE)?"; exit 1; }

# 2. AWS profile that assumes the read-only role
aws configure set role_arn "$ROLE_ARN" --profile "$MCP_PROFILE"
aws configure set source_profile "$LOGIN_PROFILE" --profile "$MCP_PROFILE"
aws configure set region "$REGION" --profile "$MCP_PROFILE"
ASSUMED=$(AWS_PROFILE="$MCP_PROFILE" aws sts get-caller-identity --query Arn --output text)
echo "ok   profile $MCP_PROFILE → $ASSUMED"

# 3. Register the server in Claude Code for this project only
[[ -x "$ROOT/services/mcp/node_modules/.bin/tsx" ]] || (cd "$ROOT" && pnpm install --silent)
claude mcp remove loanflow -s local >/dev/null 2>&1 || true
(cd "$ROOT" && claude mcp add loanflow -s local \
  -e LOANFLOW_API_URL="$API_URL" -e AWS_PROFILE="$MCP_PROFILE" -- \
  "$ROOT/services/mcp/node_modules/.bin/tsx" "$ROOT/services/mcp/src/server.ts" >/dev/null)
echo "ok   MCP server 'loanflow' registered for $ROOT"

# 4. The internal API must refuse unsigned calls
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/internal/applications")
[[ "$CODE" == "403" ]] && echo "ok   unsigned /internal call refused (403)" || { echo "FAIL unsigned /internal call returned $CODE"; exit 1; }

echo
echo "Done. Start 'claude' in $ROOT, check /mcp, then ask:"
echo "  \"Which applications are in manual review, and why?\""
