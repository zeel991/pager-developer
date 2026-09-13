import { describe, expect, it } from 'vitest';
import { TwinRun, type ArgaLike } from '../src/arga/twin-run.js';
import { ProviderConfigError, buildProviders, requiredTwins, type ProviderConfig } from '../src/registry.js';

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  sourceControl: 'arga',
  observability: 'arga',
  messaging: 'arga',
  baseUrls: {},
  credentials: {},
  ...over,
});

async function twinRun(names: string[]): Promise<TwinRun> {
  const twins = Object.fromEntries(
    names.map((n) => [
      n,
      {
        name: n,
        label: n,
        baseUrl: `https://pub-r1--${n}.arga.test`,
        adminUrl: `https://admin--${n}.arga.test`,
        envVars: { GITHUB_TOKEN: 'twin-gh', DD_API_KEY: 'twin-dd', SLACK_BOT_TOKEN: 'twin-slack' },
      },
    ]),
  );
  const client: ArgaLike = {
    twins: {
      list: async () => [],
      provision: async () => ({ runId: 'run-1' }),
      getStatus: async () => ({ runId: 'run-1', status: 'ready', twins, expiresAt: '2099-01-01T00:00:00Z' }),
      reset: async () => ({ runId: 'run-1', status: 'ready' }),
      teardown: async () => ({ status: 'destroyed' }),
      extend: async () => ({}),
    },
  };
  return TwinRun.attach(client, 'run-1', { sleep: async () => {} });
}

describe('provider registry', () => {
  it('provisions only the twins the configuration actually needs', () => {
    expect(requiredTwins(config())).toEqual(['github', 'datadog', 'slack']);
    expect(requiredTwins(config({ observability: 'local' }))).toEqual(['github', 'slack']);
    expect(requiredTwins(config({ sourceControl: 'real', observability: 'real', messaging: 'real' }))).toEqual([]);
  });

  it('wires every provider from one Twin Run', async () => {
    const providers = buildProviders({ config: config(), twinRun: await twinRun(['github', 'datadog', 'slack']) });
    expect(providers.sourceControl.kind).toBe('source-control');
    expect(providers.observability.kind).toBe('observability');
    expect(providers.messaging.kind).toBe('messaging');
    expect(providers.sourceControl.cloneUrl('acme/api')).toContain('pub-r1--github.arga.test');
  });

  it('refuses an arga backend with no Twin Run attached', async () => {
    expect(() => buildProviders({ config: config(), twinRun: null })).toThrow(ProviderConfigError);
    expect(() => buildProviders({ config: config(), twinRun: null })).toThrow(/no Twin Run is attached/);
  });

  it('names the twins that were actually provisioned when one is missing', async () => {
    const run = await twinRun(['github', 'slack']);
    expect(() => buildProviders({ config: config(), twinRun: run })).toThrow(
      /provisioned only: github, slack/,
    );
  });

  it('never falls back to a real vendor credential when running against a twin', async () => {
    // The danger this guards: a simulation quietly reaching real infrastructure.
    const run = await twinRun(['github', 'datadog', 'slack']);
    const providers = buildProviders({
      config: config({ credentials: { githubToken: 'REAL-PRODUCTION-TOKEN' } }),
      twinRun: run,
    });
    const cloneUrl = providers.sourceControl.cloneUrl('acme/api');
    expect(cloneUrl).toContain('twin-gh');
    expect(cloneUrl).not.toContain('REAL-PRODUCTION-TOKEN');
  });

  it('refuses a real backend with no credential rather than calling unauthenticated', () => {
    expect(() =>
      buildProviders({ config: config({ sourceControl: 'real', observability: 'local', messaging: 'local' }) }),
    ).toThrow(/no credential was supplied/);
  });

  it('requires a pinned url for a local backend', () => {
    expect(() =>
      buildProviders({ config: config({ sourceControl: 'local', observability: 'local', messaging: 'local' }) }),
    ).toThrow(/no base URL was pinned/);
  });

  it('accepts a fully local wiring when urls are pinned', () => {
    const providers = buildProviders({
      config: config({
        sourceControl: 'local',
        observability: 'local',
        messaging: 'local',
        baseUrls: { github: 'http://localhost:4010', datadog: 'http://localhost:4011', slack: 'http://localhost:4012' },
      }),
    });
    expect(providers.sourceControl.cloneUrl('a/b')).toBe('http://localhost:4010/a/b.git');
  });
});
