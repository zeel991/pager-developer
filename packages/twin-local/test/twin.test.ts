import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubAppTokenSource,
  GitHubProvider,
  DatadogProvider,
  SlackProvider,
  PAGER_APP_MANIFEST,
  registerViaManifest,
} from '@pager/providers';
import { LocalTwinServer } from '../src/server.js';
import { seedFromFixture } from '../src/seed.js';
import { INC_001 } from '../src/fixtures/index.js';

/**
 * These exercise the local twin through the real provider adapters — the same code
 * that talks to Arga and to the real vendors. A twin tested through a bespoke client
 * would prove nothing about the code that actually ships.
 */

let server: LocalTwinServer;
let endpoints: { github: string; datadog: string; slack: string };

beforeEach(async () => {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(INC_001));
  endpoints = await server.start();
});

afterEach(async () => {
  await server.stop();
});

async function github(): Promise<GitHubProvider> {
  const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
  const tokens = new GitHubAppTokenSource(endpoints.github, creds);
  return new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() });
}

describe('local GitHub twin', () => {
  it('completes the GitHub App manifest and installation token flow', async () => {
    const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
    expect(creds.privateKeyPem).toContain('PRIVATE KEY');

    const tokens = new GitHubAppTokenSource(endpoints.github, creds);
    const token = await tokens.token();
    expect(token).toMatch(/^ghs_/);
    expect(tokens.grantedPermissions).toMatchObject({ contents: 'write', pull_requests: 'write' });
  });

  it('rejects unauthenticated reads of commits', async () => {
    const anon = new GitHubProvider({ baseUrl: endpoints.github });
    await expect(anon.listCommits('acme/checkout-api')).rejects.toThrow(/401/);
  });

  it('produces a real file-level diff, which the hosted twin cannot', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const head = await gh.getCommit('acme/checkout-api', history[0]!.sha);
    const diff = await gh.getDiff('acme/checkout-api', head.parents[0]!, head.sha);

    expect(diff.files.map((f) => f.path)).toEqual(['src/checkout/types.ts']);
    const changed = diff.files[0]!;
    expect(changed.status).toBe('modified');
    // Line counts are derived from the content, not declared by the fixture.
    expect(changed.additions).toBeGreaterThan(0);
    expect(diff.patch).toContain('discountCode?: DiscountCode | null');
  });

  it('associates the deployment commit with its pull request', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const prs = await gh.listPullRequestsForCommit('acme/checkout-api', history[0]!.sha);

    expect(prs).toHaveLength(1);
    expect(prs[0]!.number).toBe(377);
    expect(prs[0]!.state).toBe('merged');
  });

  it('serves file contents at a given revision', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const head = history[0]!.sha;

    const after = await gh.getFile('acme/checkout-api', head, 'src/checkout/types.ts');
    expect(after).toContain('discountCode?: DiscountCode | null');

    const parent = (await gh.getCommit('acme/checkout-api', head)).parents[0]!;
    const before = await gh.getFile('acme/checkout-api', parent, 'src/checkout/types.ts');
    expect(before).toContain('discountCode: DiscountCode;');
    expect(before).not.toContain('?:');
  });

  it('creates a fix branch and opens a pull request', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const branch = await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/incident-184');
    expect(branch.name).toBe('pager/incident-184');

    const pr = await gh.createPullRequest('acme/checkout-api', {
      title: 'Fix null discount code in createOrder',
      body: 'Incident INC-184',
      headRef: 'pager/incident-184',
      baseRef: 'main',
    });
    expect(pr.number).toBe(378);
    expect(pr.state).toBe('open');
  });

  it('refuses a branch that already exists', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/dup');
    await expect(gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/dup')).rejects.toThrow(/422/);
  });

  it('restores seeded state on reset, discarding agent side effects', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/incident-1');
    await gh.createPullRequest('acme/checkout-api', {
      title: 't', body: 'b', headRef: 'pager/incident-1', baseRef: 'main',
    });
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests).toHaveLength(2);

    server.reset();
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests).toHaveLength(1);
    expect(server.current.repositories.get('acme/checkout-api')!.branches.has('pager/incident-1')).toBe(false);
  });
});

describe('local Datadog twin', () => {
  const range = { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T15:00:00Z') };
  const datadog = () => new DatadogProvider({ baseUrl: endpoints.datadog });

  it('serves a metric series that rises after the deployment', async () => {
    const series = await datadog().queryMetric('checkout-api', 'error_rate', range);
    const deployedAt = Date.parse('2026-09-13T14:31:00Z');
    const before = series.points.filter((p) => p.at.getTime() < deployedAt);
    const after = series.points.filter((p) => p.at.getTime() >= deployedAt);

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(before.map((p) => p.value))).toBeLessThan(0.01);
    expect(mean(after.map((p) => p.value))).toBeGreaterThan(0.15);
  });

  it('keeps latency flat, so a correctness failure is not read as saturation', async () => {
    const series = await datadog().queryMetric('checkout-api', 'latency_p95', range);
    const values = series.points.map((p) => p.value);
    expect(Math.max(...values)).toBeLessThan(220);
  });

  it('serves error logs carrying the stack trace', async () => {
    const logs = await datadog().queryLogs('checkout-api', range, { level: 'error' });
    expect(logs.length).toBeGreaterThan(10);
    expect(logs[0]!.stackTrace).toContain('src/checkout/service.ts:20');
    expect(logs[0]!.message).toContain("Cannot read properties of null");
  });

  it('reports the alerting monitor and the healthy one distinctly', async () => {
    const monitors = await datadog().listMonitors('checkout-api');
    expect(monitors.find((m) => m.name.includes('error rate'))!.status).toBe('ALERT');
    expect(monitors.find((m) => m.name.includes('latency'))!.status).toBe('OK');
  });

  it('answers a malformed query with an error rather than an empty series', async () => {
    const dd = datadog();
    // No service tag: the adapter must not read this as "no data, all healthy".
    await expect(
      dd.queryMetric('', 'error_rate', range),
    ).rejects.toThrow(/Invalid query/);
  });
});

describe('local Slack twin', () => {
  const slack = () => new SlackProvider({ baseUrl: endpoints.slack });

  it('opens a thread and reads it back', async () => {
    const s = slack();
    const thread = await s.openThread('#incidents', 'Production regression detected');
    await s.replyInThread(thread, 'Investigation update');

    const messages = await s.readThread(thread);
    expect(messages.map((m) => m.text)).toEqual([
      'Production regression detected',
      'Investigation update',
    ]);
  });

  it('rejects an unknown channel the way Slack does, with ok:false', async () => {
    await expect(slack().openThread('#does-not-exist', 'hi')).rejects.toThrow(/channel_not_found/);
  });
});
