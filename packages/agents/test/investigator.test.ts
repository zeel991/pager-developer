import { afterEach, describe, expect, it } from 'vitest';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  NotionProvider,
  PAGER_APP_MANIFEST,
  registerViaManifest,
} from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { IncidentInvestigator } from '../src/investigator/investigator.js';
import { validateFindings, type InvestigationFindings } from '../src/investigator/schema.js';
import { clusterErrors } from '../src/log-analysis.js';
import type { ModelClient, ModelRequest, ModelTurn } from '../src/model/anthropic-model.js';

/**
 * Guard tests for the reasoning step, with a scripted model rather than a live one.
 *
 * These are not a substitute for running the real model — nothing here shows that a
 * model can diagnose anything. What they do show is that the enforcement around it
 * holds: fabricated citations are rejected, budgets are honoured, abstention is
 * carried through, and text embedded in tool output cannot change what the loop
 * does. Those are the properties that must hold for EVERY model output, including
 * the ones a live run will never happen to produce.
 */

let server: LocalTwinServer;

/** A model whose turns are supplied up front. */
class ScriptedModel implements ModelClient {
  readonly model = 'scripted-model';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly turns: Partial<ModelTurn>[]) {}

  async complete(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.index++, this.turns.length - 1)] ?? {};
    return {
      raw: [],
      text: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: this.model,
      durationMs: 1,
      ...turn,
    };
  }
}

function submit(id: string, input: Record<string, unknown>): ModelTurn['toolUses'][number] {
  return { id, name: 'submit_findings', input };
}

function findingsBody(overrides: Partial<InvestigationFindings> & { toolCallId?: string } = {}) {
  const { toolCallId, ...rest } = overrides;
  return {
    diagnosis: 'createOrder dereferences an optional discount code.',
    rootCauseFile: 'src/checkout/service.ts',
    rootCauseLine: 20,
    evidence: [{ toolCallId: toolCallId ?? 'PLACEHOLDER', shows: 'The logs show a TypeError.' }],
    uncertainty: 'Whether any other caller depends on the current behaviour.',
    attribution: {
      verdict: 'DEPLOYMENT_LIKELY_RESPONSIBLE' as const,
      rationale: 'The deployment widened the field the failing line dereferences.',
    },
    decision: { action: 'REPAIR' as const, reason: 'A single-line guard fixes it.' },
    regressionTestPlan: 'Call createOrder with no discountCode and assert the order total.',
    confidence: 0.85,
    ...rest,
  };
}

async function environment() {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(INC_001));
  const e = await server.start();
  const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
  const tokens = new GitHubAppTokenSource(e.github, creds);
  const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
  const observability = new DatadogProvider({ baseUrl: e.datadog });
  const knowledge = new NotionProvider({ baseUrl: e.notion, token: 't', parentPageId: 'runbook-checkout' });

  const history = await sourceControl.listCommits(INC_001.repository, { limit: 2 });
  const logs = await observability.queryLogs(INC_001.service, {
    from: new Date('2026-09-13T14:00:00Z'),
    to: new Date('2026-09-13T15:00:00Z'),
  });

  return {
    providers: { sourceControl, observability, knowledge },
    target: {
      service: INC_001.service,
      repository: INC_001.repository,
      deployedRevision: history[0]!.sha,
      previousRevision: history[1]?.sha ?? null,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:28:59Z') },
      observationWindow: { from: new Date('2026-09-13T14:32:00Z'), to: new Date('2026-09-13T15:00:00Z') },
    },
    cluster: clusterErrors(logs)[0]!,
  };
}

function investigatorFor(model: ModelClient, providers: Awaited<ReturnType<typeof environment>>['providers'], limits = {}) {
  return new IncidentInvestigator({
    model,
    tracer: new AgentTracer({ sink: new InMemorySink(), lemma: null }),
    providers,
    limits,
  });
}

afterEach(async () => {
  await server?.stop();
});

describe('IncidentInvestigator', () => {
  it('rejects findings that cite a tool call the tracer never issued', async () => {
    const env = await environment();
    // Two turns: the first fabricates an id, the second repeats the fabrication.
    const model = new ScriptedModel([
      { toolUses: [submit('t1', findingsBody({ toolCallId: 'fabricated-id-0000' }))], stopReason: 'tool_use' },
      { toolUses: [submit('t2', findingsBody({ toolCallId: 'still-fabricated' }))], stopReason: 'tool_use' },
    ]);

    const result = await investigatorFor(model, env.providers).investigate({
      target: env.target,
      cluster: env.cluster,
      monitorName: 'checkout-api error rate',
      firedAt: new Date('2026-09-13T14:34:00Z'),
    });

    expect(result.findings).toBeNull();
    expect(result.limitHit).toBe('validation');
    expect(result.abandonedReason).toMatch(/never issued/);
    // The rejection was fed back once before giving up, rather than silently dropped.
    expect(result.warnings.some((w) => /rejected once and retried/.test(w))).toBe(true);
  });

  it('accepts findings that cite a tool call it really made', async () => {
    const env = await environment();
    // First turn reads the logs; the second cites whatever id that produced.
    let issuedId: string | null = null;
    const model: ModelClient = {
      model: 'scripted-model',
      async complete(request) {
        const base = {
          raw: [], text: '', stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 }, model: 'scripted-model', durationMs: 1,
        };
        if (request.messages.length === 1) {
          return { ...base, toolUses: [{ id: 'u1', name: 'read_logs', input: { window: 'observation' } }] };
        }
        // Recover the id the tool result handed back, exactly as a model would.
        const last = request.messages[request.messages.length - 1]!;
        if (last.role === 'user') {
          const block = last.content.find((b) => b.type === 'tool_result');
          if (block && block.type === 'tool_result') {
            issuedId = (JSON.parse(block.content) as { toolCallId: string }).toolCallId;
          }
        }
        return { ...base, toolUses: [submit('u2', findingsBody({ toolCallId: issuedId! }))] };
      },
    };

    const result = await investigatorFor(model, env.providers).investigate({
      target: env.target,
      cluster: env.cluster,
      monitorName: 'checkout-api error rate',
      firedAt: new Date('2026-09-13T14:34:00Z'),
    });

    expect(result.abandonedReason).toBeNull();
    expect(result.findings!.decision.action).toBe('REPAIR');
    expect(result.findings!.evidence[0]!.toolCallId).toBe(issuedId);
    expect(result.toolCallIds).toContain(issuedId);
    // Usage is recorded from what the provider reported, not invented.
    expect(result.modelCalls).toHaveLength(2);
    expect(result.totalInputTokens).toBe(20);
  });

  it('carries an abstention through as a first-class outcome', async () => {
    const env = await environment();
    const model: ModelClient = {
      model: 'scripted-model',
      async complete(request) {
        const base = {
          raw: [], text: '', stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 }, model: 'scripted-model', durationMs: 1,
        };
        if (request.messages.length === 1) {
          return { ...base, toolUses: [{ id: 'u1', name: 'read_logs', input: { window: 'observation' } }] };
        }
        const last = request.messages[request.messages.length - 1]!;
        let id = '';
        if (last.role === 'user') {
          const block = last.content.find((b) => b.type === 'tool_result');
          if (block?.type === 'tool_result') id = (JSON.parse(block.content) as { toolCallId: string }).toolCallId;
        }
        return {
          ...base,
          toolUses: [
            submit(
              'u2',
              findingsBody({
                toolCallId: id,
                attribution: { verdict: 'EXTERNAL_INCIDENT', rationale: 'Every frame is upstream.' },
                decision: { action: 'ABSTAIN', reason: 'The fault is outside this repository.' },
                regressionTestPlan: null,
              }),
            ),
          ],
        };
      },
    };

    const result = await investigatorFor(model, env.providers).investigate({
      target: env.target,
      cluster: env.cluster,
      monitorName: 'checkout-api error rate',
      firedAt: new Date('2026-09-13T14:34:00Z'),
    });

    expect(result.findings!.decision.action).toBe('ABSTAIN');
    expect(result.abandonedReason).toBeNull();
  });

  it('stops reading once the tool budget is spent, and says so', async () => {
    const env = await environment();
    const model = new ScriptedModel([
      { toolUses: [{ id: 'u1', name: 'read_logs', input: { window: 'observation' } }], stopReason: 'tool_use' },
    ]);

    const result = await investigatorFor(model, env.providers, {
      maxToolCalls: 2,
      maxTurns: 5,
    }).investigate({
      target: env.target,
      cluster: env.cluster,
      monitorName: 'checkout-api error rate',
      firedAt: new Date('2026-09-13T14:34:00Z'),
    });

    expect(result.toolCallCount).toBe(2);
    expect(result.limitHit).toBe('tool_calls');
    expect(result.findings).toBeNull();
  });

  it('offers no tool that can write to any external system', async () => {
    const env = await environment();
    const model = new ScriptedModel([{ toolUses: [], stopReason: 'end_turn' }]);
    await investigatorFor(model, env.providers).investigate({
      target: env.target,
      cluster: env.cluster,
      monitorName: 'checkout-api error rate',
      firedAt: new Date('2026-09-13T14:34:00Z'),
    });

    const offered = model.requests[0]!.tools.map((t) => t.name);
    expect(offered).toContain('read_logs');
    expect(offered).toContain('read_runbook');
    // Nothing that creates, posts, commits, merges or deploys.
    for (const name of offered) {
      expect(name).toMatch(/^(read_|list_|search_|submit_findings$)/);
    }
  });

  it('pins every repository read to the deployed revision, not to a ref the model picks', async () => {
    const env = await environment();
    const model = new ScriptedModel([
      { toolUses: [{ id: 'u1', name: 'read_repository_file', input: { path: 'src/checkout/service.ts' } }], stopReason: 'tool_use' },
    ]);

    await investigatorFor(model, env.providers, { maxTurns: 2, maxToolCalls: 1 }).investigate({
      target: env.target,
      cluster: env.cluster,
      monitorName: 'checkout-api error rate',
      firedAt: new Date('2026-09-13T14:34:00Z'),
    });

    // The file tool takes only a path. There is no ref parameter to supply.
    const spec = model.requests[0]!.tools.find((t) => t.name === 'read_repository_file')!;
    const properties = (spec.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(['path']);
  });
});

describe('findings validation', () => {
  const issued = ['real-call-1', 'real-call-2'];

  it('refuses a repair decision built on an insufficient-evidence attribution', () => {
    const reasons = validateFindings(
      findingsBody({
        toolCallId: 'real-call-1',
        attribution: { verdict: 'INSUFFICIENT_EVIDENCE', rationale: 'Not enough signal.' },
      }) as InvestigationFindings,
      issued,
    );
    expect(reasons.join(' ')).toMatch(/insufficient/i);
  });

  it('refuses a repair decision with no plan for demonstrating the failure', () => {
    const reasons = validateFindings(
      findingsBody({ toolCallId: 'real-call-1', regressionTestPlan: null }) as InvestigationFindings,
      issued,
    );
    expect(reasons.join(' ')).toMatch(/without a plan/);
  });

  it('accepts a well-formed repair decision', () => {
    expect(
      validateFindings(findingsBody({ toolCallId: 'real-call-2' }) as InvestigationFindings, issued),
    ).toEqual([]);
  });
});
