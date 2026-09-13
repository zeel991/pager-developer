import { describe, expect, it } from 'vitest';
import { AgentTracer, InMemorySink } from '@pager/observability';
import type { DeploymentRecord, SourceControlProvider } from '@pager/providers';
import { DeploymentObserver, blameSurface, touchesPath } from '../src/deployment-observer.js';

const deployment: DeploymentRecord = {
  id: 'dep-1',
  service: 'checkout-api',
  environment: 'production',
  commitSha: 'b2c3d4',
  previousCommitSha: 'a1b2c3',
  status: 'succeeded',
  startedAt: new Date('2026-09-13T14:29:00Z'),
  deployedAt: new Date('2026-09-13T14:31:00Z'),
  author: 'Dana',
  repositoryFullName: 'acme/checkout-api',
};

function stubScm(over: Partial<SourceControlProvider> = {}): SourceControlProvider {
  return {
    kind: 'source-control',
    getCommit: async () => { throw new Error('not stubbed'); },
    getDiff: async () => ({
      baseSha: 'a1b2c3',
      headSha: 'b2c3d4',
      files: [
        { path: 'src/checkout/service.ts', status: 'modified', additions: 12, deletions: 3 },
        { path: 'src/checkout/types.ts', status: 'modified', additions: 2, deletions: 0 },
      ],
      patch: '@@ patch @@',
    }),
    listCommits: async () => [],
    listCommitsBetween: async () => [
      {
        sha: 'b2c3d4',
        message: 'Handle optional discount code',
        authorName: 'Dana',
        committedAt: new Date('2026-09-13T14:20:00Z'),
        parents: ['a1b2c3'],
      },
    ],
    getPullRequest: async () => { throw new Error('not stubbed'); },
    listPullRequestsForCommit: async () => [
      {
        number: 377,
        title: 'Discount codes',
        body: '',
        headRef: 'feat/discounts',
        baseRef: 'main',
        url: 'https://github.test/pr/377',
        state: 'merged',
        mergeCommitSha: 'b2c3d4',
      },
    ],
    getFile: async () => null,
    createBranch: async () => { throw new Error('not stubbed'); },
    createPullRequest: async () => { throw new Error('not stubbed'); },
    cloneUrl: () => 'https://git.test/acme/checkout-api.git',
    ...over,
  };
}

const observer = (scm: SourceControlProvider, sink = new InMemorySink()) => ({
  sink,
  observer: new DeploymentObserver(scm, new AgentTracer({ sink, lemma: null })),
});

describe('DeploymentObserver', () => {
  it('reconstructs what changed, with instrumented observations', async () => {
    const { observer: obs, sink } = observer(stubScm());
    const r = await obs.observe(deployment);

    expect(r.changedFiles.map((f) => f.path)).toEqual([
      'src/checkout/service.ts',
      'src/checkout/types.ts',
    ]);
    expect(r.commits).toHaveLength(1);
    expect(r.pullRequests[0]!.number).toBe(377);
    expect(r.gaps).toEqual([]);
    // Every observation is backed by a recorded tool call that evidence can cite.
    expect(r.toolCallIds).toHaveLength(3);
    expect(sink.toolCalls.every((c) => c.status === 'OK')).toBe(true);
  });

  it('derives a 30-minute baseline and observation window around the deploy', async () => {
    const { observer: obs } = observer(stubScm());
    const r = await obs.observe(deployment);

    expect(r.baselineWindow.from.toISOString()).toBe('2026-09-13T14:01:00.000Z');
    // Half-open: the baseline stops just before the deploy so the first
    // post-deployment sample cannot be averaged into it.
    expect(r.baselineWindow.to.toISOString()).toBe('2026-09-13T14:30:59.999Z');
    expect(r.observationWindow.from.toISOString()).toBe('2026-09-13T14:31:00.000Z');
    expect(r.observationWindow.to.toISOString()).toBe('2026-09-13T15:01:00.000Z');
  });

  it('anchors windows on start time when the deployment has not finished', async () => {
    const { observer: obs } = observer(stubScm());
    const r = await obs.observe({ ...deployment, deployedAt: null, status: 'in_progress' });
    expect(r.observationWindow.from.toISOString()).toBe('2026-09-13T14:29:00.000Z');
  });

  it('records a gap rather than implying nothing changed on a first deployment', async () => {
    const { observer: obs } = observer(stubScm());
    const r = await obs.observe({ ...deployment, previousCommitSha: null });

    expect(r.changedFiles).toEqual([]);
    expect(r.gaps[0]).toMatch(/unknown, not because they are empty/);
  });

  it('degrades rather than fails when PR association is unavailable, and records the failure', async () => {
    const { observer: obs, sink } = observer(
      stubScm({
        listPullRequestsForCommit: async () => {
          throw new Error('403 from source control');
        },
      }),
    );
    const r = await obs.observe(deployment);

    expect(r.changedFiles).toHaveLength(2);
    expect(r.pullRequests).toEqual([]);
    expect(r.gaps[0]).toMatch(/403 from source control/);
    // Swallowed for control flow, but never hidden from the record.
    expect(sink.failedToolCalls()).toHaveLength(1);
  });

  it('fails the reconstruction when the diff itself cannot be read', async () => {
    const { observer: obs, sink } = observer(
      stubScm({
        getDiff: async () => {
          throw new Error('502 bad gateway');
        },
      }),
    );
    // A missing diff is not a degraded reconstruction, it is no reconstruction.
    await expect(obs.observe(deployment)).rejects.toThrow('502 bad gateway');
    expect([...sink.agentRuns.values()][0]!.status).toBe('ERROR');
  });

  it('notes an empty diff explicitly', async () => {
    const { observer: obs } = observer(
      stubScm({ getDiff: async () => ({ baseSha: 'a', headSha: 'b', files: [], patch: null }) }),
    );
    const r = await obs.observe(deployment);
    expect(r.gaps[0]).toMatch(/no changed files/);
  });

  it('matches a stack trace path against the blame surface', async () => {
    const { observer: obs } = observer(stubScm());
    const r = await obs.observe(deployment);

    expect(blameSurface(r).size).toBe(2);
    expect(touchesPath(r, 'src/checkout/service.ts')).toBe(true);
    expect(touchesPath(r, '/app/src/checkout/service.ts')).toBe(true);
    expect(touchesPath(r, 'src/payments/gateway.ts')).toBe(false);
  });
});
