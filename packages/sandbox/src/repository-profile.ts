import type { Sandbox } from './sandbox.js';

/**
 * Repository understanding (§13).
 *
 * Derived once from what is actually in the working copy, so an incident does not
 * rediscover the whole repository every time. Everything here is read off disk —
 * nothing is guessed from the repository name or asked of a model.
 */

export interface RepositoryProfile {
  language: string | null;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  testCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
  typecheckCommand: string | null;
  entryPoint: string | null;
  hasDockerfile: boolean;
  hasCi: boolean;
  /** Scripts found, so a caller can see what else was available. */
  scripts: Record<string, string>;
  /** What could not be determined, and why. */
  gaps: string[];
}

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
  main?: string;
  module?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Script names to look for, in preference order, per kind of check. */
const SCRIPT_CANDIDATES = {
  test: ['test', 'test:unit', 'tests', 'spec'],
  build: ['build', 'compile'],
  lint: ['lint', 'eslint', 'lint:check'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
} as const;

function pickScript(scripts: Record<string, string>, candidates: readonly string[]): string | null {
  for (const name of candidates) {
    if (scripts[name]) return name;
  }
  return null;
}

/** The declared packageManager field wins; a lockfile is the fallback signal. */
async function detectPackageManager(
  sandbox: Sandbox,
  pkg: PackageJson,
  gaps: string[],
): Promise<NonNullable<RepositoryProfile['packageManager']>> {
  const declared = pkg.packageManager ?? '';
  for (const name of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
    if (declared.startsWith(name)) return name;
  }

  const lockfiles: [string, NonNullable<RepositoryProfile['packageManager']>][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, manager] of lockfiles) {
    if (await sandbox.readFile(file)) return manager;
  }

  gaps.push('No lockfile or packageManager field; assuming npm.');
  return 'npm';
}

export async function profileRepository(sandbox: Sandbox): Promise<RepositoryProfile> {
  const gaps: string[] = [];
  const raw = await sandbox.readFile('package.json');

  if (!raw) {
    gaps.push('No package.json found; this profiler only understands Node projects.');
    return {
      language: null,
      packageManager: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      typecheckCommand: null,
      entryPoint: null,
      hasDockerfile: (await sandbox.readFile('Dockerfile')) !== null,
      hasCi: false,
      scripts: {},
      gaps,
    };
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw) as PackageJson;
  } catch (err) {
    gaps.push(`package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return {
      language: null, packageManager: null, testCommand: null, buildCommand: null,
      lintCommand: null, typecheckCommand: null, entryPoint: null,
      hasDockerfile: false, hasCi: false, scripts: {}, gaps,
    };
  }

  const scripts = pkg.scripts ?? {};
  const hasTsconfig = (await sandbox.readFile('tsconfig.json')) !== null;

  const packageManager = await detectPackageManager(sandbox, pkg, gaps);

  const runner = packageManager === 'npm' ? 'npm run' : `${packageManager} run`;
  const script = (kind: keyof typeof SCRIPT_CANDIDATES): string | null => {
    const name = pickScript(scripts, SCRIPT_CANDIDATES[kind]);
    return name ? `${runner} ${name}` : null;
  };

  const testCommand = script('test');
  if (!testCommand) {
    // Recorded rather than substituted. A fix cannot be verified without a way to
    // run tests, and pretending otherwise is the failure mode this whole system
    // exists to prevent.
    gaps.push('No test script found; deterministic verification will be incomplete.');
  }

  const typecheckCommand = script('typecheck') ?? (hasTsconfig ? null : null);
  if (hasTsconfig && !typecheckCommand) {
    gaps.push('tsconfig.json present but no typecheck script; type errors will not be caught.');
  }

  return {
    language: hasTsconfig ? 'typescript' : 'javascript',
    packageManager,
    testCommand,
    buildCommand: script('build'),
    lintCommand: script('lint'),
    typecheckCommand,
    entryPoint: pkg.main ?? pkg.module ?? null,
    hasDockerfile: (await sandbox.readFile('Dockerfile')) !== null,
    hasCi:
      (await sandbox.readFile('.github/workflows/ci.yml')) !== null ||
      (await sandbox.readFile('.github/workflows/test.yml')) !== null,
    scripts,
    gaps,
  };
}
