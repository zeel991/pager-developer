import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GitHubAppAuthError,
  GitHubAppTokenSource,
  registerViaManifest,
  signAppJwt,
} from '../src/github/app-auth.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const creds = { appId: 5, privateKeyPem: pem };

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('GitHub App JWT', () => {
  it('signs an RS256 JWT issued by the app, backdated for clock skew', () => {
    const now = new Date('2026-09-13T14:31:00Z');
    const jwt = signAppJwt(creds, now);
    const [header, payload] = jwt.split('.');

    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload!) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe('5');
    expect(claims.iat).toBeLessThan(Math.floor(now.getTime() / 1000));
    // GitHub rejects app JWTs with a lifetime over ten minutes.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });
});

describe('registerViaManifest', () => {
  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('walks the manifest flow and returns the generated private key', async () => {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('/settings/apps/new')) {
        expect(init.method).toBe('POST');
        const sent = JSON.parse(new URLSearchParams(String(init.body)).get('manifest')!);
        expect(sent.default_permissions.contents).toBe('write');
        // Nothing that could touch production is ever requested.
        expect(sent.default_permissions).not.toHaveProperty('administration');
        expect(sent.default_permissions).not.toHaveProperty('workflows');
        return new Response('', { status: 302, headers: { location: '/cb?code=abc123' } });
      }
      if (String(url).includes('/app-manifests/abc123/conversions')) {
        return ok({ id: 7, slug: 'pager-developer', pem }, 201);
      }
      return ok({}, 404);
    }) as unknown as typeof fetch;

    const result = await registerViaManifest(
      'https://twin.test',
      { name: 'pager-developer', url: 'u', hookUrl: 'h', redirectUrl: '/cb' },
      fetchImpl,
    );
    expect(result.appId).toBe(7);
    expect(result.privateKeyPem).toContain('PRIVATE KEY');
  });

  it('fails loudly when registration does not redirect', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 422 })) as unknown as typeof fetch;
    await expect(
      registerViaManifest('https://twin.test', { name: 'n', url: 'u', hookUrl: 'h', redirectUrl: '/cb' }, fetchImpl),
    ).rejects.toThrow(GitHubAppAuthError);
  });
});

describe('GitHubAppTokenSource', () => {
  function source(opts: { installations?: unknown; expiresAt?: string; now?: () => Date } = {}) {
    let mints = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/app/installations')) {
        return new Response(JSON.stringify(opts.installations ?? []), { status: 200 });
      }
      if (String(url).includes('/access_tokens')) {
        mints++;
        return new Response(
          JSON.stringify({
            token: `ghs_token_${mints}`,
            expires_at: opts.expiresAt ?? '2026-09-13T15:31:00Z',
            permissions: { contents: 'write', pull_requests: 'write' },
          }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    return {
      src: new GitHubAppTokenSource('https://twin.test', creds, {
        fetchImpl,
        now: opts.now ?? (() => new Date('2026-09-13T14:31:00Z')),
      }),
      mintCount: () => mints,
    };
  }

  it('mints an installation token and exposes its permissions', async () => {
    const { src } = source({ installations: [{ id: 42 }] });
    expect(await src.token()).toBe('ghs_token_1');
    expect(src.grantedPermissions).toMatchObject({ contents: 'write' });
    expect(await src.resolveInstallationId()).toBe(42);
  });

  it('caches the token rather than reminting on every call', async () => {
    const { src, mintCount } = source({ installations: [{ id: 1 }] });
    await src.token();
    await src.token();
    await src.token();
    expect(mintCount()).toBe(1);
  });

  it('remints once the cached token approaches expiry', async () => {
    let clock = new Date('2026-09-13T14:31:00Z');
    const { src, mintCount } = source({ installations: [{ id: 1 }], now: () => clock });
    expect(await src.token()).toBe('ghs_token_1');
    clock = new Date('2026-09-13T15:30:30Z');
    expect(await src.token()).toBe('ghs_token_2');
    expect(mintCount()).toBe(2);
  });

  it('does not remint on every call when the server reports a past expiry', async () => {
    // The Arga twin returns a fixed historical expires_at. Taking that literally
    // would remint on every single request.
    const { src, mintCount } = source({ installations: [{ id: 1 }], expiresAt: '2025-01-01T00:00:00Z' });
    await src.token();
    await src.token();
    expect(mintCount()).toBe(1);
  });

  it('falls back to the default installation when the listing is empty', async () => {
    const { src } = source({ installations: [] });
    expect(await src.resolveInstallationId()).toBe(1);
    expect(await src.token()).toBe('ghs_token_1');
  });
});
