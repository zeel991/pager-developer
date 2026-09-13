import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CommitFixture, ScenarioFixture } from './seed.js';

/**
 * Load a scenario from a real repository on disk.
 *
 * The demo service under `demo/checkout-api` is an actual runnable project: you can
 * `cd` into it and `node --test` it, and its suite passes against the broken code —
 * which is precisely why the bug reached production. Keeping the fixture as real
 * files rather than string constants means the scenario can be inspected, edited and
 * executed by a human, and it is the same tree the sandbox materialises.
 *
 * History is expressed as commits over that working tree. Each commit takes files
 * from the tree, optionally with an `overlay` directory supplying the pre-change
 * version of files it modified. Only superseded content needs storing, so the
 * history directory stays small and readable.
 */

interface CommitManifest {
  message: string;
  author: string;
  at: string;
  branch?: string;
  mergeOf?: string;
  /** Repository paths, or `**` for the whole tree. */
  include: string[];
  /** Directory whose files replace the working-tree versions for this commit. */
  overlay?: string;
}

interface PageManifest {
  id: string;
  title: string;
  file: string;
}

interface ScenarioManifest {
  id: string;
  title: string;
  service: string;
  repository: string;
  description?: string;
  defaultBranch?: string;
  workingTree: string;
  windowFrom: string;
  windowTo: string;
  deployedAt: string;
  commits: CommitManifest[];
  pullRequests?: ScenarioFixture['pullRequests'];
  metrics: ScenarioFixture['metrics'];
  logs?: ScenarioFixture['logs'];
  monitors?: ScenarioFixture['monitors'];
  slackChannels?: string[];
  pages?: PageManifest[];
}

/** Files that exist on disk but are not part of the repository being simulated. */
const EXCLUDED = new Set(['node_modules', '.git', '.DS_Store']);

function walk(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(root, full));
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
}

export function loadDemoScenario(demoRoot: string): ScenarioFixture {
  const manifest = JSON.parse(readFileSync(join(demoRoot, 'scenario.json'), 'utf8')) as ScenarioManifest;
  const treeRoot = join(demoRoot, manifest.workingTree);
  const allPaths = walk(treeRoot);

  const commits: CommitFixture[] = manifest.commits.map((commit) => {
    const paths = commit.include.includes('**')
      ? allPaths
      : commit.include.filter((p) => allPaths.includes(p));

    const missing = commit.include.filter((p) => p !== '**' && !allPaths.includes(p));
    if (missing.length > 0) {
      // A manifest referring to files that are not there would silently produce a
      // commit that changes nothing, which would be a very confusing scenario.
      throw new Error(
        `Scenario ${manifest.id}: commit "${commit.message}" lists files not present in ` +
          `${manifest.workingTree}: ${missing.join(', ')}`,
      );
    }

    const overlayRoot = commit.overlay ? join(demoRoot, commit.overlay) : null;
    const overlayPaths = overlayRoot ? new Set(walk(overlayRoot)) : new Set<string>();

    return {
      message: commit.message,
      author: commit.author,
      at: commit.at,
      ...(commit.branch ? { branch: commit.branch } : {}),
      ...(commit.mergeOf ? { mergeOf: commit.mergeOf } : {}),
      changes: paths.map((path) => ({
        path,
        content: readFileSync(
          overlayPaths.has(path) ? join(overlayRoot!, path) : join(treeRoot, path),
          'utf8',
        ),
      })),
    };
  });

  return {
    id: manifest.id,
    repository: manifest.repository,
    service: manifest.service,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.defaultBranch ? { defaultBranch: manifest.defaultBranch } : {}),
    windowFrom: manifest.windowFrom,
    windowTo: manifest.windowTo,
    deployedAt: manifest.deployedAt,
    commits,
    ...(manifest.pullRequests ? { pullRequests: manifest.pullRequests } : {}),
    metrics: manifest.metrics,
    ...(manifest.logs ? { logs: manifest.logs } : {}),
    ...(manifest.monitors ? { monitors: manifest.monitors } : {}),
    ...(manifest.slackChannels ? { slackChannels: manifest.slackChannels } : {}),
    pages: (manifest.pages ?? []).map((page) => ({
      id: page.id,
      title: page.title,
      content: readFileSync(join(demoRoot, page.file), 'utf8'),
    })),
  };
}
