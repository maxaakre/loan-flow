import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedFetcher } from '../src/client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('signedFetcher', () => {
  it('signs GET requests with SigV4 for execute-api', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const get = signedFetcher('https://abc.execute-api.eu-north-1.amazonaws.com', 'eu-north-1', async () => ({
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
    }));
    expect(await get('/internal/applications?status=MANUAL_REVIEW')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
    expect(String(url)).toBe('https://abc.execute-api.eu-north-1.amazonaws.com/internal/applications?status=MANUAL_REVIEW');
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/execute-api\//);
  });

  it('defaults the signing region to AWS_REGION', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await signedFetcher('https://abc.execute-api.eu-west-1.amazonaws.com', undefined, async () => ({
      accessKeyId: 'A',
      secretAccessKey: 'B',
    }))('/internal/applications');
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
    expect(init.headers.authorization).toContain('/eu-west-1/execute-api/');
  });

  it('turns an error response into an error with the problem detail', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ detail: 'Application not found' }), { status: 404 }));
    const get = signedFetcher('https://abc.execute-api.eu-north-1.amazonaws.com', 'eu-north-1', async () => ({
      accessKeyId: 'A',
      secretAccessKey: 'B',
    }));
    await expect(get('/internal/applications/x')).rejects.toThrow('404 Application not found');
  });
});
