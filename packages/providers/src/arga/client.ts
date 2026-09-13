import { Arga } from 'arga-sdk';
import type { ArgaLike } from './twin-run.js';

/**
 * Arga client construction.
 *
 * `arga-sdk@0.1.3` defaults `baseUrl` to `https://app.argalabs.com`, which serves the
 * web application rather than the API — requests against it return an HTML document
 * and fail JSON parsing with a confusing "Unexpected token '<'". The API is served
 * from `https://api.argalabs.com`. Verified 2026-09-13 by probing both hosts:
 * app.* returned HTML with 200, api.* returned the twin catalogue.
 *
 * Overriding it here rather than at each call site means one correction, and an
 * obvious place to remove it when the SDK default is fixed.
 */
export const ARGA_API_BASE_URL = 'https://api.argalabs.com';

export interface ArgaClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export function createArgaClient(opts: ArgaClientOptions): ArgaLike {
  return new Arga({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl ?? ARGA_API_BASE_URL,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  }) as unknown as ArgaLike;
}

export class MissingArgaCredentialError extends Error {
  constructor() {
    super(
      'ARGA_API_KEY is not set. Provision a key at https://app.argalabs.com and put it in .env, ' +
        'or set the provider backends to "local".',
    );
    this.name = 'MissingArgaCredentialError';
  }
}

export function argaClientFromEnv(env: NodeJS.ProcessEnv = process.env): ArgaLike {
  if (!env.ARGA_API_KEY) throw new MissingArgaCredentialError();
  return createArgaClient({
    apiKey: env.ARGA_API_KEY,
    ...(env.ARGA_BASE_URL ? { baseUrl: env.ARGA_BASE_URL } : {}),
  });
}
