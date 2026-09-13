import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceControlProvider } from '@pager/providers';

/**
 * An isolated working copy.
 *
 * Pager reproduces failures and writes patches by running real commands, which is the
 * only way "the tests pass" can mean anything. That makes containment the safety
 * property that matters most here:
 *
 *  - Every sandbox is a fresh temporary directory. The developer's working tree and
 *    the production filesystem are never touched.
 *  - Path arguments are resolved and checked to stay inside the sandbox, so a patch
 *    naming `../../.ssh/config` is refused rather than written.
 *  - Commands run with a scrubbed environment. Credentials in this process — the
 *    Arga key, the model key, GitHub tokens — are removed before the child starts,
 *    so code written by a model and executed here cannot read them.
 *  - Every command has a timeout and an output cap, so a runaway test suite fails
 *    the run instead of hanging the incident.
 */

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class SandboxPathError extends Error {
  constructor(readonly path: string) {
    super(`Refused a path outside the sandbox: ${path}`);
    this.name = 'SandboxPathError';
  }
}

/** Environment variables never passed to a sandboxed command. */
const SECRET_PATTERNS = [
  /API[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^ARGA_/i,
  /^LEMMA_/i,
  /^ANTHROPIC_/i,
  /^AWS_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^DD_/i,
  /^DATADOG_/i,
  /^SLACK_/i,
  /^JIRA_/i,
  /^LINEAR_/i,
  /^NOTION_/i,
  /^DATABASE_URL$/i,
  /^REDIS_URL$/i,
];

export function scrubEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_PATTERNS.some((p) => p.test(key))) continue;
    safe[key] = value;
  }
  return safe;
}

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra variables for this command. Merged over the scrubbed base. */
  env?: Record<string, string>;
}

export interface SandboxOptions {
  /** Parent directory for sandboxes. Defaults to the OS temp directory. */
  rootDir?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 1_000_000;

export class Sandbox {
  private constructor(
    readonly dir: string,
    readonly revision: string,
    private readonly opts: SandboxOptions,
  ) {}

  /**
   * Materialise a repository at an exact revision.
   *
   * Files are fetched through the source control provider rather than cloned with
   * git, so the same path works against a twin and against real GitHub, and no
   * credential is ever written into a `.git/config` on disk.
   */
  static async create(
    provider: SourceControlProvider,
    repo: string,
    revision: string,
    opts: SandboxOptions = {},
  ): Promise<Sandbox> {
    const parent = opts.rootDir ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, 'pager-sandbox-'));
    const sandbox = new Sandbox(dir, revision, opts);

    const paths = await provider.listFiles(repo, revision);
    if (paths.length === 0) {
      throw new Error(
        `Cannot build a sandbox: ${repo}@${revision} reported no files. ` +
          `Refusing to run against an empty working copy.`,
      );
    }

    for (const path of paths) {
      const content = await provider.getFile(repo, revision, path);
      if (content === null) continue;
      await sandbox.writeFile(path, content);
    }
    return sandbox;
  }

  /** Resolve a repo-relative path, refusing anything that escapes the sandbox. */
  private safePath(path: string): string {
    const target = resolve(this.dir, normalize(path));
    const rel = relative(this.dir, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(target) === resolve(this.dir)) {
      throw new SandboxPathError(path);
    }
    return target;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.safePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(this.safePath(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteFile(path: string): Promise<void> {
    await rm(this.safePath(path), { force: true });
  }

  /**
   * Run a command inside the sandbox.
   *
   * Arguments are passed as an array and never through a shell, so a filename
   * containing shell metacharacters cannot become an injection.
   */
  async run(command: string, args: string[] = [], options: RunOptions = {}): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutput = options.maxOutputBytes ?? this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const started = Date.now();

    return new Promise<CommandResult>((resolvePromise) => {
      const child = spawn(command, args, {
        cwd: this.dir,
        env: { ...scrubEnvironment(process.env), ...(options.env ?? {}) },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const capture = (chunk: Buffer, into: 'out' | 'err'): void => {
        const text = chunk.toString('utf8');
        if (into === 'out') {
          if (stdout.length < maxOutput) stdout += text.slice(0, maxOutput - stdout.length);
        } else if (stderr.length < maxOutput) {
          stderr += text.slice(0, maxOutput - stderr.length);
        }
      };

      child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
      child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const finish = (exitCode: number): void => {
        clearTimeout(timer);
        resolvePromise({
          command: [command, ...args].join(' '),
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
        });
      };

      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({
          command: [command, ...args].join(' '),
          // 127 is the conventional "command not found", and a missing binary must
          // never look like a passing run.
          exitCode: 127,
          stdout,
          stderr: `${stderr}${err.message}`,
          durationMs: Date.now() - started,
          timedOut: false,
        });
      });

      child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)));
    });
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
