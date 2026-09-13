import type { ErrorCluster } from './log-analysis.js';
import type { InvestigationFindings } from './investigator/schema.js';

/**
 * The seam where code authorship lives.
 *
 * Writing a regression test and a patch is the one part of this workflow that
 * genuinely needs a reasoning model. Everything around it — locating the failure,
 * running the tests, checking the exit codes, opening the PR — is deterministic and
 * happens whether or not a model is configured.
 *
 * `kind` is carried on every result and recorded on the FixCandidate, so it is always
 * visible whether a patch was authored by a model or supplied by a fixture. A
 * scripted generator exists to exercise the pipeline in tests; presenting its output
 * as though an agent had reasoned its way there would be a lie the product tells
 * about itself.
 */

export type GeneratorKind = 'model' | 'scripted' | 'none';

export interface PatchContext {
  service: string;
  repository: string;
  /** The revision production is running. Never the latest branch head. */
  revision: string;
  /** The revision it replaced, or null when deployment history is unknown. */
  previousRevision: string | null;
  cluster: ErrorCluster;
  /** Files the deployment changed, as candidate blame surface. */
  changedFiles: string[];
  /** Contents of files the agent asked to read, keyed by repository path. */
  sources: Record<string, string>;
  testCommand: string | null;
  /** Example of the repository's own test style, so a new test matches it. */
  existingTestExample: { path: string; source: string } | null;
  /** The reasoning step's conclusion. Null when no model investigated. */
  investigation: InvestigationFindings | null;
}

/**
 * Feedback from a failed validation attempt, offered on the single repair retry.
 *
 * Carried explicitly rather than accumulated in a conversation, so a generator
 * cannot be handed an unbounded history and so the retry budget is visible in the
 * type rather than buried in a loop.
 */
export interface RepairFeedback {
  /** What was tried and rejected. */
  previousPatch: PatchProposal;
  /** Which checks failed, with their real output. */
  failures: { kind: string; exitCode: number | null; output: string }[];
  summary: string;
}

export interface RegressionTestProposal {
  kind: GeneratorKind;
  path: string;
  source: string;
  rationale: string;
  /**
   * Distinctive strings that must appear in the runner's output when the intended
   * assertion fails against the unpatched code.
   *
   * This is what separates "the test suite exited non-zero" from "the specific
   * failure we set out to demonstrate actually occurred". A missing module, a syntax
   * error or an unrelated broken test all exit non-zero too, and none of them are a
   * reproduction.
   */
  expectedFailureMarkers: string[];
  /** What the assertion proves, in one sentence, for the pull request body. */
  expectedFailureDescription: string;
}

export interface PatchProposal {
  kind: GeneratorKind;
  rootCause: string;
  explanation: string;
  files: { path: string; content: string }[];
  risks: string[];
  rollbackPlan: string;
  confidence: number;
}

export interface PatchGenerator {
  readonly kind: GeneratorKind;
  /** A test that fails against the unpatched code. Null when it cannot write one. */
  proposeRegressionTest(context: PatchContext): Promise<RegressionTestProposal | null>;
  /**
   * The patch. Null when it cannot produce one.
   *
   * `feedback` is supplied only on the single bounded repair attempt, after a first
   * patch failed deterministic validation.
   */
  proposePatch(context: PatchContext, feedback?: RepairFeedback): Promise<PatchProposal | null>;
}

export class UnavailableGeneratorError extends Error {
  constructor() {
    super(
      'No patch generator is configured. Set ANTHROPIC_API_KEY to enable the model-backed ' +
        'generator, or inject a scripted one for testing.',
    );
    this.name = 'UnavailableGeneratorError';
  }
}

/**
 * The default when no model is configured.
 *
 * Returns null rather than attempting a heuristic patch. A guessed fix that happens
 * to make a test pass is the most dangerous possible output of this system, and it
 * is better to stop with the reproduction and the located frame in hand.
 */
export class NoPatchGenerator implements PatchGenerator {
  readonly kind = 'none' as const;
  async proposeRegressionTest(): Promise<null> {
    return null;
  }
  async proposePatch(): Promise<null> {
    return null;
  }
}

/**
 * A generator whose output is supplied up front.
 *
 * Used by tests and demos to exercise the pipeline plumbing around authorship. It
 * does not reason about anything, and everything it returns is marked `scripted`.
 */
export class ScriptedPatchGenerator implements PatchGenerator {
  readonly kind = 'scripted' as const;

  constructor(
    private readonly script: {
      regressionTest?: {
        path: string;
        source: string;
        rationale?: string;
        expectedFailureMarkers?: string[];
        expectedFailureDescription?: string;
      };
      patch?: Omit<PatchProposal, 'kind'>;
    },
  ) {}

  async proposeRegressionTest(): Promise<RegressionTestProposal | null> {
    const t = this.script.regressionTest;
    if (!t) return null;
    return {
      kind: this.kind,
      path: t.path,
      source: t.source,
      rationale: t.rationale ?? 'Supplied by a scripted generator, not authored by a model.',
      expectedFailureMarkers: t.expectedFailureMarkers ?? [],
      expectedFailureDescription:
        t.expectedFailureDescription ?? 'Supplied by a scripted generator.',
    };
  }

  async proposePatch(): Promise<PatchProposal | null> {
    const p = this.script.patch;
    return p ? { ...p, kind: this.kind } : null;
  }
}
