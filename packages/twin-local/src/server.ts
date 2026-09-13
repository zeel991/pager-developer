import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { datadogRoutes } from './datadog-routes.js';
import { githubRoutes } from './github-routes.js';
import { matchRoute, type Route } from './router.js';
import { slackRoutes } from './slack-routes.js';
import { jiraRoutes, linearRoutes, notionRoutes } from './tracker-routes.js';
import { cloneState, emptyState, type TwinState } from './store.js';

/**
 * The local twin server.
 *
 * All three surfaces are served from one process under distinct path prefixes, so a
 * single instance backs an entire scenario. Prefixes are used rather than ports
 * because the adapters build vendor-native paths onto a base URL, and a base URL may
 * carry a prefix.
 *
 * `reset()` restores the exact seeded state — the same guarantee Arga's
 * `twins.reset()` gives, which is what lets the evaluation suite run a scenario
 * repeatedly and compare like with like.
 */

export interface TwinServerOptions {
  port?: number;
  /** Fixed clock, so scenario output is byte-identical across runs. */
  now?: () => number;
}

export interface TwinEndpoints {
  github: string;
  datadog: string;
  slack: string;
  jira: string;
  linear: string;
  notion: string;
}

export class LocalTwinServer {
  private server: Server | null = null;
  private state: TwinState = emptyState();
  private seeded: TwinState = emptyState();
  private readonly routes: { prefix: string; routes: Route[] }[];
  private readonly now: () => number;
  private boundPort = 0;

  constructor(private readonly opts: TwinServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.routes = [
      { prefix: '/github', routes: githubRoutes() },
      { prefix: '/datadog', routes: datadogRoutes() },
      { prefix: '/slack', routes: slackRoutes() },
      { prefix: '/jira', routes: jiraRoutes() },
      { prefix: '/linear', routes: linearRoutes() },
      { prefix: '/notion', routes: notionRoutes() },
    ];
  }

  /** Install state and remember it as the reset baseline. */
  seed(state: TwinState): void {
    this.state = state;
    this.seeded = cloneState(state);
  }

  /** Restore the seeded baseline, discarding everything the agent did. */
  reset(): void {
    this.state = cloneState(this.seeded);
  }

  get current(): TwinState {
    return this.state;
  }

  get port(): number {
    return this.boundPort;
  }

  endpoints(): TwinEndpoints {
    const base = `http://127.0.0.1:${this.boundPort}`;
    return {
      github: `${base}/github`,
      datadog: `${base}/datadog`,
      slack: `${base}/slack`,
      jira: `${base}/jira`,
      linear: `${base}/linear`,
      notion: `${base}/notion`,
    };
  }

  async start(): Promise<TwinEndpoints> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => {
      // Port 0 asks the OS for a free port, so parallel scenario runs never collide.
      this.server!.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : 0;
    return this.endpoints();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.boundPort}`);
    const group = this.routes.find((g) => url.pathname.startsWith(`${g.prefix}/`));

    if (!group) {
      return this.send(res, 404, { message: `No twin mounted at ${url.pathname}` });
    }

    const path = url.pathname.slice(group.prefix.length);
    const match = matchRoute(group.routes, req.method ?? 'GET', path);
    if (!match) {
      return this.send(res, 404, { message: `Not Found: ${req.method} ${path}` });
    }

    const raw = await readBody(req);
    const contentType = String(req.headers['content-type'] ?? '');
    let json: unknown = null;
    let form = new URLSearchParams();
    if (raw) {
      if (contentType.includes('application/x-www-form-urlencoded')) form = new URLSearchParams(raw);
      else {
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
      }
    }

    try {
      const result = await match.route.handler({
        state: this.state,
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0]! : String(v ?? '')]),
        ),
        json,
        form,
        now: this.now,
      });
      this.send(res, result.status, result.body, result.headers);
    } catch (err) {
      // A twin that fails silently would teach the agent that broken calls succeed.
      this.send(res, 500, { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(payload);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
