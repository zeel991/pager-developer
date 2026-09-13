import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Claim, Evidence } from '@pager/core';
import { SlackProvider } from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import {
  CommunicationAgent,
  UnsupportedCommunicationError,
  formatFixReady,
  formatInvestigationUpdate,
  formatOpening,
  formatRecovery,
} from '../src/communication.js';

describe('message composition', () => {
  const incident = { key: 'INC-184', service: 'checkout-api', severity: 'SEV1', title: 't' };
  const regression = { metric: 'error_rate', baselineLabel: '0.40%', observedLabel: '17.75%', severity: 'SEV1' };
  const deployment = { shortSha: 'a83f12', author: 'Dana', deployedAt: new Date(), pullRequest: '#377' };

  it('states attribution as under investigation rather than implying blame', () => {
    const text = formatOpening(incident, regression, deployment);
    expect(text).toContain('*Deployment attribution*  Under investigation');
    expect(text).toContain('No production changes have been made.');
    // The deployment is mentioned as context, never as a cause.
    expect(text).not.toMatch(/caused|because of|due to/i);
  });

  it('says plainly when a deployment is not responsible', () => {
    const text = formatOpening(incident, regression, deployment, 'EXTERNAL_INCIDENT');
    expect(text).toContain('External incident — deployment not responsible');
  });

  it('labels hypotheses as unconfirmed and states their confidence', () => {
    const text = formatInvestigationUpdate(
      ['The failure occurs inside CheckoutService.createOrder().'],
      [{ statement: 'The deployed commit changed the affected contract', confidence: 0.82 }],
      'Attempting reproduction.',
    );
    expect(text).toContain('*Hypotheses* _(not yet confirmed)_');
    expect(text).toContain('confidence 82%');
    expect(text).toContain('*Established*');
  });

  it('says there are no conclusions rather than padding an empty update', () => {
    expect(formatInvestigationUpdate([], [], null)).toContain('No conclusions yet');
  });

  it('reports skipped checks as not run, never folded into a pass', () => {
    const text = formatFixReady(
      'discountCode widened to optional while createOrder dereferenced it',
      {
        reproduced: true,
        reproductionDescription: 'failed with exit 1 before the patch and passed after it',
        checks: [
          { kind: 'test', passed: true, skipped: false, testsPassed: 187 },
          { kind: 'typecheck', passed: true, skipped: false, testsPassed: null },
          { kind: 'lint', passed: false, skipped: true, testsPassed: null },
        ],
        pullRequestUrl: 'https://github.test/pull/382',
        pullRequestNumber: 382,
      },
      ['Changes a shared contract used by the storefront.'],
    );
    expect(text).toContain('test: passed (187 tests)');
    expect(text).toContain('not run: lint');
    expect(text).not.toMatch(/all checks passed/i);
    expect(text).toContain('Awaiting human approval');
  });

  it('does not claim recovery when signals have not returned', () => {
    const text = formatRecovery('error_rate', '0.40%', '17.75%', '12.10%', false);
    expect(text).toContain('Recovery not yet verified');
    expect(text).toContain('the incident remains open');
    expect(text).not.toContain('Incident resolved');
  });
});

describe('CommunicationAgent evidence gate', () => {
  let server: LocalTwinServer;
  let agent: CommunicationAgent;
  let sink: InMemorySink;
  let tracer: AgentTracer;

  const evidence: Evidence[] = [
    {
      id: 'ev-1', incidentId: 'INC-184', kind: 'DATADOG_LOG', provenance: 'OBSERVED',
      summary: 'stack trace', sourceToolCallId: 'tc-1', collectedAt: new Date(), payload: {},
    },
    {
      id: 'ev-2', incidentId: 'INC-184', kind: 'CODE_DIFF', provenance: 'OBSERVED',
      summary: 'diff', sourceToolCallId: 'tc-2', collectedAt: new Date(), payload: {},
    },
  ];

  const claim = (over: Partial<Claim>): Claim => ({
    id: 'c1', incidentId: 'INC-184', status: 'FACT',
    statement: 'CheckoutService introduced the regression',
    evidenceIds: ['ev-1', 'ev-2'], ...over,
  });

  beforeEach(async () => {
    server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
    server.seed(seedFromFixture(INC_001));
    const endpoints = await server.start();
    agent = new CommunicationAgent(new SlackProvider({ baseUrl: endpoints.slack }));
    sink = new InMemorySink();
    tracer = new AgentTracer({ sink, lemma: null });
  });
  afterEach(async () => {
    await server.stop();
  });

  it('opens one thread per incident and replies into it', async () => {
    await tracer.run('CommunicationAgent', { incidentId: 'INC-184' }, async (ctx) => {
      const thread = await agent.openThread(ctx, '#incidents', 'Regression detected');
      await agent.reply(ctx, thread, 'Investigation update');
      const posted = await agent.readThread(ctx, thread);
      expect(posted.map((m) => m.text)).toEqual(['Regression detected', 'Investigation update']);
      return null;
    });
    expect(sink.callsTo('slack.openThread')).toHaveLength(1);
  });

  it('sends a fact that cites real evidence', async () => {
    await tracer.run('CommunicationAgent', {}, async (ctx) => {
      await expect(
        agent.openThread(ctx, '#incidents', 'Root cause confirmed.', [claim({})], evidence),
      ).resolves.toBeTruthy();
      return null;
    });
  });

  it('refuses to send a fact citing evidence that does not exist', async () => {
    await tracer.run('CommunicationAgent', {}, async (ctx) => {
      await expect(
        agent.openThread(ctx, '#incidents', 'Root cause confirmed.', [claim({ evidenceIds: ['ev-1', 'invented'] })], evidence),
      ).rejects.toThrow(UnsupportedCommunicationError);
      return null;
    });
    // Nothing was posted: the gate runs before the send, not after.
    expect(sink.callsTo('slack.openThread')).toHaveLength(0);
  });

  it('refuses to send a fact with no evidence at all', async () => {
    await tracer.run('CommunicationAgent', {}, async (ctx) => {
      await expect(
        agent.reply(ctx, { id: '1', channel: '#incidents' }, 'Root cause confirmed.', [claim({ evidenceIds: [] })], evidence),
      ).rejects.toThrow(/asserted as fact with no evidence/);
      return null;
    });
    expect(sink.callsTo('slack.replyInThread')).toHaveLength(0);
  });

  it('allows an uncited hypothesis, since it is not asserted as fact', async () => {
    await tracer.run('CommunicationAgent', {}, async (ctx) => {
      await expect(
        agent.openThread(ctx, '#incidents', 'Possible cause…', [claim({ status: 'HYPOTHESIS', evidenceIds: [], confidence: 0.6 })], evidence),
      ).resolves.toBeTruthy();
      return null;
    });
  });

  it('records a failed send rather than assuming the team was told', async () => {
    await tracer.run('CommunicationAgent', {}, async (ctx) => {
      await expect(agent.openThread(ctx, '#does-not-exist', 'hi')).rejects.toThrow(/channel_not_found/);
      return null;
    }).catch(() => {});
    expect(sink.failedToolCalls().map((c) => c.toolName)).toContain('slack.openThread');
  });
});
