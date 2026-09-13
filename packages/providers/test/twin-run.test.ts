import { describe, expect, it, vi } from 'vitest';
import {
  TwinRun,
  TwinRunExpiredError,
  availableTwinNames,
  type ArgaLike,
} from '../src/arga/twin-run.js';

const endpoint = (name: string) => ({
  name,
  label: name,
  baseUrl: `https://pub-r1--${name}.arga.test`,
  adminUrl: `https://admin-r1--${name}.arga.test`,
  envVars: { [`${name.toUpperCase()}_TOKEN`]: 'tok' },
});

type StatusResponse = Awaited<ReturnType<ArgaLike['twins']['getStatus']>>;

function fakeClient(statuses: StatusResponse[]): {
  client: ArgaLike;
  calls: { reset: number; teardown: number; provision: unknown[] };
} {
  let i = 0;
  const calls = { reset: 0, teardown: 0, provision: [] as unknown[] };
  const client: ArgaLike = {
    twins: {
      list: async () => [
        { name: 'github', label: 'GitHub', kind: 'api' },
        { name: 'slack', label: 'Slack', kind: 'api' },
      ],
      provision: async (p) => {
        calls.provision.push(p);
        return { runId: 'run-1' };
      },
      getStatus: async () => statuses[Math.min(i++, statuses.length - 1)]!,
      reset: async () => {
        calls.reset++;
        return { runId: 'run-1', status: 'ready' };
      },
      teardown: async () => {
        calls.teardown++;
        return { status: 'destroyed' };
      },
      extend: async () => ({}),
    },
  };
  return { client, calls };
}

const ready = (expiresAt?: string) => ({
  runId: 'run-1',
  status: 'ready',
  twins: { github: endpoint('github'), slack: endpoint('slack') },
  ...(expiresAt ? { expiresAt } : {}),
  proxyToken: 'proxy-tok',
  isPublic: true,
});

describe('TwinRun', () => {
  it('polls until the run is ready', async () => {
    const { client, calls } = fakeClient([
      { runId: 'run-1', status: 'provisioning', twins: {} },
      { runId: 'run-1', status: 'provisioning', twins: {} },
      ready(),
    ]);
    const sleep = vi.fn(async () => {});
    const run = await TwinRun.provision(
      client,
      { twins: ['github', 'slack'], ttlMinutes: 60 },
      { sleep, pollIntervalMs: 1 },
    );
    expect(run.runId).toBe('run-1');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls.provision[0]).toMatchObject({ twins: ['github', 'slack'] });
  });

  it('surfaces a terminal provisioning failure rather than polling forever', async () => {
    const { client } = fakeClient([
      { runId: 'run-1', status: 'failed', twins: {}, error: 'quota exceeded' },
    ]);
    await expect(
      TwinRun.provision(client, { twins: ['github'] }, { sleep: async () => {} }),
    ).rejects.toThrow(/terminal status "failed": quota exceeded/);
  });

  it('times out instead of hanging an incident indefinitely', async () => {
    const { client } = fakeClient([{ runId: 'run-1', status: 'provisioning', twins: {} }]);
    let t = 0;
    await expect(
      TwinRun.attach(client, 'run-1', {
        sleep: async () => { t += 1000; },
        now: () => new Date(t),
        timeoutMs: 2000,
        pollIntervalMs: 1000,
      }),
    ).rejects.toThrow(/Timed out/);
  });

  it('exposes each twin base url exactly once, from one place', async () => {
    const { client } = fakeClient([ready()]);
    const run = await TwinRun.attach(client, 'run-1', { sleep: async () => {} });
    expect(run.endpoint('github').baseUrl).toBe('https://pub-r1--github.arga.test');
    expect(run.endpoint('github').envVars).toEqual({ GITHUB_TOKEN: 'tok' });
    expect(run.twinNames.sort()).toEqual(['github', 'slack']);
  });

  it('gives an actionable error for a twin that was never provisioned', async () => {
    const { client } = fakeClient([ready()]);
    const run = await TwinRun.attach(client, 'run-1', { sleep: async () => {} });
    expect(() => run.endpoint('datadog')).toThrow(/Provisioned: github, slack/);
    expect(run.has('datadog')).toBe(false);
  });

  it('distinguishes an expired environment from a transport failure', async () => {
    const { client } = fakeClient([ready('2026-09-13T10:00:00Z')]);
    const run = await TwinRun.attach(client, 'run-1', {
      sleep: async () => {},
      now: () => new Date('2026-09-13T11:00:00Z'),
    });
    expect(() => run.endpoint('github')).toThrow(TwinRunExpiredError);
    await expect(run.reset()).rejects.toThrow(TwinRunExpiredError);
  });

  it('resets to baseline, which is what makes evaluation deterministic', async () => {
    const { client, calls } = fakeClient([ready('2099-01-01T00:00:00Z')]);
    const run = await TwinRun.attach(client, 'run-1', { sleep: async () => {} });
    await run.reset();
    await run.reset();
    expect(calls.reset).toBe(2);
  });

  it('resolves the twin catalogue at runtime rather than trusting a hard-coded list', async () => {
    const { client } = fakeClient([ready()]);
    const names = await availableTwinNames(client);
    expect(names.has('github')).toBe(true);
    expect(names.has('datadog')).toBe(false);
  });
});
