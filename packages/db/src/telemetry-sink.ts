import type { Database } from './client.js';
import { agentRuns, toolCalls } from './schema.js';
import { eq } from 'drizzle-orm';

/**
 * Structural copy of @pager/observability's TelemetrySink contract.
 *
 * Declared here rather than imported so @pager/db does not depend on the
 * observability package: the dependency would run the wrong way, since
 * instrumentation should not require a database to exist.
 */
export interface SinkAgentRun {
  id: string;
  incidentId: string | null;
  agentName: string;
  status: 'RUNNING' | 'OK' | 'ERROR';
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  endedAt: Date | null;
  traceId: string | null;
}

export interface SinkToolCall {
  id: string;
  agentRunId: string;
  incidentId: string | null;
  toolName: string;
  input: unknown;
  output: unknown;
  status: 'OK' | 'ERROR';
  error: string | null;
  startedAt: Date;
  durationMs: number;
  attempt: number;
}

/**
 * Persists agent runs and tool calls to Postgres.
 *
 * This is what makes tool call ids durable, and therefore what makes evidence
 * citations meaningful across a process restart: an Evidence row's
 * `sourceToolCallId` foreign key can only resolve if the call was written here
 * first. Ordering matters — a tool call is written before any evidence citing it.
 */
export class DrizzleTelemetrySink {
  constructor(private readonly db: Database) {}

  async startAgentRun(record: SinkAgentRun): Promise<void> {
    await this.db.insert(agentRuns).values({
      id: record.id,
      incidentId: record.incidentId,
      agentName: record.agentName,
      status: record.status,
      input: toJson(record.input),
      output: toJson(record.output),
      error: record.error,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      traceId: record.traceId,
    });
  }

  async finishAgentRun(record: SinkAgentRun): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: record.status,
        output: toJson(record.output),
        error: record.error,
        endedAt: record.endedAt,
        traceId: record.traceId,
      })
      .where(eq(agentRuns.id, record.id));
  }

  async recordToolCall(record: SinkToolCall): Promise<void> {
    await this.db.insert(toolCalls).values({
      id: record.id,
      agentRunId: record.agentRunId,
      incidentId: record.incidentId,
      toolName: record.toolName,
      status: record.status,
      input: toJson(record.input),
      output: toJson(record.output),
      error: record.error,
      attempt: record.attempt,
      durationMs: record.durationMs,
      startedAt: record.startedAt,
    });
  }
}

/**
 * Make a value safe for a jsonb column.
 *
 * Tool inputs and outputs are arbitrary provider payloads and can carry Dates, Maps,
 * Sets or cycles. A serialisation failure here would take down an agent run for a
 * reason that has nothing to do with the incident, so unserialisable values are
 * replaced with a marker rather than thrown.
 */
function toJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => {
        if (v instanceof Date) return v.toISOString();
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return [...v];
        return v;
      }),
    );
  } catch (err) {
    return { __unserializable: err instanceof Error ? err.message : String(err) };
  }
}
