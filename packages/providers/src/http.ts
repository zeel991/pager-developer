/**
 * Minimal HTTP client shared by every provider adapter.
 *
 * Adapters are constructed with a base URL and headers resolved elsewhere (an Arga
 * twin endpoint, or a real vendor credential). Nothing here knows or cares which.
 */

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /**
   * Resolved per request, for credentials that expire — a GitHub App installation
   * token, for instance. Merged over the static headers.
   */
  dynamicHeaders?: () => Promise<Record<string, string>>;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${method} ${url} failed with ${status}: ${truncate(body, 300)}`);
    this.name = 'ProviderHttpError';
  }

  /**
   * Arga returns 410 once a twin run's TTL has passed. Surfaced distinctly so
   * callers can re-provision rather than retry into a destroyed environment.
   */
  get isEnvironmentDestroyed(): boolean {
    return this.status === 410;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export class Http {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly dynamicHeaders: (() => Promise<Record<string, string>>) | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = opts.headers ?? {};
    this.dynamicHeaders = opts.dynamicHeaders ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', this.url(path, query));
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', this.url(path), body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', this.url(path), body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', this.url(path), body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', this.url(path));
  }

  /** GET returning null on 404, for genuinely optional resources. */
  async getOptional<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return null;
      throw err;
    }
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const resolved = this.dynamicHeaders ? await this.dynamicHeaders() : {};
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...this.headers,
          ...resolved,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ProviderHttpError(res.status, method, url, await safeText(res));
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
