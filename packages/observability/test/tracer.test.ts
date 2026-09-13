import { describe, expect, it } from 'vitest';
import { AgentTracer, InMemorySink } from '../src/index.js';

const tracer = (sink: InMemorySink) => {
  let n = 0;
  return new AgentTracer({ sink, lemma: null, newId: () => `id-${++n}` });
};

describe('AgentTracer', () => {
  it('records a successful run and its tool calls', async () => {
    const sink = new InMemorySink();
    const out = await tracer(sink).run('IncidentInvestigator', { incidentId: 'INC-184' }, async (ctx) => {
      const { value, toolCallId } = await ctx.tool('github.readDiff', { sha: 'b' }, async () => ({ files: 3 }));
      expect(toolCallId).toBeTruthy();
      return value.files;
    });

    expect(out).toBe(3);
    expect(sink.toolCalls).toHaveLength(1);
    expect(sink.toolCalls[0]).toMatchObject({
      toolName: 'github.readDiff',
      status: 'OK',
      incidentId: 'INC-184',
    });
    const run = [...sink.agentRuns.values()][0]!;
    expect(run.status).toBe('OK');
    expect(run.endedAt).not.toBeNull();
  });

  it('records a failed tool call and rethrows rather than swallowing it', async () => {
    const sink = new InMemorySink();
    await expect(
      tracer(sink).run('IncidentInvestigator', { incidentId: 'INC-1' }, async (ctx) => {
        await ctx.tool('datadog.queryMetrics', {}, async () => {
          throw new Error('502 from telemetry backend');
        });
        return 'unreachable';
      }),
    ).rejects.toThrow('502 from telemetry backend');

    expect(sink.failedToolCalls()).toHaveLength(1);
    expect(sink.failedToolCalls()[0]!.error).toBe('502 from telemetry backend');
    expect([...sink.agentRuns.values()][0]!.status).toBe('ERROR');
  });

  it('still records the failure when the agent catches the error itself', async () => {
    const sink = new InMemorySink();
    const result = await tracer(sink).run('RepositoryInvestigator', {}, async (ctx) => {
      try {
        await ctx.tool('github.getDiff', {}, async () => {
          throw new Error('not found');
        });
      } catch {
        // An agent may legitimately recover, but the failure is on the record
        // regardless — it cannot be hidden by handling it.
      }
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(sink.failedToolCalls()).toHaveLength(1);
    expect([...sink.agentRuns.values()][0]!.status).toBe('OK');
  });

  it('issues a distinct id per call, which is what evidence must cite', async () => {
    const sink = new InMemorySink();
    const ids = await tracer(sink).run('X', {}, async (ctx) => {
      const a = await ctx.tool('t', 1, async () => 'a');
      const b = await ctx.tool('t', 2, async () => 'b');
      return [a.toolCallId, b.toolCallId];
    });
    expect(new Set(ids).size).toBe(2);
    expect(sink.callsTo('t')).toHaveLength(2);
  });

  it('exposes the ordered tool call ids of a run', async () => {
    const sink = new InMemorySink();
    await tracer(sink).run('X', {}, async (ctx) => {
      await ctx.tool('one', {}, async () => 1);
      await ctx.tool('two', {}, async () => 2);
      expect(ctx.toolCallIds()).toHaveLength(2);
      return null;
    });
  });
});
