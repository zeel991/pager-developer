import type { Sandbox } from './sandbox.js';
import type { ValidationEngine, ValidationRun } from './validation.js';

/**
 * Reproduction: proving a failure exists, and then proving a patch removes it.
 *
 * The invariant is FAIL BEFORE, PASS AFTER, and it is the strongest evidence this
 * system can produce. A test that passes before the patch proves nothing about the
 * bug; a test that fails after it proves the patch does not work. Both are rejected
 * here, and the rejection is the point — an agent cannot talk its way past a
 * reproduction that never failed.
 */

export interface ReproductionAttempt {
  /** Path of the regression test written to demonstrate the failure. */
  testPath: string;
  command: string;
  beforeFix: ValidationRun;
  afterFix: ValidationRun | null;
  /** True only when the test failed before the patch and passed after it. */
  proven: boolean;
  /** Why the reproduction is not proven, when it is not. */
  failureReason: string | null;
}

export class ReproductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproductionError';
  }
}

export interface ReproductionInput {
  /** Where to write the regression test. */
  testPath: string;
  testSource: string;
  /** Command that runs the regression test. */
  command: string;
  timeoutMs?: number;
}

export class ReproductionAgent {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly validation: ValidationEngine,
  ) {}

  /**
   * Write the regression test and confirm it fails against the unpatched code.
   *
   * A test that passes here is not evidence of a reproduction — it is evidence the
   * test does not exercise the bug — so this refuses rather than continuing.
   */
  async demonstrateFailure(input: ReproductionInput): Promise<ReproductionAttempt> {
    await this.sandbox.writeFile(input.testPath, input.testSource);
    const beforeFix = await this.validation.runCheck('reproduction', input.command, input.timeoutMs);

    const attempt: ReproductionAttempt = {
      testPath: input.testPath,
      command: input.command,
      beforeFix,
      afterFix: null,
      proven: false,
      failureReason: null,
    };

    if (beforeFix.skipped) {
      attempt.failureReason = `Reproduction could not run: ${beforeFix.skipReason}`;
      return attempt;
    }
    if (beforeFix.timedOut) {
      attempt.failureReason = 'Reproduction timed out before producing a result.';
      return attempt;
    }
    if (beforeFix.passed) {
      attempt.failureReason =
        'The regression test passed against the unpatched code, so it does not exercise the ' +
        'reported failure. This is not a reproduction.';
      return attempt;
    }
    // A command that could not start is not a reproduced bug.
    if (beforeFix.exitCode === 127) {
      attempt.failureReason =
        `The reproduction command could not be executed (exit 127): ${input.command}`;
      return attempt;
    }

    return attempt;
  }

  /**
   * Re-run the regression test after a patch has been applied.
   *
   * Takes the prior attempt so the before-state cannot be discarded or rewritten:
   * the pair is what constitutes the evidence.
   */
  async confirmFix(
    attempt: ReproductionAttempt,
    timeoutMs?: number,
  ): Promise<ReproductionAttempt> {
    if (attempt.beforeFix.passed || attempt.failureReason) {
      throw new ReproductionError(
        'Refusing to confirm a fix against a reproduction that was never established: ' +
          (attempt.failureReason ?? 'the test passed before the patch'),
      );
    }

    const afterFix = await this.validation.runCheck('reproduction', attempt.command, timeoutMs);
    const proven = afterFix.passed;

    return {
      ...attempt,
      afterFix,
      proven,
      failureReason: proven
        ? null
        : afterFix.timedOut
          ? 'The regression test timed out after the patch was applied.'
          : 'The regression test still fails after the patch, so the patch does not fix the bug.',
    };
  }
}

/**
 * A human-readable statement of what a reproduction proves.
 *
 * Written here rather than by a model so the claim cannot overstate the evidence.
 */
export function describeReproduction(attempt: ReproductionAttempt): string {
  if (attempt.proven && attempt.afterFix) {
    return (
      `Reproduced. \`${attempt.command}\` failed with exit ${attempt.beforeFix.exitCode} before the ` +
      `patch and passed after it` +
      (attempt.afterFix.testsPassed !== null ? ` (${attempt.afterFix.testsPassed} tests passed).` : '.')
    );
  }
  if (attempt.failureReason) return `Not reproduced. ${attempt.failureReason}`;
  return (
    `Failure demonstrated: \`${attempt.command}\` exits ${attempt.beforeFix.exitCode} against the ` +
    `deployed revision. No patch has been verified yet.`
  );
}
