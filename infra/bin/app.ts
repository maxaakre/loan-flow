import { App } from 'aws-cdk-lib';
import { fileURLToPath } from 'node:url';
import { LoanFlowStack } from '../lib/loanflow-stack';

const app = new App();

function requireContext(name: string): string {
  const value = app.node.tryGetContext(name);
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing CDK context "${name}". Pass it with -c ${name}=...`);
  }
  return value;
}

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-north-1' };

new LoanFlowStack(app, 'LoanFlow', {
  env,
  alertEmail: requireContext('alertEmail'),
  offerTimeoutSeconds: Number(requireContext('offerTimeoutSeconds')),
  webAssetPath: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
});
