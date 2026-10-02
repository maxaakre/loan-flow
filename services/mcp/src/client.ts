import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentityProvider } from '@smithy/types';

export type Fetcher = (path: string) => Promise<unknown>;

/** GETs signed with SigV4. No API keys or secrets: it uses the local AWS profile. */
export function signedFetcher(
  apiUrl: string,
  region = 'eu-north-1',
  credentials: AwsCredentialIdentityProvider = fromNodeProviderChain(),
): Fetcher {
  const signer = new SignatureV4({ service: 'execute-api', region, credentials, sha256: Sha256 });
  return async (path) => {
    const url = new URL(path, apiUrl);
    const signed = await signer.sign({
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { host: url.hostname },
    });
    const res = await fetch(url, { headers: signed.headers });
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    if (!res.ok) throw new Error(`${res.status} ${body?.detail ?? res.statusText}`);
    return body;
  };
}
