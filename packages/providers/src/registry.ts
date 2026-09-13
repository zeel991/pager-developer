import { DatadogProvider } from './datadog/datadog-provider.js';
import { GitHubProvider } from './github/github-provider.js';
import { SlackProvider } from './slack/slack-provider.js';
import type { TwinRun } from './arga/twin-run.js';
import type {
  MessagingProvider,
  ObservabilityProvider,
  SourceControlProvider,
} from './types.js';

/**
 * Provider wiring.
 *
 * Backend selection happens exactly once, here. Everything downstream receives an
 * interface and cannot tell — and must never ask — whether it is talking to an Arga
 * twin, a local twin or a real vendor.
 */

export type Backend = 'arga' | 'real' | 'local';

export interface ProviderConfig {
  sourceControl: Backend;
  observability: Backend;
  messaging: Backend;
  /** Pinned endpoints, used by `local`, and by `real` when self-hosted. */
  baseUrls: { github?: string; datadog?: string; slack?: string };
  credentials: {
    githubToken?: string;
    slackBotToken?: string;
    datadogApiKey?: string;
    datadogAppKey?: string;
  };
}

export interface Providers {
  sourceControl: SourceControlProvider;
  observability: ObservabilityProvider;
  messaging: MessagingProvider;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** Canonical twin names, so a typo becomes a config error rather than a 404 later. */
const TWIN = { github: 'github', datadog: 'datadog', slack: 'slack' } as const;

export interface BuildProvidersOptions {
  config: ProviderConfig;
  /** Required when any backend is `arga`. */
  twinRun?: TwinRun | null;
  fetchImpl?: typeof globalThis.fetch;
}

export function buildProviders(opts: BuildProvidersOptions): Providers {
  const { config, twinRun = null } = opts;

  /**
   * Resolve one provider's endpoint and credentials for the chosen backend.
   *
   * The `arga` branch reads both the URL *and* the credentials from the twin's
   * `envVars`, because a twin mints its own tokens. Falling back to the operator's
   * real vendor token here would be a serious bug: it would let a simulation reach
   * real infrastructure. So `arga` never consults `config.credentials`.
   */
  const resolve = (
    backend: Backend,
    twinName: string,
    pinnedUrl: string | undefined,
    envVarNames: string[],
    realToken: string | undefined,
    realDefaultUrl: string,
  ): { baseUrl: string; token: string | undefined; env: Record<string, string> } => {
    switch (backend) {
      case 'arga': {
        if (!twinRun) {
          throw new ProviderConfigError(
            `Backend "arga" selected for ${twinName} but no Twin Run is attached. ` +
              `Provision one first, or set the backend to "local".`,
          );
        }
        if (!twinRun.has(twinName)) {
          throw new ProviderConfigError(
            `Backend "arga" selected for ${twinName}, but the Twin Run provisioned only: ` +
              `${twinRun.twinNames.join(', ') || '(none)'}.`,
          );
        }
        const ep = twinRun.endpoint(twinName);
        const token = envVarNames.map((n) => ep.envVars[n]).find((v) => Boolean(v));
        return { baseUrl: ep.baseUrl, token, env: ep.envVars };
      }
      case 'local': {
        if (!pinnedUrl) {
          throw new ProviderConfigError(
            `Backend "local" selected for ${twinName} but no base URL was pinned. ` +
              `Set the corresponding *_BASE_URL.`,
          );
        }
        return { baseUrl: pinnedUrl, token: undefined, env: {} };
      }
      case 'real': {
        if (!realToken) {
          throw new ProviderConfigError(
            `Backend "real" selected for ${twinName} but no credential was supplied. ` +
              `This is refused rather than defaulted: an unauthenticated call to a real ` +
              `vendor is never what was intended.`,
          );
        }
        return { baseUrl: pinnedUrl ?? realDefaultUrl, token: realToken, env: {} };
      }
    }
  };

  const gh = resolve(
    config.sourceControl,
    TWIN.github,
    config.baseUrls.github,
    ['GITHUB_TOKEN', 'GH_TOKEN'],
    config.credentials.githubToken,
    'https://api.github.com',
  );

  const dd = resolve(
    config.observability,
    TWIN.datadog,
    config.baseUrls.datadog,
    ['DD_API_KEY', 'DATADOG_API_KEY'],
    config.credentials.datadogApiKey,
    'https://api.datadoghq.com',
  );

  const slack = resolve(
    config.messaging,
    TWIN.slack,
    config.baseUrls.slack,
    ['SLACK_BOT_TOKEN', 'SLACK_TOKEN'],
    config.credentials.slackBotToken,
    'https://slack.com',
  );

  return {
    sourceControl: new GitHubProvider({
      baseUrl: gh.baseUrl,
      ...(gh.token ? { token: gh.token } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    }),
    observability: new DatadogProvider({
      baseUrl: dd.baseUrl,
      ...(dd.token ? { apiKey: dd.token } : {}),
      ...(dd.env.DD_APP_KEY || config.credentials.datadogAppKey
        ? { appKey: dd.env.DD_APP_KEY ?? config.credentials.datadogAppKey! }
        : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    }),
    messaging: new SlackProvider({
      baseUrl: slack.baseUrl,
      ...(slack.token ? { token: slack.token } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    }),
  };
}

/** Which twins a config requires. Used to provision exactly what is needed. */
export function requiredTwins(config: ProviderConfig): string[] {
  const wanted: string[] = [];
  if (config.sourceControl === 'arga') wanted.push(TWIN.github);
  if (config.observability === 'arga') wanted.push(TWIN.datadog);
  if (config.messaging === 'arga') wanted.push(TWIN.slack);
  return wanted;
}
