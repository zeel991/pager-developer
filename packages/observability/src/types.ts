/** A recorded tool invocation. The id here is the only thing Evidence may cite. */
export interface ToolCallRecord {
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

export interface AgentRunRecord {
  id: string;
  incidentId: string | null;
  agentName: string;
  status: 'RUNNING' | 'OK' | 'ERROR';
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  endedAt: Date | null;
  /** Lemma trace id, so a local run row can be opened in Lemma. */
  traceId: string | null;
}

/**
 * Where run and tool-call records are persisted locally.
 *
 * Lemma is the analysis surface, but it is not the system of record: the product UI
 * and the evaluation harness must work when Lemma is unreachable, and a trace that
 * only ever existed in a vendor's system cannot be used to audit our own behaviour.
 */
export interface TelemetrySink {
  startAgentRun(record: AgentRunRecord): Promise<void>;
  finishAgentRun(record: AgentRunRecord): Promise<void>;
  recordToolCall(record: ToolCallRecord): Promise<void>;
}

/** An in-memory sink. Used by tests and by the evaluation harness. */
export class InMemorySink implements TelemetrySink {
  readonly agentRuns = new Map<string, AgentRunRecord>();
  readonly toolCalls: ToolCallRecord[] = [];

  async startAgentRun(record: AgentRunRecord): Promise<void> {
    this.agentRuns.set(record.id, { ...record });
  }
  async finishAgentRun(record: AgentRunRecord): Promise<void> {
    this.agentRuns.set(record.id, { ...record });
  }
  async recordToolCall(record: ToolCallRecord): Promise<void> {
    this.toolCalls.push({ ...record });
  }

  failedToolCalls(): ToolCallRecord[] {
    return this.toolCalls.filter((c) => c.status === 'ERROR');
  }
  callsTo(toolName: string): ToolCallRecord[] {
    return this.toolCalls.filter((c) => c.toolName === toolName);
  }
}
