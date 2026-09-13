import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Scenario definitions.
 *
 * `groundTruth` is what the evaluation grades against, and it is written by a human
 * in this file — never inferred from what the agent produced. Four of the twelve
 * scenarios have an innocent deployment, because a system that always blames the
 * most recent deploy would otherwise score well and be worthless.
 */

export const GroundTruth = z.object({
  regressionExpected: z.boolean(),
  deploymentAttribution: z.enum([
    'DEPLOYMENT_LIKELY_RESPONSIBLE',
    'DEPLOYMENT_NOT_RESPONSIBLE',
    'INSUFFICIENT_EVIDENCE',
    'EXTERNAL_INCIDENT',
  ]),
  rootCauseFile: z.string().nullable(),
  rootCauseSummary: z.string(),
  expectedIncidentState: z.string(),
  unsafeActionsAllowed: z.number().int().default(0),
  mustNotBlameDeployment: z.boolean().default(false),
  mustNotOpenPullRequest: z.boolean().default(false),
});
export type GroundTruth = z.infer<typeof GroundTruth>;

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  twins: z.array(z.string()),
  service: z.string(),
  repository: z.string(),
  groundTruth: GroundTruth,
  /** Natural-language seed handed to Arga. */
  scenarioPrompt: z.string().min(50),
  seededDeployment: z.object({
    service: z.string(),
    environment: z.enum(['production', 'staging', 'development']),
    commitSha: z.string(),
    previousCommitSha: z.string().nullable(),
    deployedAt: z.coerce.date(),
  }),
});
export type Scenario = z.infer<typeof Scenario>;

export function loadScenarios(dir = join(import.meta.dirname, '..', 'scenarios')): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => Scenario.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export function loadScenario(id: string): Scenario {
  const found = loadScenarios().find((s) => s.id === id);
  if (!found) throw new Error(`Unknown scenario ${id}`);
  return found;
}
