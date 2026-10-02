import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      TABLE_NAME: 'test-table',
      EVENT_BUS_NAME: 'test-bus',
      STATE_MACHINE_ARN: 'arn:aws:states:eu-north-1:123456789012:stateMachine:test',
      OFFER_TIMEOUT_SECONDS: '604800',
      FAKE_LATENCY_MAX_MS: '0',
      POWERTOOLS_SERVICE_NAME: 'test',
      POWERTOOLS_METRICS_NAMESPACE: 'LoanFlow',
      POWERTOOLS_METRICS_DISABLED: 'true',
      POWERTOOLS_TRACE_ENABLED: 'false',
      POWERTOOLS_LOG_LEVEL: 'SILENT',
    },
  },
});
