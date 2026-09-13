/**
 * What the worker needs to run, resolved once from the environment.
 *
 * Every field is required and validated up front. A worker that starts with half
 * its configuration and discovers the rest during an incident is worse than one
 * that refuses to start: the first failure would happen at the moment it mattered.
 */

import { AUTONOMY_LEVELS, type AutonomyLevel } from '@pager/core';

export interface WorkerConfig {
  /** The service as Datadog knows it. */
  service: string;
  /** The repository the service is built from, `owner/name`. */
  repository: string;
  baseBranch: string;
  /** Where the running service reports its health and deployed revision. */
  healthUrl: string;
  slackChannel: string;
  datadog: { baseUrl: string; apiKey: string; appKey: string };
  githubToken: string;
  slackToken: string;
  anthropicKey: string;
  model: string;
  /** Seconds between checks. */
  intervalSeconds: number;
  /** Stop after a single check. Used to exercise the worker without a loop. */
  once: boolean;
  /**
   * Refuse to open pull requests. The worker still investigates and reports, so a
   * deployment can be observed before it is trusted to write.
   */
  readOnly: boolean;
  /**
   * Offer a merge button in Slack, and accept the interaction that backs it.
   *
   * Opt-in and off by default. Merging is the one action that changes production,
   * and a deployment should have to say out loud that it wants that button to exist.
   * Without a signing secret it stays off whatever this says: an endpoint that
   * merges pull requests without verifying who asked is not a feature.
   */
  mergeButton: boolean;
  slackSigningSecret: string;
  /**
   * The operator's standing decision about what this worker may do at all.
   *
   * Read from configuration rather than assumed, because merging asserts against it
   * and a check whose input the code supplies itself is not a check. L3 — open a
   * pull request — is the default; merging needs L4 and will refuse below it however
   * the button is configured.
   */
  autonomy: AutonomyLevel;
  /**
   * Where the postmortem is written, and who is told. Both optional: an incident
   * is handled correctly without either, and a missing integration must degrade
   * rather than block the repair.
   */
  notion: { token: string; parentPageId: string } | null;
  email: { apiKey: string; from: string; to: string[] } | null;
}

export class WorkerConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `The worker cannot start. Missing or empty: ${missing.join(', ')}. ` +
        `Refusing to run partially configured — a gap discovered mid-incident is worse ` +
        `than one discovered at startup.`,
    );
    this.name = 'WorkerConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string, missing: string[]): string {
  const value = env[key]?.trim();
  if (!value) missing.push(key);
  return value ?? '';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing: string[] = [];

  const config: WorkerConfig = {
    service: required(env, 'PAGER_SERVICE', missing),
    repository: required(env, 'PAGER_REPOSITORY', missing),
    baseBranch: env.PAGER_BASE_BRANCH?.trim() || 'main',
    healthUrl: required(env, 'PAGER_HEALTH_URL', missing),
    slackChannel: required(env, 'PAGER_SLACK_CHANNEL', missing),
    datadog: {
      baseUrl: env.DATADOG_BASE_URL?.trim() || 'https://api.datadoghq.com',
      apiKey: required(env, 'DATADOG_API_KEY', missing),
      appKey: required(env, 'DATADOG_APP_KEY', missing),
    },
    githubToken: required(env, 'GITHUB_TOKEN', missing),
    slackToken: required(env, 'SLACK_BOT_TOKEN', missing),
    anthropicKey: required(env, 'ANTHROPIC_API_KEY', missing),
    model: env.PAGER_MODEL?.trim() || 'claude-opus-5',
    intervalSeconds: Number(env.PAGER_INTERVAL_SECONDS ?? 60),
    once: env.PAGER_WORKER_ONCE === '1',
    readOnly: env.PAGER_READ_ONLY === '1',
    mergeButton: env.PAGER_ENABLE_MERGE_BUTTON === '1' && Boolean(env.SLACK_SIGNING_SECRET?.trim()),
    slackSigningSecret: env.SLACK_SIGNING_SECRET?.trim() ?? '',
    autonomy: (env.PAGER_AUTONOMY_LEVEL?.trim() || 'L3') as AutonomyLevel,
    notion:
      env.NOTION_TOKEN?.trim() && env.NOTION_PARENT_PAGE_ID?.trim()
        ? { token: env.NOTION_TOKEN.trim(), parentPageId: env.NOTION_PARENT_PAGE_ID.trim() }
        : null,
    email:
      env.RESEND_API_KEY?.trim() && env.PAGER_EMAIL_FROM?.trim() && env.PAGER_TEAM_EMAILS?.trim()
        ? {
            apiKey: env.RESEND_API_KEY.trim(),
            from: env.PAGER_EMAIL_FROM.trim(),
            to: env.PAGER_TEAM_EMAILS.split(',').map((e) => e.trim()).filter(Boolean),
          }
        : null,
  };

  // Half a configuration is worse than none: it looks configured and silently
  // does nothing. Say which half is missing.
  if (env.NOTION_TOKEN?.trim() && !env.NOTION_PARENT_PAGE_ID?.trim()) {
    missing.push('NOTION_PARENT_PAGE_ID (NOTION_TOKEN is set without it)');
  }
  if (env.RESEND_API_KEY?.trim() && !env.PAGER_EMAIL_FROM?.trim()) {
    missing.push('PAGER_EMAIL_FROM (RESEND_API_KEY is set without it)');
  }

  if (!(AUTONOMY_LEVELS as readonly string[]).includes(config.autonomy)) {
    missing.push(`PAGER_AUTONOMY_LEVEL (got "${config.autonomy}", expected one of ${AUTONOMY_LEVELS.join(', ')})`);
  }

  // Say so rather than failing silently: asking for the button without the secret
  // is a configuration mistake that would otherwise look like the button "not
  // working" when in fact it was deliberately withheld.
  if (env.PAGER_ENABLE_MERGE_BUTTON === '1' && !env.SLACK_SIGNING_SECRET?.trim()) {
    missing.push('SLACK_SIGNING_SECRET (required by PAGER_ENABLE_MERGE_BUTTON)');
  }

  if (missing.length > 0) throw new WorkerConfigError(missing);
  return config;
}

/** A description safe to log: names what is configured, never any value. */
export function describeConfig(config: WorkerConfig): string {
  return [
    `service        ${config.service}`,
    `repository     ${config.repository} (${config.baseBranch})`,
    `health         ${config.healthUrl}`,
    `datadog        ${config.datadog.baseUrl}`,
    `slack          ${config.slackChannel}`,
    `model          ${config.model}`,
    `interval       ${config.intervalSeconds}s`,
    `mode           ${config.readOnly ? 'READ ONLY — will not open pull requests' : 'may open pull requests for human review'}`,
    `autonomy       ${config.autonomy}`,
    `postmortem     ${config.notion ? `Notion page ${config.notion.parentPageId.slice(0, 8)}…` : 'off — no write-up will be filed'}`,
    `email          ${config.email ? `${config.email.to.length} recipient(s) via Resend` : 'off — nobody is mailed'}`,
    `merge button   ${
      !config.mergeButton
        ? 'off — merging happens on GitHub'
        : config.autonomy === 'L4' || config.autonomy === 'L5'
          ? 'OFFERED — a human click merges, recorded against them'
          : `offered, but merging will be REFUSED at ${config.autonomy}: it needs L4`
    }`,
  ].join('\n  ');
}
