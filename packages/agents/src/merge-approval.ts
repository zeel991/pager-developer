import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { assertToolAllowed, type AutonomyLevel, type ToolDefinition } from '@pager/core';

/**
 * Merging, as an approved human action.
 *
 * Everything else this system does stops short of production. This is the one act
 * that changes what will run, and the design principle does not bend for it: the
 * agent still never decides to merge. A person decides, in Slack, and the agent
 * executes the decision they recorded.
 *
 * That distinction is only worth anything if the decision is genuinely theirs, so
 * the request carrying it is verified before it is believed:
 *
 *  - Every interaction is signed by Slack with a shared secret, and the signature is
 *    checked with a constant-time comparison before the payload is even parsed. An
 *    unverified endpoint that merges pull requests is not a feature, it is a way for
 *    anyone who learns the URL to ship code.
 *  - Signatures older than five minutes are refused, so a captured request cannot be
 *    replayed later.
 *  - The approval authorises one pull request in one repository. It is not a standing
 *    grant, and an approval for #4 cannot merge #5.
 */

export const MERGE_TOOL: ToolDefinition = {
  name: 'github.mergePullRequest',
  description: 'Merge a reviewed pull request. Changes what runs in production.',
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  risk: 'PRODUCTION_WRITE',
  // L4 is "execute human-approved remediation". Below it, merging is refused even
  // with an approval in hand, because the operator has not granted execution at all.
  minAutonomy: 'L4',
  requiresApproval: true,
  timeoutMs: 30_000,
  maxRetries: 0,
  audit: true,
};

/** Slack rejects its own signatures older than this, and so do we. */
const MAX_SIGNATURE_AGE_SECONDS = 300;

export class SlackSignatureError extends Error {
  constructor(reason: string) {
    super(`Refusing a Slack interaction: ${reason}`);
    this.name = 'SlackSignatureError';
  }
}

/**
 * Verify that a request really came from Slack.
 *
 * Returns rather than throws on the happy path so a caller cannot accidentally treat
 * a thrown-and-caught error as success. Every failure mode is named, because "invalid
 * signature" on its own is unhelpful when the real problem is a missing secret.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  now?: Date;
}): void {
  if (!input.signingSecret) throw new SlackSignatureError('no signing secret is configured');
  if (!input.signature) throw new SlackSignatureError('the request carried no X-Slack-Signature');
  if (!input.timestamp) throw new SlackSignatureError('the request carried no X-Slack-Request-Timestamp');

  const age = Math.abs(Math.floor((input.now ?? new Date()).getTime() / 1000) - Number(input.timestamp));
  if (!Number.isFinite(age)) throw new SlackSignatureError('the timestamp is not a number');
  if (age > MAX_SIGNATURE_AGE_SECONDS) {
    // Replay protection. A signature stays valid forever without this, so a captured
    // request could merge something days later.
    throw new SlackSignatureError(`the signature is ${age}s old, older than the ${MAX_SIGNATURE_AGE_SECONDS}s limit`);
  }

  const expected =
    'v0=' +
    createHmac('sha256', input.signingSecret)
      .update(`v0:${input.timestamp}:${input.rawBody}`)
      .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(input.signature, 'utf8');
  // Length must be compared first: timingSafeEqual throws on a mismatch, which would
  // itself leak length through the error path.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SlackSignatureError('the signature does not match');
  }
}

/** What a merge button carries. Narrow on purpose: one pull request, one repo. */
export const MergeAction = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name'),
  pullRequest: z.number().int().positive(),
  incidentKey: z.string().min(1),
});
export type MergeAction = z.infer<typeof MergeAction>;

/** The value carried in the Slack button, and read back from the interaction. */
export function encodeMergeAction(action: MergeAction): string {
  return JSON.stringify(action);
}

export function decodeMergeAction(value: unknown): MergeAction {
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return MergeAction.parse(raw);
}

export interface SlackInteraction {
  type: string;
  user?: { id?: string; name?: string; username?: string };
  actions?: { action_id?: string; value?: string }[];
  response_url?: string;
  message?: { ts?: string };
  channel?: { id?: string };
}

export const MERGE_ACTION_ID = 'pager_merge_pull_request';

/**
 * Slack Block Kit for the fix-ready message.
 *
 * The button says what it does and the surrounding text says what has and has not
 * been established, so nobody clicks it believing more has been verified than was.
 * A confirmation dialog is attached: merging is the one irreversible thing in this
 * flow, and a misclick in a busy incident channel should not ship code.
 */
export function mergeButtonBlocks(input: {
  headline: string;
  summary: string;
  pullRequestUrl: string;
  action: MergeAction;
}): unknown[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${input.headline}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: input.summary } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: MERGE_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: `Merge #${input.action.pullRequest}`, emoji: false },
          value: encodeMergeAction(input.action),
          confirm: {
            title: { type: 'plain_text', text: `Merge #${input.action.pullRequest}?` },
            text: {
              type: 'mrkdwn',
              text:
                `This ships the change to *${input.action.repository}* and it is the only ` +
                `production-affecting action in this incident. Pager Developer did not decide ` +
                `to merge — you are deciding, and the decision is recorded against your name.`,
            },
            confirm: { type: 'plain_text', text: 'Merge it' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        {
          type: 'button',
          action_id: 'pager_open_pull_request',
          text: { type: 'plain_text', text: 'Review on GitHub', emoji: false },
          url: input.pullRequestUrl,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            'The operator set this deployment to L4, which permits merging; your click ' +
            'is the approval, recorded against you. Pager Developer cannot merge on its ' +
            'own at any level.',
        },
      ],
    },
  ];
}

/** Guard the merge at the moment it happens, not once at startup. */
export function assertMergeAllowed(autonomy: AutonomyLevel, approvalId: string | undefined): void {
  assertToolAllowed(MERGE_TOOL, { autonomy, ...(approvalId ? { approvalId } : {}) });
}
