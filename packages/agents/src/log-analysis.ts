import type { LogEntry } from '@pager/providers';

/**
 * Deterministic log analysis.
 *
 * Turns a pile of error logs into a small number of distinct failures, each located
 * in a file. None of this needs a reasoning model: a stack trace already says where
 * the code failed, and saying so from the trace is more reliable than asking a model
 * to guess it.
 *
 * What a model adds later is *why* it broke and what to change. What it must never
 * add is the location, because that is observable.
 */

export interface StackFrame {
  functionName: string | null;
  file: string;
  line: number | null;
  column: number | null;
  /** Frames inside dependencies, which usually indicate an upstream fault. */
  isDependency: boolean;
}

export interface ErrorCluster {
  /** Normalised message, with variable parts masked, used as the grouping key. */
  signature: string;
  /** One representative raw message. */
  sample: string;
  errorType: string | null;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  frames: StackFrame[];
  /** First frame in application code. The place to start looking. */
  topApplicationFrame: StackFrame | null;
  /** True when every frame sits inside dependencies. */
  entirelyInDependencies: boolean;
  affectedRoutes: string[];
}

const DEPENDENCY_MARKERS = ['node_modules/', 'site-packages/', 'vendor/', '/usr/lib/', 'node:internal'];

/** Parse a V8-style stack trace into frames. */
export function parseStackTrace(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];

  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;

    // Two shapes: "at fn (/path/file.ts:12:5)" and "at /path/file.ts:12:5".
    const withFn = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line);
    const bare = /^at\s+(.+?):(\d+):(\d+)$/.exec(line);

    const parts = withFn
      ? { functionName: withFn[1]!, file: withFn[2]!, line: Number(withFn[3]), column: Number(withFn[4]) }
      : bare
        ? { functionName: null, file: bare[1]!, line: Number(bare[2]), column: Number(bare[3]) }
        : null;
    if (!parts) continue;
    const { functionName, file, line: lineNo, column } = parts;

    frames.push({
      functionName,
      file,
      line: lineNo,
      column,
      isDependency: DEPENDENCY_MARKERS.some((m) => file.includes(m)),
    });
  }

  return frames;
}

/**
 * Normalise an error message so instances of the same failure group together.
 *
 * Masks the parts that vary per occurrence — ids, numbers, quoted values, paths —
 * because otherwise a thousand identical failures look like a thousand problems.
 */
export function errorSignature(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/"[^"]*"/g, '"<value>"')
    .replace(/\/[\w./-]+\.(ts|js|tsx|jsx|py|go|rb)\b/g, '<path>')
    .replace(/\b\d+\b/g, '<n>')
    .trim();
}

/** Extract the error type from a message like "TypeError: ...". */
export function errorType(message: string): string | null {
  return /^([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/.exec(message)?.[1] ?? null;
}

/**
 * Common container working directories.
 *
 * Listed explicitly rather than matched by a pattern, because `app` is ambiguous:
 * it is both a container root (`/app/src/...`) and a legitimate source directory
 * (`app/routes/...`), and a lookahead cannot tell those apart.
 */
const CONTAINER_ROOTS = [
  '/app/',
  '/var/task/',
  '/usr/src/app/',
  '/home/node/app/',
  '/workspace/',
  '/srv/app/',
  // Render puts the checkout of the repository here, so a frame reads
  // /opt/render/project/src/<repo path>. Observed on a real deployment.
  '/opt/render/project/src/',
];

/**
 * Strip a repository-relative path out of an absolute runtime path.
 *
 * Node emits `file://` URLs in stack frames for ES modules, so the scheme is
 * removed before the container root is matched. Without that the whole path falls
 * through unchanged and every downstream file read misses — which looks like "the
 * file does not exist at this revision" rather than "we failed to parse the frame".
 */
export function toRepositoryPath(file: string): string {
  let path = file;
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      path = path.slice('file://'.length);
    }
  }
  for (const root of CONTAINER_ROOTS) {
    if (path.startsWith(root)) return path.slice(root.length);
  }
  return path.replace(/^\/+/, '');
}

/**
 * Group error logs into distinct failures.
 *
 * Returned in descending count order: the loudest failure is usually, though not
 * always, the one to look at first — which is why the others are kept rather than
 * discarded.
 */
export function clusterErrors(logs: readonly LogEntry[]): ErrorCluster[] {
  const clusters = new Map<string, ErrorCluster>();

  for (const log of logs) {
    if (log.level !== 'error' && log.level !== 'fatal') continue;
    // An error-level entry carrying neither a message nor a stack describes no
    // failure. Observed on a real service whose access log was mislabelled: those
    // lines are emitted once per request, so they outnumbered the genuine errors
    // and became the top cluster — reporting "Error ×80, no application frame" for
    // an incident that had a clear TypeError and a located frame. Clustering must
    // not depend on every producer labelling its logs correctly.
    if (log.message.trim() === '' && !log.stackTrace) continue;

    const signature = errorSignature(log.message);
    const existing = clusters.get(signature);

    if (existing) {
      existing.count++;
      if (log.at < existing.firstSeen) existing.firstSeen = log.at;
      if (log.at > existing.lastSeen) existing.lastSeen = log.at;
      const route = routeOf(log);
      if (route && !existing.affectedRoutes.includes(route)) existing.affectedRoutes.push(route);
      continue;
    }

    const frames = log.stackTrace ? parseStackTrace(log.stackTrace) : [];
    const applicationFrames = frames.filter((f) => !f.isDependency);
    const route = routeOf(log);

    clusters.set(signature, {
      signature,
      sample: log.message,
      errorType: errorTypeOf(log),
      count: 1,
      firstSeen: log.at,
      lastSeen: log.at,
      frames,
      topApplicationFrame: applicationFrames[0] ?? null,
      // Only meaningful when there are frames at all; no trace is not evidence
      // of an upstream fault.
      entirelyInDependencies: frames.length > 0 && applicationFrames.length === 0,
      affectedRoutes: route ? [route] : [],
    });
  }

  return [...clusters.values()].sort((a, b) => b.count - a.count);
}

/**
 * The route a failure happened on.
 *
 * `http.route` is the OpenTelemetry convention, but plenty of services log a plain
 * `route` or `path`, and one observed on a real deployment used `route`. Reporting
 * "unknown route" when the log plainly carries one is a small lie that shows up in
 * every message the incident produces.
 */
const ROUTE_KEYS = ['http.route', 'route', 'http.path', 'path', 'url.path'];

function routeOf(log: LogEntry): string | null {
  for (const key of ROUTE_KEYS) {
    const value = log.attributes[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * The error type, from the message or from a field carrying it separately.
 *
 * A service that logs structured JSON usually splits the type out (`error:
 * "TypeError"`) rather than prefixing the message with it, so parsing the message
 * alone reports no type for a log that states it explicitly.
 */
const ERROR_TYPE_KEYS = ['error', 'error.kind', 'error.type', 'exception.type'];

function errorTypeOf(log: LogEntry): string | null {
  const fromMessage = errorType(log.message);
  if (fromMessage) return fromMessage;
  for (const key of ERROR_TYPE_KEYS) {
    const value = log.attributes[key];
    if (typeof value === 'string' && /^[A-Z][A-Za-z0-9_]*$/.test(value)) return value;
  }
  return null;
}

/**
 * Was this failure anticipated?
 *
 * The trigger for an incident is a break we did not prepare for. A failure whose
 * signature matches a documented known failure mode is still real, but it is a known
 * one — it should be handled by its runbook rather than investigated from scratch.
 *
 * Matching is deliberately conservative: a known mode must be named specifically
 * enough to appear in the error text, so a vague runbook cannot suppress a novel
 * failure by accident.
 */
export interface KnownFailureMode {
  /** Distinctive text that appears in the error, e.g. "PaymentGatewayError". */
  marker: string;
  description: string;
  source: string;
}

export interface NoveltyVerdict {
  novel: boolean;
  matched: KnownFailureMode | null;
  reason: string;
}

export function assessNovelty(
  cluster: ErrorCluster,
  known: readonly KnownFailureMode[],
): NoveltyVerdict {
  const haystack = `${cluster.sample} ${cluster.frames.map((f) => f.file).join(' ')}`.toLowerCase();

  for (const mode of known) {
    const marker = mode.marker.trim();
    // Too short a marker would match almost anything.
    if (marker.length < 4) continue;
    if (haystack.includes(marker.toLowerCase())) {
      return {
        novel: false,
        matched: mode,
        reason: `Matches a documented failure mode ("${marker}") from ${mode.source}.`,
      };
    }
  }

  return {
    novel: true,
    matched: null,
    reason: 'No documented failure mode matches this error signature.',
  };
}

/**
 * The first few sentences of a long passage.
 *
 * Slack is a notification surface, not a report: a wall of model prose in a busy
 * incident channel is skimmed past, and the detail it contains is then effectively
 * lost. The full reasoning belongs in the pull request, where a reviewer is already
 * reading carefully. Truncation is marked, never silent — a reader must be able to
 * tell they are seeing part of something.
 */
export function firstSentences(text: string, count: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const sentences = trimmed.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!sentences || sentences.length <= count) return trimmed;
  return `${sentences.slice(0, count).join('').trim()} …`;
}
