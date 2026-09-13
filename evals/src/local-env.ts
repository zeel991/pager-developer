import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  PAGER_APP_MANIFEST,
  SlackProvider,
  registerViaManifest,
  type MessagingProvider,
  type ObservabilityProvider,
  type SourceControlProvider,
} from '@pager/providers';
import { LocalTwinServer, fixture, seedFromFixture } from '@pager/twin-local';

/**
 * Bring up a complete local environment for a scenario.
 *
 * Providers are constructed exactly as they are for Arga — including the GitHub App
 * manifest flow — so nothing downstream can tell which backend it holds.
 */
export interface LocalEnvironment {
  server: LocalTwinServer;
  sourceControl: SourceControlProvider;
  observability: ObservabilityProvider;
  messaging: MessagingProvider;
  stop(): Promise<void>;
  reset(): void;
}

export async function startLocalEnvironment(scenarioId: string): Promise<LocalEnvironment> {
  const spec = fixture(scenarioId);
  const server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(spec));
  const endpoints = await server.start();

  const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
  const tokens = new GitHubAppTokenSource(endpoints.github, creds);

  return {
    server,
    sourceControl: new GitHubProvider({
      baseUrl: endpoints.github,
      tokenProvider: () => tokens.token(),
    }),
    observability: new DatadogProvider({ baseUrl: endpoints.datadog }),
    messaging: new SlackProvider({ baseUrl: endpoints.slack }),
    stop: () => server.stop(),
    reset: () => server.reset(),
  };
}
