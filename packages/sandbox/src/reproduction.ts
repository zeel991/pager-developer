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
  /**
   * How the before-state was established. Every check that had to pass for a
   * non-zero exit to count as a demonstrated failure rather than a broken command.
   */
  assertionEvidence: AssertionEvidence;
}

/**
 * Evidence that the intended assertion ran and failed for the intended reason.
 *
 * A non-zero exit code is necessary and nowhere near sufficient. A syntax error, a
 * missing import, a runner that could not start, or an unrelated test that was
 * already broken all exit non-zero, and treating any of them as a reproduction would
 * let the system claim it had reproduced a bug it never touched.
 */
export interface AssertionEvidence {
  /** The runner started and produced a result. */
  commandExecuted: boolean;
  /** A test assertion failed, as opposed to the file failing to load. */
  assertionFailed: boolean;
  /** Test counts parsed from the runner output, when it reported them. */
  testsFailed: number | null;
  /** Markers that were required in the output, and which of them were found. */
  requiredMarkers: string[];
  foundMarkers: string[];
  /** Failures in the pre-existing suite, which must not be counted as the reproduction. */
  preexistingFailure: boolean;
  /** Every check that did not hold. Empty when the reproduction is sound. */
  problems: string[];
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
  /**
   * Command that runs the regression test.
   *
   * Should target the regression test alone where the runner supports it, so an
   * unrelated failing test in the same suite cannot masquerade as the reproduction.
   */
  command: string;
  /** Strings that must appear in the failing output. At least one must be found. */
  expectedFailureMarkers?: string[];
  /**
   * The suite's result BEFORE the regression test was added.
   *
   * When this already failed, a failing run afterwards proves nothing about the new
   * assertion, and the reproduction is refused.
   */
  baseline?: ValidationRun | null;
  timeoutMs?: number;
}

/**
 * Output patterns that mean the test never ran, whatever the exit code says.
 *
 * Kept explicit and narrow. Each entry is a way a file can fail to load or a command
 * can fail to start — none of them is a failing assertion.
 */
const NOT_AN_ASSERTION = [
  /SyntaxError/i,
  /Cannot find module/i,
  /ERR_MODULE_NOT_FOUND/i,
  /ERR_UNKNOWN_FILE_EXTENSION/i,
  /Cannot find package/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /Missing script:/i,
  /ERR_UNSUPPORTED_DIR_IMPORT/i,
  /no test files found/i,
];

/** Output patterns that show a test assertion was evaluated and failed. */
const ASSERTION_SIGNALS = [
  /AssertionError/i,
  /^\s*(?:ℹ|#)\s*fail\s+[1-9]/m,
  /not ok \d+/,
  /expected .* to /i,
  /✕|×\s/,
  /Tests\s+\d+\s+failed/i,
  /assert\./,
];

function emptyAssertionEvidence(): AssertionEvidence {
  return {
    commandExecuted: false,
    assertionFailed: false,
    testsFailed: null,
    requiredMarkers: [],
    foundMarkers: [],
    preexistingFailure: false,
    problems: [],
  };
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

    const evidence = emptyAssertionEvidence();
    evidence.requiredMarkers = input.expectedFailureMarkers ?? [];

    const attempt: ReproductionAttempt = {
      testPath: input.testPath,
      command: input.command,
      beforeFix,
      afterFix: null,
      proven: false,
      failureReason: null,
      assertionEvidence: evidence,
    };

    if (beforeFix.skipped) {
      evidence.problems.push(`the command could not run: ${beforeFix.skipReason}`);
      attempt.failureReason = `Reproduction could not run: ${beforeFix.skipReason}`;
      return attempt;
    }
    if (beforeFix.timedOut) {
      evidence.problems.push('the command timed out');
      attempt.failureReason = 'Reproduction timed out before producing a result.';
      return attempt;
    }
    // A command that could not start is not a reproduced bug.
    if (beforeFix.exitCode === 127) {
      evidence.problems.push('the command could not be executed (exit 127)');
      attempt.failureReason =
        `The reproduction command could not be executed (exit 127): ${input.command}`;
      return attempt;
    }
    evidence.commandExecuted = true;

    if (beforeFix.passed) {
      evidence.problems.push('the test passed against the unpatched code');
      attempt.failureReason =
        'The regression test passed against the unpatched code, so it does not exercise the ' +
        'reported failure. This is not a reproduction.';
      return attempt;
    }

    // ── The exit code is non-zero. Now prove it is the right non-zero. ──────────
    const output = beforeFix.output;

    const loadFailure = NOT_AN_ASSERTION.find((p) => p.test(output));
    if (loadFailure) {
      evidence.problems.push(
        `the output matches ${String(loadFailure)}, which means the test file failed to load or ` +
          `the command failed to start rather than an assertion failing`,
      );
    }

    evidence.assertionFailed = ASSERTION_SIGNALS.some((p) => p.test(output));
    evidence.testsFailed = beforeFix.testsFailed;
    if (!evidence.assertionFailed && (beforeFix.testsFailed ?? 0) < 1) {
      evidence.problems.push(
        'no failing assertion is visible in the output, so there is no evidence the intended ' +
          'test actually ran',
      );
    }

    if (evidence.requiredMarkers.length > 0) {
      evidence.foundMarkers = evidence.requiredMarkers.filter((m) => output.includes(m));
      if (evidence.foundMarkers.length === 0) {
        evidence.problems.push(
          `none of the expected failure markers appeared in the output ` +
            `(${evidence.requiredMarkers.map((m) => JSON.stringify(m)).join(', ')}), so the failure ` +
            `observed is not demonstrably the one being investigated`,
        );
      }
    }

    // A suite that was already failing cannot be used to prove a new assertion fails.
    if (input.baseline && !input.baseline.skipped && !input.baseline.passed) {
      evidence.preexistingFailure = true;
      evidence.problems.push(
        `the repository's own checks already failed before the regression test was added ` +
          `(exit ${input.baseline.exitCode}), so a failing run afterwards is not attributable to ` +
          `the new assertion`,
      );
    }

    if (evidence.problems.length > 0) {
      attempt.failureReason =
        `\`${input.command}\` exited ${beforeFix.exitCode}, but that is not a demonstrated ` +
        `reproduction: ${evidence.problems.join('; ')}.`;
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
  const proof = describeAssertionEvidence(attempt.assertionEvidence);
  if (attempt.proven && attempt.afterFix) {
    return (
      `Reproduced. \`${attempt.command}\` failed with exit ${attempt.beforeFix.exitCode} before the ` +
      `patch and passed after it` +
      (attempt.afterFix.testsPassed !== null ? ` (${attempt.afterFix.testsPassed} tests passed)` : '') +
      `. ${proof}`
    );
  }
  if (attempt.failureReason) return `Not reproduced. ${attempt.failureReason}`;
  return (
    `Failure demonstrated: \`${attempt.command}\` exits ${attempt.beforeFix.exitCode} against the ` +
    `deployed revision. ${proof} No patch has been verified yet.`
  );
}

/** What was checked to accept a non-zero exit as the intended failure. */
export function describeAssertionEvidence(evidence: AssertionEvidence): string {
  if (evidence.problems.length > 0) return `Assertion not proven: ${evidence.problems.join('; ')}.`;
  const parts = ['a test assertion failed (not a load or startup error)'];
  if (evidence.testsFailed !== null) parts.push(`${evidence.testsFailed} test(s) reported failing`);
  if (evidence.foundMarkers.length > 0) {
    parts.push(`expected failure text present: ${evidence.foundMarkers.map((m) => JSON.stringify(m)).join(', ')}`);
  }
  if (!evidence.preexistingFailure) parts.push('the pre-existing checks passed beforehand');
  return `Verified: ${parts.join('; ')}.`;
}
