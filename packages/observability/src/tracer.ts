import { randomUUID } from 'node:crypto';
import { Lemma, type TraceContext } from '@uselemma/tracing';
import type { AgentRunRecord, TelemetrySink, ToolCallRecord } from './types.js';

/**
 * Agent instrumentation.
 *
 * Two properties matter more than the telemetry itself:
 *
 *  1. A failed tool call is *always* recorded and always rethrown. There is no code
 *     path that swallows one. "Pager must never silently ignore failed tool calls"
 *     is therefore a property of the wrapper, not a request made of the model.
 *
 *  2. `ToolCallRecord.id` is minted here, after the call has actually executed. It is
 *     the only identifier Evidence may cite. A model cannot fabricate evidence
 *     because it cannot fabricate an id that this recorder never issued.
 */

export interface AgentRunContext {
  readonly agentRunId: string;
  readonly incidentId: string | null;
  /**
   * Execute a tool call with full instrumentation.
   * Rethrows whatever `fn` threw, after recording the failure.
   */
  tool<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<ToolResult<T>>;
  /** Record a model call. Usage is omitted rather than zero-filled when unknown. */
  generation(opts: {
    name: string;
    model: string;
    input: unknown;
    output: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  }): void;
  /** Ids of every tool call this run has made, in order. */
  toolCallIds(): readonly string[];
}

export interface ToolResult<T> {
  value: T;
  /** The id Evidence must cite to refer to this observation. */
  toolCallId: string;
}

export interface TracerOptions {
  sink: TelemetrySink;
  /** Omit to run fully offline; instrumentation still records to the sink. */
  lemma?: Lemma | null;
  now?: () => Date;
  newId?: () => string;
}

export class AgentTracer {
  private readonly sink: TelemetrySink;
  private readonly lemma: Lemma | null;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(opts: TracerOptions) {
    this.sink = opts.sink;
    this.lemma = opts.lemma ?? null;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  /**
   * Run one agent as a single Lemma trace.
   *
   * `incidentId` becomes the Lemma `threadId`, so every agent that touches an
   * incident lands in one coherent thread: observer, detector, investigator, fix
   * agent and communicator all appear under the same incident.
   */
  async run<T>(
    agentName: string,
    opts: { incidentId?: string | null; input?: unknown },
    fn: (ctx: AgentRunContext) => Promise<T>,
  ): Promise<T> {
    const agentRunId = this.newId();
    const incidentId = opts.incidentId ?? null;
    const startedAt = this.now();

    const record: AgentRunRecord = {
      id: agentRunId,
      incidentId,
      agentName,
      status: 'RUNNING',
      input: opts.input ?? null,
      output: null,
      error: null,
      startedAt,
      endedAt: null,
      traceId: null,
    };
    await this.sink.startAgentRun(record);

    const body = async (trace: TraceContext | null): Promise<T> => {
      const ctx = this.makeContext(agentRunId, incidentId, trace);
      try {
        const value = await fn(ctx);
        await this.sink.finishAgentRun({
          ...record,
          status: 'OK',
          output: value ?? null,
          endedAt: this.now(),
        });
        return value;
      } catch (err) {
        await this.sink.finishAgentRun({
          ...record,
          status: 'ERROR',
          error: errorMessage(err),
          endedAt: this.now(),
        });
        throw err;
      }
    };

    if (!this.lemma) return body(null);

    return this.lemma.trace(
      {
        name: agentName,
        // One thread per incident is the whole point of the threadId here.
        ...(incidentId ? { threadId: incidentId } : {}),
        input: opts.input,
        metadata: { agentRunId, ...(incidentId ? { incidentId } : {}) },
      },
      (trace) => body(trace),
    );
  }

  private makeContext(
    agentRunId: string,
    incidentId: string | null,
    trace: TraceContext | null,
  ): AgentRunContext {
    const ids: string[] = [];
    const sink = this.sink;
    const now = this.now;
    const newId = this.newId;

    return {
      agentRunId,
      incidentId,
      toolCallIds: () => ids,

      async tool<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<ToolResult<T>> {
        const toolCallId = newId();
        const startedAt = now();
        const base = {
          id: toolCallId,
          agentRunId,
          incidentId,
          toolName: name,
          input,
          startedAt,
          attempt: 1,
        };

        try {
          const value = await fn();
          const durationMs = now().getTime() - startedAt.getTime();
          const rec: ToolCallRecord = {
            ...base,
            output: value ?? null,
            status: 'OK',
            error: null,
            durationMs,
          };
          await sink.recordToolCall(rec);
          trace?.recordTool({
            name,
            input,
            output: value,
            status: 'OK',
            durationMs,
            metadata: { toolCallId },
          });
          ids.push(toolCallId);
          return { value, toolCallId };
        } catch (err) {
          // A failed tool call is recorded before it is rethrown. Never swallowed,
          // never downgraded to a warning, never omitted from the trace.
          const durationMs = now().getTime() - startedAt.getTime();
          const rec: ToolCallRecord = {
            ...base,
            output: null,
            status: 'ERROR',
            error: errorMessage(err),
            durationMs,
          };
          await sink.recordToolCall(rec);
          trace?.recordTool({
            name,
            input,
            status: 'ERROR',
            error: errorMessage(err),
            durationMs,
            metadata: { toolCallId },
          });
          ids.push(toolCallId);
          throw err;
        }
      },

      generation(o) {
        trace?.recordGeneration({
          name: o.name,
          model: o.model,
          input: o.input,
          output: o.output,
          // Usage is omitted rather than zero-filled when the provider did not
          // report it, so analytics can tell "healthy zero" from "not instrumented".
          ...(o.usage
            ? { usage: { inputTokens: o.usage.inputTokens, outputTokens: o.usage.outputTokens } }
            : {}),
        });
      },
    };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Build a Lemma client from the environment, or null when not configured. */
export function lemmaFromEnv(env: NodeJS.ProcessEnv = process.env): Lemma | null {
  if (!env.LEMMA_API_KEY || !env.LEMMA_PROJECT_ID) return null;
  return new Lemma({
    apiKey: env.LEMMA_API_KEY,
    projectId: env.LEMMA_PROJECT_ID,
    ...(env.LEMMA_RELEASE ? { release: env.LEMMA_RELEASE } : {}),
  });
}
