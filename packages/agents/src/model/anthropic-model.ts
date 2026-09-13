import Anthropic from '@anthropic-ai/sdk';

/**
 * The reasoning model, as one concrete provider.
 *
 * Deliberately not an abstraction over "any LLM". There is exactly one model
 * provider in this system, it is the Anthropic Messages API, and pretending
 * otherwise would buy nothing but indirection. The narrow `ModelClient` interface
 * below exists for one reason only: deterministic guard tests must be able to drive
 * the investigator and the patch generator without spending money or depending on a
 * network, and a test that can only run against a live model is not a guard.
 *
 * What is recorded about a model call: identity, latency, and token usage when the
 * provider reports it. What is never recorded: the model's private reasoning. The
 * API's own default (`thinking.display: "omitted"`) is left in place, so raw chain of
 * thought is not returned to this process at all and therefore cannot be stored by
 * accident.
 */

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/** A tool the model asked to run. */
export interface ModelToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTurn {
  /** Opaque assistant content, echoed back verbatim on the next turn. */
  raw: unknown;
  text: string;
  toolUses: ModelToolUse[];
  stopReason: string | null;
  usage: ModelUsage;
  model: string;
  durationMs: number;
}

export interface ModelRequest {
  system: string;
  /** Conversation so far. `raw` values from prior turns are passed through. */
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxTokens?: number;
}

export type ModelMessage =
  | { role: 'user'; content: ModelUserBlock[] }
  | { role: 'assistant'; raw: unknown };

export type ModelUserBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ModelClient {
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelTurn>;
}

export class ModelUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `No reasoning model is available: ${reason}. Set ANTHROPIC_API_KEY to enable ` +
        `model-backed investigation and repair.`,
    );
    this.name = 'ModelUnavailableError';
  }
}

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  /** Wall-clock cap for a single request. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Reasoning depth. `high` is the API default; lowered for cheap eval passes. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class AnthropicModel implements ModelClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<AnthropicModelOptions['effort']>;
  private readonly maxTokens = DEFAULT_MAX_TOKENS;

  constructor(opts: AnthropicModelOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? 'high';
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 180_000,
      maxRetries: opts.maxRetries ?? 2,
    });
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const started = Date.now();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      output_config: { effort: this.effort },
      system: request.system,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: request.messages.map(toApiMessage),
    });

    const toolUses: ModelToolUse[] = [];
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      // `thinking` blocks are deliberately not read: the model's private reasoning
      // is echoed back to the API inside `raw` and never extracted or persisted.
      else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          // Tool inputs are JSON-decoded by the SDK. Never string-matched.
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      raw: response.content,
      text,
      toolUses,
      stopReason: response.stop_reason ?? null,
      usage: {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
      model: response.model ?? this.model,
      durationMs: Date.now() - started,
    };
  }
}

function toApiMessage(message: ModelMessage): Anthropic.MessageParam {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.raw as Anthropic.ContentBlockParam[] };
  }
  return {
    role: 'user',
    content: message.content.map((block) =>
      block.type === 'text'
        ? { type: 'text' as const, text: block.text }
        : {
            type: 'tool_result' as const,
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          },
    ),
  };
}

/**
 * Build a model client from the environment, or return null.
 *
 * Null rather than a throw, because "no model configured" is a supported mode: the
 * workflow still detects, files, notifies and halts with a handoff. Only the
 * authorship step needs a model.
 */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicModel | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return new AnthropicModel({
    apiKey,
    ...(env.PAGER_MODEL?.trim() ? { model: env.PAGER_MODEL.trim() } : {}),
    ...(env.PAGER_MODEL_EFFORT?.trim()
      ? { effort: env.PAGER_MODEL_EFFORT.trim() as AnthropicModelOptions['effort'] }
      : {}),
  });
}

/** Which model provider is configured, without revealing any part of the secret. */
export function describeModelAvailability(env: NodeJS.ProcessEnv = process.env): {
  available: boolean;
  provider: 'anthropic';
  model: string;
  reason: string;
} {
  const present = Boolean(env.ANTHROPIC_API_KEY?.trim());
  return {
    available: present,
    provider: 'anthropic',
    model: env.PAGER_MODEL?.trim() || DEFAULT_MODEL,
    reason: present
      ? 'ANTHROPIC_API_KEY is present.'
      : 'ANTHROPIC_API_KEY is not set or is empty.',
  };
}
