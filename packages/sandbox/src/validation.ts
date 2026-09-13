import type { CommandResult, Sandbox } from './sandbox.js';
import type { RepositoryProfile } from './repository-profile.js';

/**
 * Deterministic verification.
 *
 * The rule this module exists to enforce: a check has passed only when a process
 * actually ran and exited zero. Nothing infers a pass from a model's opinion, and a
 * check that could not be run is reported as `skipped`, never as passing.
 */

export type ValidationKind = 'test' | 'lint' | 'typecheck' | 'build' | 'reproduction';

export interface ValidationRun {
  kind: ValidationKind;
  command: string;
  /** Null only when the check was skipped, which is distinct from failing. */
  exitCode: number | null;
  passed: boolean;
  skipped: boolean;
  skipReason: string | null;
  testsPassed: number | null;
  testsFailed: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

export interface ValidationSummary {
  runs: ValidationRun[];
  /** True only when every non-skipped check passed AND at least one check ran. */
  allPassed: boolean;
  skipped: ValidationKind[];
}

/**
 * Extract test counts from a runner's output.
 *
 * Handles node:test's TAP summary and Vitest's summary line. Counts are reported as
 * null when unrecognised rather than as zero — "0 tests failed" and "we could not
 * tell how many tests ran" must not look the same, because the first sounds like
 * success.
 */
export function parseTestCounts(output: string): { passed: number | null; failed: number | null } {
  // node:test's default ("spec") reporter uses an information glyph; its TAP
  // reporter uses '#'. Both are emitted by the same runner depending on flags, so
  // both are handled rather than assuming one.
  const nodePass = /^\s*(?:ℹ|#)\s*pass (\d+)\s*$/m.exec(output);
  const nodeFail = /^\s*(?:ℹ|#)\s*fail (\d+)\s*$/m.exec(output);
  if (nodePass || nodeFail) {
    return {
      passed: nodePass ? Number(nodePass[1]) : null,
      failed: nodeFail ? Number(nodeFail[1]) : null,
    };
  }

  const vitest = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(output);
  if (vitest) {
    return { passed: Number(vitest[2]), failed: vitest[1] ? Number(vitest[1]) : 0 };
  }

  const jest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed/.exec(output);
  if (jest) {
    return { passed: Number(jest[2]), failed: jest[1] ? Number(jest[1]) : 0 };
  }

  return { passed: null, failed: null };
}

function toRun(kind: ValidationKind, result: CommandResult): ValidationRun {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const counts = kind === 'test' || kind === 'reproduction'
    ? parseTestCounts(output)
    : { passed: null, failed: null };

  return {
    kind,
    command: result.command,
    exitCode: result.exitCode,
    // The exit code is the authority. A runner that prints "0 failed" and exits
    // non-zero has failed.
    passed: result.exitCode === 0 && !result.timedOut,
    skipped: false,
    skipReason: null,
    testsPassed: counts.passed,
    testsFailed: counts.failed,
    durationMs: result.durationMs,
    output,
    timedOut: result.timedOut,
  };
}

function skippedRun(kind: ValidationKind, reason: string): ValidationRun {
  return {
    kind,
    command: '',
    exitCode: null,
    passed: false,
    skipped: true,
    skipReason: reason,
    testsPassed: null,
    testsFailed: null,
    durationMs: 0,
    output: '',
    timedOut: false,
  };
}

/** Split a profile command string into an executable and arguments. */
export function splitCommand(command: string): { bin: string; args: string[] } {
  const parts = command.split(/\s+/).filter(Boolean);
  return { bin: parts[0] ?? '', args: parts.slice(1) };
}

export interface ValidationOptions {
  kinds?: ValidationKind[];
  timeoutMs?: number;
}

export class ValidationEngine {
  constructor(private readonly sandbox: Sandbox) {}

  /** Run one named check. */
  async runCheck(kind: ValidationKind, command: string | null, timeoutMs?: number): Promise<ValidationRun> {
    if (!command) {
      return skippedRun(kind, `The repository defines no ${kind} command.`);
    }
    const { bin, args } = splitCommand(command);
    const result = await this.sandbox.run(bin, args, timeoutMs ? { timeoutMs } : {});
    return toRun(kind, result);
  }

  /** Run the full deterministic suite for a repository. */
  async runAll(profile: RepositoryProfile, opts: ValidationOptions = {}): Promise<ValidationSummary> {
    const kinds = opts.kinds ?? (['typecheck', 'lint', 'test', 'build'] as ValidationKind[]);
    const commands: Record<string, string | null> = {
      test: profile.testCommand,
      lint: profile.lintCommand,
      typecheck: profile.typecheckCommand,
      build: profile.buildCommand,
    };

    const runs: ValidationRun[] = [];
    for (const kind of kinds) {
      runs.push(await this.runCheck(kind, commands[kind] ?? null, opts.timeoutMs));
    }

    const executed = runs.filter((r) => !r.skipped);
    return {
      runs,
      // An all-skipped suite is not a pass. "Nothing ran" must never read as
      // "everything is fine".
      allPassed: executed.length > 0 && executed.every((r) => r.passed),
      skipped: runs.filter((r) => r.skipped).map((r) => r.kind),
    };
  }
}
