import { generateKeyPairSync, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import {
  blobSha,
  commitSha,
  diffCommits,
  type StoredCommit,
  type StoredRepository,
  type TwinState,
} from './store.js';
import type { Route } from './router.js';

/**
 * GitHub API surface.
 *
 * Implements the endpoints Pager Developer actually uses, with real GitHub response
 * shapes — including the App Manifest and installation-token flow, so the same
 * authentication code path runs here as against a hosted twin or real GitHub.
 *
 * Unlike the hosted twin, `/compare` returns genuine file-level diffs, which is the
 * reason this package exists.
 */

const UNAUTHENTICATED = {
  status: 401,
  body: { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' },
};

function findRepo(state: TwinState, owner: string, repo: string): StoredRepository | undefined {
  return state.repositories.get(`${owner}/${repo}`);
}

function findCommit(repo: StoredRepository, ref: string): StoredCommit | undefined {
  const branchSha = repo.branches.get(ref);
  const target = branchSha ?? ref;
  return (
    repo.commits.find((c) => c.sha === target) ??
    repo.commits.find((c) => c.sha.startsWith(target))
  );
}

function commitJson(repo: StoredRepository, c: StoredCommit, includeFiles = false) {
  const base = {
    sha: c.sha,
    node_id: `C_${c.sha.slice(0, 8)}`,
    commit: {
      message: c.message,
      author: { name: c.authorName, email: c.authorEmail, date: c.committedAt },
      committer: { name: c.authorName, email: c.authorEmail, date: c.committedAt },
    },
    parents: c.parents.map((sha) => ({ sha })),
    html_url: `https://github.local/${repo.fullName}/commit/${c.sha}`,
  };
  if (!includeFiles) return base;

  const parent = c.parents[0] ? repo.commits.find((p) => p.sha === c.parents[0]) : undefined;
  const files = parent
    ? diffCommits(parent, c)
    : [...c.files].map(([path, content]) => ({
        path,
        status: 'added' as const,
        additions: content.split('\n').length,
        deletions: 0,
        patch: '',
      }));
  return { ...base, files: files.map(fileJson) };
}

function fileJson(f: { path: string; status: string; additions: number; deletions: number; patch: string }) {
  return {
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    patch: f.patch,
  };
}

function prJson(repo: StoredRepository, pr: StoredRepository['pullRequests'][number]) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef },
    html_url: `https://github.local/${repo.fullName}/pull/${pr.number}`,
    state: pr.state,
    merged: pr.merged,
    merge_commit_sha: pr.mergeCommitSha,
  };
}

/** True when the request carries an installation token this twin minted. */
function isAuthenticated(state: TwinState, headers: Record<string, string>): boolean {
  const auth = headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '');
  return state.installationTokens.has(token);
}

/** Verify a GitHub App JWT against the app's own public key. */
function appFromJwt(state: TwinState, headers: Record<string, string>): number | null {
  const auth = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const parts = auth.split('.');
  if (parts.length !== 3) return null;
  const [head, payload, signature] = parts;
  try {
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { iss?: string };
    const appId = Number(claims.iss);
    const app = state.apps.get(appId);
    if (!app) return null;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${head}.${payload}`);
    const ok = verifier.verify(
      createPublicKey(app.privateKeyPem),
      Buffer.from(signature!, 'base64url'),
    );
    return ok ? appId : null;
  } catch {
    return null;
  }
}

export function githubRoutes(): Route[] {
  return [
    // ── GitHub App Manifest flow ─────────────────────────────────────────────
    {
      method: 'POST',
      pattern: /^\/settings\/apps\/new$/,
      handler: (ctx) => {
        const manifestRaw = ctx.form.get('manifest');
        if (!manifestRaw) {
          return { status: 422, body: { message: 'manifest field is required' } };
        }
        const manifest = JSON.parse(manifestRaw) as {
          name?: string;
          hook_attributes?: { url?: string };
          default_permissions?: Record<string, string>;
        };
        if (!manifest.hook_attributes?.url) {
          return { status: 422, body: { message: 'manifest.hook_attributes.url is required' } };
        }

        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const id = ctx.state.apps.size + 1;
        ctx.state.apps.set(id, {
          id,
          slug: manifest.name ?? `app-${id}`,
          privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
          permissions: manifest.default_permissions ?? {},
        });

        const code = randomBytes(20).toString('hex');
        ctx.state.manifestCodes.set(code, id);
        return {
          status: 302,
          headers: { location: `/_ui/apps/manifest-callback?code=${code}` },
          body: '',
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/app-manifests\/([^/]+)\/conversions$/,
      handler: (ctx) => {
        const code = ctx.params[0]!;
        const appId = ctx.state.manifestCodes.get(code);
        if (appId === undefined) return { status: 404, body: { message: 'Not Found' } };
        // A manifest code is single-use, as on real GitHub.
        ctx.state.manifestCodes.delete(code);
        const app = ctx.state.apps.get(appId)!;
        return {
          status: 201,
          body: { id: app.id, slug: app.slug, pem: app.privateKeyPem, permissions: app.permissions },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/app\/installations$/,
      handler: (ctx) => {
        const appId = appFromJwt(ctx.state, ctx.headers);
        if (appId === null) return UNAUTHENTICATED;
        return { status: 200, body: [{ id: 1, account: { login: 'acme' } }] };
      },
    },
    {
      method: 'POST',
      pattern: /^\/app\/installations\/(\d+)\/access_tokens$/,
      handler: (ctx) => {
        const appId = appFromJwt(ctx.state, ctx.headers);
        if (appId === null) return UNAUTHENTICATED;
        const app = ctx.state.apps.get(appId)!;
        const token = `ghs_${randomBytes(16).toString('hex')}`;
        ctx.state.installationTokens.set(token, appId);
        return {
          status: 201,
          body: {
            token,
            expires_at: new Date(ctx.now() + 3_600_000).toISOString(),
            permissions: app.permissions,
            repository_selection: 'all',
          },
        };
      },
    },

    // ── Repository reads ─────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)$/,
      handler: (ctx) => {
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        return {
          status: 200,
          body: {
            full_name: repo.fullName,
            name: repo.fullName.split('/')[1],
            default_branch: repo.defaultBranch,
            description: repo.description,
            private: false,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/commits$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const limit = Number(ctx.query.per_page ?? 30);
        const start = ctx.query.sha ? repo.commits.findIndex((c) => c.sha === ctx.query.sha) : 0;
        return {
          status: 200,
          body: repo.commits.slice(Math.max(0, start), Math.max(0, start) + limit).map((c) => commitJson(repo, c)),
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const commit = findCommit(repo, ctx.params[2]!);
        if (!commit) return { status: 404, body: { message: 'No commit found' } };
        return { status: 200, body: commitJson(repo, commit, true) };
      },
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/pulls$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const sha = ctx.params[2]!;
        return {
          status: 200,
          body: repo.pullRequests
            .filter((p) => p.mergeCommitSha === sha || p.headSha === sha)
            .map((p) => prJson(repo, p)),
        };
      },
    },
    {
      // The endpoint the whole package exists for: a real file-level diff.
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };

        const [baseRef, headRef] = decodeURIComponent(ctx.params[2]!).split('...');
        const base = findCommit(repo, baseRef ?? '');
        const head = findCommit(repo, headRef ?? '');
        if (!base || !head) return { status: 404, body: { message: 'Not Found' } };

        const files = diffCommits(base, head);
        const between = commitsBetween(repo, base, head);
        return {
          status: 200,
          body: {
            status: 'ahead',
            ahead_by: between.length,
            behind_by: 0,
            total_commits: between.length,
            commits: between.map((c) => commitJson(repo, c)),
            files: files.map(fileJson),
            base_commit: commitJson(repo, base),
            changed_files: files.length,
            additions: files.reduce((n, f) => n + f.additions, 0),
            deletions: files.reduce((n, f) => n + f.deletions, 0),
          },
        };
      },
    },
    {
      // Commit-addressed, unlike the hosted twin — a sandbox must be able to
      // materialise the exact revision production was running.
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const commit = findCommit(repo, ctx.params[2]!);
        if (!commit) return { status: 404, body: { message: 'Not Found' } };
        return {
          status: 200,
          body: {
            sha: commit.sha,
            truncated: false,
            tree: [...commit.files].map(([path, content]) => ({
              path,
              mode: '100644',
              type: 'blob',
              sha: blobSha(content),
              size: content.length,
            })),
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/,
      handler: (ctx) => {
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const ref = ctx.query.ref ?? repo.defaultBranch;
        const commit = findCommit(repo, ref);
        if (!commit) return { status: 404, body: { message: 'No commit found' } };

        const path = ctx.params[2]!;
        const content = commit.files.get(path);
        if (content === undefined) return { status: 404, body: { message: `Not Found: ${path}` } };
        return {
          status: 200,
          body: {
            path,
            sha: blobSha(content),
            size: content.length,
            encoding: 'base64',
            content: Buffer.from(content, 'utf8').toString('base64'),
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/pulls$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const state = ctx.query.state ?? 'open';
        return {
          status: 200,
          body: repo.pullRequests
            .filter((p) => state === 'all' || p.state === state)
            .map((p) => prJson(repo, p)),
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        const pr = repo?.pullRequests.find((p) => p.number === Number(ctx.params[2]));
        if (!repo || !pr) return { status: 404, body: { message: 'Not Found' } };
        return { status: 200, body: prJson(repo, pr) };
      },
    },

    // ── Writes ───────────────────────────────────────────────────────────────
    {
      method: 'POST',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const body = ctx.json as { ref?: string; sha?: string };
        const name = (body.ref ?? '').replace(/^refs\/heads\//, '');
        if (!name || !body.sha) return { status: 422, body: { message: 'ref and sha are required' } };
        if (repo.branches.has(name)) {
          return { status: 422, body: { message: 'Reference already exists' } };
        }
        if (!repo.commits.some((c) => c.sha === body.sha)) {
          return { status: 422, body: { message: 'Object does not exist' } };
        }
        repo.branches.set(name, body.sha);
        return { status: 201, body: { ref: `refs/heads/${name}`, object: { sha: body.sha } } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/pulls$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const body = ctx.json as { title?: string; body?: string; head?: string; base?: string };
        if (!body.title || !body.head || !body.base) {
          return { status: 422, body: { message: 'title, head and base are required' } };
        }
        const headSha = repo.branches.get(body.head);
        if (!headSha) return { status: 422, body: { message: `No commits between ${body.base} and ${body.head}` } };

        // GitHub numbers issues and pull requests from the highest allocated
        // number, not from the count — a repo whose latest PR is #377 issues #378
        // next even if it only holds one open PR.
        const nextNumber = repo.pullRequests.reduce((max, p) => Math.max(max, p.number), 0) + 1;
        const pr: StoredRepository['pullRequests'][number] = {
          number: nextNumber,
          title: body.title,
          body: body.body ?? '',
          headRef: body.head,
          baseRef: body.base,
          state: 'open',
          merged: false,
          mergeCommitSha: null,
          headSha,
        };
        repo.pullRequests.push(pr);
        return { status: 201, body: prJson(repo, pr) };
      },
    },
    {
      // Commit a set of file changes onto a branch. Used by the fix agent.
      method: 'POST',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/_commits$/,
      handler: (ctx) => {
        if (!isAuthenticated(ctx.state, ctx.headers)) return UNAUTHENTICATED;
        const repo = findRepo(ctx.state, ctx.params[0]!, ctx.params[1]!);
        if (!repo) return { status: 404, body: { message: 'Not Found' } };
        const body = ctx.json as {
          branch?: string;
          message?: string;
          author?: string;
          changes?: { path: string; content: string | null }[];
        };
        const branch = body.branch ?? repo.defaultBranch;
        const parentSha = repo.branches.get(branch);
        const parent = parentSha ? repo.commits.find((c) => c.sha === parentSha) : undefined;
        if (!parent) return { status: 422, body: { message: `Unknown branch ${branch}` } };

        const files = new Map(parent.files);
        for (const change of body.changes ?? []) {
          if (change.content === null) files.delete(change.path);
          else files.set(change.path, change.content);
        }
        const message = body.message ?? 'Update';
        const sha = commitSha(message, [parent.sha], files);
        const commit: StoredCommit = {
          sha,
          message,
          authorName: body.author ?? 'pager-developer',
          authorEmail: 'pager@example.com',
          committedAt: new Date(ctx.now()).toISOString(),
          parents: [parent.sha],
          files,
        };
        repo.commits.unshift(commit);
        repo.branches.set(branch, sha);
        return { status: 201, body: commitJson(repo, commit, true) };
      },
    },
  ];
}

/** Commits reachable from head but not from base, newest first. */
function commitsBetween(repo: StoredRepository, base: StoredCommit, head: StoredCommit): StoredCommit[] {
  const reachableFromBase = new Set<string>();
  const walk = (sha: string): void => {
    if (reachableFromBase.has(sha)) return;
    reachableFromBase.add(sha);
    const c = repo.commits.find((x) => x.sha === sha);
    for (const p of c?.parents ?? []) walk(p);
  };
  walk(base.sha);

  const out: StoredCommit[] = [];
  const seen = new Set<string>();
  const collect = (sha: string): void => {
    if (seen.has(sha) || reachableFromBase.has(sha)) return;
    seen.add(sha);
    const c = repo.commits.find((x) => x.sha === sha);
    if (!c) return;
    out.push(c);
    for (const p of c.parents) collect(p);
  };
  collect(head.sha);
  return out;
}
