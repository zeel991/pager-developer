import { z } from 'zod';

export const Environment = z.enum(['production', 'staging', 'development']);
export type Environment = z.infer<typeof Environment>;

export const DeploymentStatus = z.enum([
  'pending',
  'in_progress',
  'succeeded',
  'failed',
  'rolled_back',
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const ChangedFile = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previousPath: z.string().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const Commit = z.object({
  sha: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string().optional(),
  committedAt: z.coerce.date(),
  parents: z.array(z.string()).default([]),
});
export type Commit = z.infer<typeof Commit>;

/**
 * The observation window around a deployment.
 *
 * `before` is the baseline the deployment is judged against; `after` is what we
 * actually observed. Both are explicit so that a regression can always be re-derived
 * from stored telemetry rather than trusted from a summary.
 */
export const TelemetryWindow = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});
export type TelemetryWindow = z.infer<typeof TelemetryWindow>;

export const Deployment = z.object({
  id: z.string(),
  organizationId: z.string(),
  serviceId: z.string(),

  environment: Environment,
  status: DeploymentStatus,

  repositoryFullName: z.string(),

  commitSha: z.string(),
  previousCommitSha: z.string().nullable(),

  commits: z.array(Commit).default([]),
  pullRequestNumbers: z.array(z.number().int()).default([]),
  changedFiles: z.array(ChangedFile).default([]),

  authorName: z.string().nullable(),

  startedAt: z.coerce.date(),
  deployedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),

  telemetryWindowBefore: TelemetryWindow.nullable(),
  telemetryWindowAfter: TelemetryWindow.nullable(),
});
export type Deployment = z.infer<typeof Deployment>;

/** Default observation windows: 30 minutes of baseline, 30 minutes of observation. */
export const DEFAULT_BASELINE_MINUTES = 30;
export const DEFAULT_OBSERVATION_MINUTES = 30;

export function deriveWindows(
  deployedAt: Date,
  opts: { baselineMinutes?: number; observationMinutes?: number } = {},
): { before: TelemetryWindow; after: TelemetryWindow } {
  const baseline = opts.baselineMinutes ?? DEFAULT_BASELINE_MINUTES;
  const observation = opts.observationMinutes ?? DEFAULT_OBSERVATION_MINUTES;
  const t = deployedAt.getTime();
  return {
    before: { from: new Date(t - baseline * 60_000), to: new Date(t) },
    after: { from: new Date(t), to: new Date(t + observation * 60_000) },
  };
}

/** Files touched by a deployment, as a set, for fast blame-surface checks. */
export function changedPaths(deployment: Pick<Deployment, 'changedFiles'>): Set<string> {
  return new Set(deployment.changedFiles.map((f) => f.path));
}
