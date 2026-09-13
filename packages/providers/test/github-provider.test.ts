import { describe, expect, it } from 'vitest';
import { GitHubProvider } from '../src/github/github-provider.js';
import { ProviderHttpError } from '../src/http.js';

type Route = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;

function stubFetch(routes: Route[]): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(`${init.method ?? 'GET'} ${url}`);
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) {
        const status = hit.status ?? 200;
        return new Response(hit.body === undefined ? '' : JSON.stringify(hit.body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const commitBody = {
  sha: 'b2c3d4',
  commit: {
    message: 'Handle optional discount code in checkout',
    author: { name: 'Dana', email: 'dana@example.com', date: '2026-09-13T14:31:00Z' },
  },
  parents: [{ sha: 'a1b2c3' }],
};

describe('GitHubProvider', () => {
  it('reads a commit from whatever base url it was given', async () => {
    const { fetchImpl, seen } = stubFetch([
      (u) => (u.includes('/repos/acme/checkout-api/commits/b2c3d4') ? { body: commitBody } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://pub-r1--github.arga.test', token: 't', fetchImpl });
    const commit = await gh.getCommit('acme/checkout-api', 'b2c3d4');

    expect(commit.sha).toBe('b2c3d4');
    expect(commit.authorName).toBe('Dana');
    expect(commit.parents).toEqual(['a1b2c3']);
    expect(seen[0]).toContain('https://pub-r1--github.arga.test/repos/acme/checkout-api/commits/b2c3d4');
  });

  it('maps a compare response into changed files', async () => {
    const { fetchImpl } = stubFetch([
      (u) =>
        u.includes('/compare/a1b2c3...b2c3d4')
          ? {
              body: {
                files: [
                  { filename: 'src/checkout/service.ts', status: 'modified', additions: 12, deletions: 3, patch: '@@ -1 +1 @@' },
                  { filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, previous_filename: 'src/older.ts' },
                ],
                commits: [commitBody],
              },
            }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    const diff = await gh.getDiff('acme/checkout-api', 'a1b2c3', 'b2c3d4');

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({ path: 'src/checkout/service.ts', status: 'modified', additions: 12 });
    expect(diff.files[1]).toMatchObject({ status: 'renamed', previousPath: 'src/older.ts' });
    expect(diff.patch).toContain('src/checkout/service.ts');
  });

  it('reports a missing patch as null rather than an empty string', async () => {
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/compare/') ? { body: { files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }] } } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    expect((await gh.getDiff('r/r', 'a', 'b')).patch).toBeNull();
  });

  it('decodes base64 file contents and returns null for a missing file', async () => {
    const { fetchImpl } = stubFetch([
      (u) =>
        u.includes('/contents/src/present.ts')
          ? { body: { content: Buffer.from('export const x = 1;').toString('base64'), encoding: 'base64' } }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    expect(await gh.getFile('r/r', 'main', 'src/present.ts')).toBe('export const x = 1;');
    expect(await gh.getFile('r/r', 'main', 'src/missing.ts')).toBeNull();
  });

  it('creates a fix branch and a pull request', async () => {
    const { fetchImpl, seen } = stubFetch([
      (u, i) =>
        u.endsWith('/git/refs') && i.method === 'POST'
          ? { status: 201, body: { ref: 'refs/heads/pager/incident-184', object: { sha: 'b2c3d4' } } }
          : undefined,
      (u, i) =>
        u.endsWith('/pulls') && i.method === 'POST'
          ? {
              status: 201,
              body: {
                number: 382,
                title: 'Fix null discount code',
                body: 'body',
                head: { ref: 'pager/incident-184', sha: 'c3' },
                base: { ref: 'main' },
                html_url: 'https://github.test/acme/checkout-api/pull/382',
                state: 'open',
              },
            }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 't', fetchImpl });

    const branch = await gh.createBranch('acme/checkout-api', 'b2c3d4', 'pager/incident-184');
    expect(branch.name).toBe('pager/incident-184');

    const pr = await gh.createPullRequest('acme/checkout-api', {
      title: 'Fix null discount code',
      body: 'body',
      headRef: 'pager/incident-184',
      baseRef: 'main',
    });
    expect(pr.number).toBe(382);
    expect(pr.state).toBe('open');
    expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(2);
  });

  it('reports a merged pull request distinctly from a closed one', async () => {
    const base = { number: 1, title: 't', body: null, head: { ref: 'h', sha: 's' }, base: { ref: 'main' }, html_url: 'u' };
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/pulls/1') ? { body: { ...base, state: 'closed', merged: true, merge_commit_sha: 'm1' } } : undefined),
      (u) => (u.includes('/pulls/2') ? { body: { ...base, number: 2, state: 'closed' } } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    expect((await gh.getPullRequest('r/r', 1)).state).toBe('merged');
    expect((await gh.getPullRequest('r/r', 2)).state).toBe('closed');
  });

  it('surfaces a destroyed twin environment distinctly from an ordinary failure', async () => {
    const { fetchImpl } = stubFetch([
      () => ({ status: 410, body: { error: 'environment_destroyed' } }),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://pub-r1--github.arga.test', fetchImpl });
    await expect(gh.getCommit('r/r', 'x')).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderHttpError && e.isEnvironmentDestroyed,
    );
  });

  it('derives a git clone url from the api base url', async () => {
    const { fetchImpl } = stubFetch([]);
    const twin = new GitHubProvider({ baseUrl: 'https://pub-r1--github.arga.test', token: 'tok', fetchImpl });
    expect(twin.cloneUrl('acme/checkout-api')).toBe('https://tok@pub-r1--github.arga.test/acme/checkout-api.git');

    const real = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 'tok', fetchImpl });
    expect(real.cloneUrl('acme/checkout-api')).toBe('https://tok@github.com/acme/checkout-api.git');
  });
});
