import { createSign } from 'node:crypto';
import { ProviderHttpError } from '../http.js';

/**
 * GitHub App authentication.
 *
 * Pager Developer authenticates as a GitHub App rather than with a personal access
 * token. That is the right production design — scoped, per-installation, short-lived
 * credentials rather than a long-lived token carrying a human's full access — and it
 * is also what an Arga GitHub twin expects, so one mechanism serves both.
 *
 * Two ways in:
 *
 *  - `fromAppCredentials` — an existing app id and private key. This is production.
 *  - `registerViaManifest` — the GitHub App Manifest flow, which returns a freshly
 *    generated private key. Real GitHub gates this behind a browser redirect and a
 *    signed-in user, so in practice this path is for twins, where it is the only way
 *    to obtain a credential: a provisioned twin returns an empty `envVars`, and its
 *    write endpoints reject every unauthenticated request.
 *
 * Installation tokens are cached until shortly before expiry and then reminted.
 */

export interface GitHubAppCredentials {
  appId: string | number;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
}

export interface AppManifest {
  name: string;
  url: string;
  hookUrl: string;
  redirectUrl: string;
  permissions?: Record<string, string>;
  events?: string[];
}

const DEFAULT_PERMISSIONS: Record<string, string> = {
  // Exactly what the incident workflow needs, and nothing that could touch
  // production: no administration, no workflow, no secrets, no deployments.
  contents: 'write',
  pull_requests: 'write',
  checks: 'write',
  issues: 'write',
  statuses: 'write',
  metadata: 'read',
};

/** Clock skew allowance and lifetime for the app JWT; GitHub caps this at 10 minutes. */
const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;
/** Remint an installation token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class GitHubAppAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppAuthError';
  }
}

/** Sign a GitHub App JWT (RS256). */
export function signAppJwt(
  creds: GitHubAppCredentials,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_SECONDS;
  const encode = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat, exp: iat + JWT_LIFETIME_SECONDS, iss: String(creds.appId) });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(creds.privateKeyPem, 'base64url')}`;
}

interface ManifestConversionResponse {
  id: number;
  slug?: string;
  pem?: string;
  client_id?: string;
  client_secret?: string;
}

/**
 * Register a GitHub App through the manifest flow and return its credentials.
 *
 * The flow is: POST the manifest, follow the redirect to extract a one-time code,
 * then exchange that code for the app's generated private key.
 */
export async function registerViaManifest(
  baseUrl: string,
  manifest: AppManifest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubAppCredentials & { slug: string | undefined }> {
  const base = baseUrl.replace(/\/+$/, '');
  const body = new URLSearchParams({
    manifest: JSON.stringify({
      name: manifest.name,
      url: manifest.url,
      redirect_url: manifest.redirectUrl,
      hook_attributes: { url: manifest.hookUrl },
      public: false,
      default_permissions: manifest.permissions ?? DEFAULT_PERMISSIONS,
      default_events: manifest.events ?? ['push', 'pull_request'],
    }),
  });

  const registration = await fetchImpl(`${base}/settings/apps/new?state=pager-developer`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const location = registration.headers.get('location');
  if (!location) {
    throw new GitHubAppAuthError(
      `App manifest registration did not redirect (status ${registration.status}). ` +
        `Body: ${(await registration.text()).slice(0, 300)}`,
    );
  }

  const code = new URL(location, base).searchParams.get('code');
  if (!code) {
    throw new GitHubAppAuthError(`App manifest redirect carried no code: ${location}`);
  }

  const conversion = await fetchImpl(`${base}/app-manifests/${code}/conversions`, { method: 'POST' });
  if (!conversion.ok) {
    throw new ProviderHttpError(
      conversion.status,
      'POST',
      `${base}/app-manifests/${code}/conversions`,
      await conversion.text(),
    );
  }

  const app = (await conversion.json()) as ManifestConversionResponse;
  if (!app.pem) {
    throw new GitHubAppAuthError('Manifest conversion returned no private key');
  }
  return { appId: app.id, privateKeyPem: app.pem, slug: app.slug };
}

interface InstallationResponse {
  id: number;
  account?: { login?: string };
}

interface TokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
}

/**
 * Mints and caches installation access tokens for one GitHub App.
 *
 * A single installation is resolved once and reused. When the app reports no
 * installations — which a freshly registered twin app does, while still accepting
 * token requests for the pre-seeded installation — `defaultInstallationId` is used
 * rather than failing, because refusing here would block the whole workflow on a
 * listing endpoint that is not load-bearing.
 */
export class GitHubAppTokenSource {
  private cached: InstallationToken | null = null;
  private installationId: number | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly creds: GitHubAppCredentials,
    private readonly opts: {
      fetchImpl?: typeof globalThis.fetch;
      now?: () => Date;
      defaultInstallationId?: number;
    } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private get fetchImpl(): typeof globalThis.fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }
  private get now(): () => Date {
    return this.opts.now ?? (() => new Date());
  }

  async resolveInstallationId(): Promise<number> {
    if (this.installationId !== null) return this.installationId;

    const jwt = signAppJwt(this.creds, this.now());
    const res = await this.fetchImpl(`${this.baseUrl}/app/installations`, {
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' },
    });
    if (res.ok) {
      const list = (await res.json()) as InstallationResponse[];
      if (Array.isArray(list) && list.length > 0 && list[0]) {
        this.installationId = list[0].id;
        return this.installationId;
      }
    }
    this.installationId = this.opts.defaultInstallationId ?? 1;
    return this.installationId;
  }

  /** A valid installation token, reminted when the cached one is near expiry. */
  async token(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.expiresAt.getTime() - TOKEN_REFRESH_MARGIN_MS > nowMs) {
      return this.cached.token;
    }

    const installationId = await this.resolveInstallationId();
    const jwt = signAppJwt(this.creds, this.now());
    const url = `${this.baseUrl}/app/installations/${installationId}/access_tokens`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new ProviderHttpError(res.status, 'POST', url, await res.text());
    }

    const body = (await res.json()) as TokenResponse;
    const expiresAt = new Date(body.expires_at);
    this.cached = {
      token: body.token,
      // A twin may return a fixed past expiry. Treating that literally would remint
      // on every single call, so an unusable expiry falls back to GitHub's own
      // one-hour installation token lifetime.
      expiresAt:
        Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > nowMs
          ? expiresAt
          : new Date(nowMs + 3_600_000),
      permissions: body.permissions ?? {},
    };
    return this.cached.token;
  }

  /** Permissions the last minted token actually carries, for audit. */
  get grantedPermissions(): Record<string, string> {
    return this.cached?.permissions ?? {};
  }
}

export const PAGER_APP_MANIFEST = (baseUrl: string): AppManifest => ({
  name: 'pager-developer',
  url: 'https://github.com/pager-developer',
  hookUrl: `${baseUrl.replace(/\/+$/, '')}/_pager/webhooks`,
  redirectUrl: `${baseUrl.replace(/\/+$/, '')}/_ui/apps/manifest-callback`,
  permissions: DEFAULT_PERMISSIONS,
});

export { DEFAULT_PERMISSIONS as PAGER_APP_PERMISSIONS };
