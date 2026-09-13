/**
 * Arga Twin Run lifecycle.
 *
 * This module is the *only* place external provider URLs enter the system. Business
 * logic receives constructed adapters and never learns where they point — the rule
 * from the brief that provider URLs must not be sprinkled through business logic is
 * enforced by there being exactly one source for them.
 */

export interface TwinEndpoint {
  name: string;
  baseUrl: string;
  /** State inspection and reset. Requires the proxy token even on public runs. */
  adminUrl: string;
  envVars: Record<string, string>;
}

export interface TwinRunSnapshot {
  runId: string;
  status: string;
  twins: Record<string, TwinEndpoint>;
  expiresAt: Date | null;
  proxyToken: string | null;
  isPublic: boolean;
}

/**
 * Structural subset of `arga-sdk`'s client that we depend on.
 *
 * Depending on the shape rather than the class keeps the twin lifecycle testable
 * without credentials and without a network, and means an SDK upgrade surfaces as a
 * type error here rather than as a runtime failure mid-incident.
 */
export interface ArgaLike {
  twins: {
    list(): Promise<{ name: string; label: string; kind: string }[]>;
    provision(params: {
      twins: string[];
      ttlMinutes?: number;
      scenarioId?: string;
      scenarioPrompt?: string;
      public?: boolean;
    }): Promise<{ runId: string }>;
    getStatus(runId: string): Promise<{
      runId: string;
      status: string;
      twins: Record<
        string,
        { name: string; label: string; baseUrl: string; adminUrl: string; envVars: Record<string, string> }
      >;
      expiresAt?: string;
      proxyToken?: string;
      isPublic?: boolean;
      error?: string;
    }>;
    reset(runId: string): Promise<{ runId: string; status: string }>;
    teardown(runId: string): Promise<{ status: string }>;
    extend(runId: string, params?: { ttlMinutes?: number }): Promise<unknown>;
  };
}

export class TwinRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwinRunError';
  }
}

/**
 * Thrown when the run's TTL has passed. Distinguished from a transport failure
 * because the remedy is different: a transport error should be retried, an expired
 * environment must be re-provisioned, and retrying it just burns the incident clock.
 */
export class TwinRunExpiredError extends TwinRunError {
  constructor(readonly runId: string, readonly expiredAt: Date | null) {
    super(`Arga twin run ${runId} expired${expiredAt ? ` at ${expiredAt.toISOString()}` : ''}`);
    this.name = 'TwinRunExpiredError';
  }
}

const TERMINAL_FAILURE = new Set(['failed', 'expired', 'cancelled']);

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export class TwinRun {
  private constructor(
    private readonly client: ArgaLike,
    private snapshot: TwinRunSnapshot,
    private readonly now: () => Date,
  ) {}

  get runId(): string {
    return this.snapshot.runId;
  }
  get expiresAt(): Date | null {
    return this.snapshot.expiresAt;
  }
  get proxyToken(): string | null {
    return this.snapshot.proxyToken;
  }
  get twinNames(): string[] {
    return Object.keys(this.snapshot.twins);
  }

  /** Provision twins and poll until ready. */
  static async provision(
    client: ArgaLike,
    params: {
      twins: string[];
      ttlMinutes?: number;
      scenarioId?: string;
      scenarioPrompt?: string;
      public?: boolean;
    },
    opts: WaitOptions = {},
  ): Promise<TwinRun> {
    const { runId } = await client.twins.provision(params);
    return TwinRun.attach(client, runId, opts);
  }

  /** Attach to an existing run, polling until it is ready. */
  static async attach(client: ArgaLike, runId: string, opts: WaitOptions = {}): Promise<TwinRun> {
    const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
    const timeoutMs = opts.timeoutMs ?? 600_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const now = opts.now ?? (() => new Date());

    const deadline = now().getTime() + timeoutMs;
    for (;;) {
      const status = await client.twins.getStatus(runId);
      if (status.status === 'ready') {
        return new TwinRun(client, toSnapshot(status), now);
      }
      if (TERMINAL_FAILURE.has(status.status)) {
        throw new TwinRunError(
          `Arga twin run ${runId} reached terminal status "${status.status}"${
            status.error ? `: ${status.error}` : ''
          }`,
        );
      }
      if (now().getTime() >= deadline) {
        throw new TwinRunError(
          `Timed out after ${timeoutMs}ms waiting for Arga twin run ${runId} (last status "${status.status}")`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Resolve one twin's endpoint.
   *
   * Expiry is checked here rather than at the call site so that every adapter
   * inherits the check without having to remember it.
   */
  endpoint(name: string): TwinEndpoint {
    this.assertLive();
    const twin = this.snapshot.twins[name];
    if (!twin) {
      throw new TwinRunError(
        `Twin "${name}" is not part of run ${this.runId}. Provisioned: ${this.twinNames.join(', ') || '(none)'}`,
      );
    }
    return twin;
  }

  has(name: string): boolean {
    return Boolean(this.snapshot.twins[name]);
  }

  assertLive(): void {
    const expiresAt = this.snapshot.expiresAt;
    if (expiresAt && this.now().getTime() >= expiresAt.getTime()) {
      throw new TwinRunExpiredError(this.runId, expiresAt);
    }
  }

  /**
   * Reset every twin to the baseline seed captured at provision time.
   *
   * This is what makes the evaluation suite deterministic: a scenario can be run,
   * asserted on, and returned to its exact starting state before the next run.
   */
  async reset(): Promise<void> {
    this.assertLive();
    await this.client.twins.reset(this.runId);
  }

  async refresh(): Promise<void> {
    const status = await this.client.twins.getStatus(this.runId);
    this.snapshot = toSnapshot(status);
  }

  async extend(ttlMinutes: number): Promise<void> {
    await this.client.twins.extend(this.runId, { ttlMinutes });
    await this.refresh();
  }

  async teardown(): Promise<void> {
    await this.client.twins.teardown(this.runId);
  }
}

function toSnapshot(status: Awaited<ReturnType<ArgaLike['twins']['getStatus']>>): TwinRunSnapshot {
  const twins: Record<string, TwinEndpoint> = {};
  for (const [key, t] of Object.entries(status.twins ?? {})) {
    twins[key] = {
      name: t.name ?? key,
      baseUrl: t.baseUrl,
      adminUrl: t.adminUrl,
      envVars: t.envVars ?? {},
    };
  }
  return {
    runId: status.runId,
    status: status.status,
    twins,
    expiresAt: status.expiresAt ? new Date(status.expiresAt) : null,
    proxyToken: status.proxyToken ?? null,
    isPublic: status.isPublic ?? true,
  };
}

/**
 * Ask Arga which twins it actually offers.
 *
 * Resolved at runtime rather than hard-coded: the SDK's `KnownTwinName` union at
 * v0.1.3 does not list `datadog` even though the product catalogue advertises it, so
 * the honest way to know whether an observability twin is available is to ask.
 */
export async function availableTwinNames(client: ArgaLike): Promise<Set<string>> {
  const twins = await client.twins.list();
  return new Set(twins.map((t) => t.name));
}
