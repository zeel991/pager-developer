/**
 * What the worker needs to run, resolved once from the environment.
 *
 * Every field is required and validated up front. A worker that starts with half
 * its configuration and discovers the rest during an incident is worse than one
 * that refuses to start: the first failure would happen at the moment it mattered.
 */

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
  };

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
  ].join('\n  ');
}
