import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  MERGE_TOOL,
  SlackSignatureError,
  assertMergeAllowed,
  decodeMergeAction,
  mergeButtonBlocks,
  verifySlackSignature,
} from '../src/merge-approval.js';
import { PermissionDeniedError, validateToolDefinition } from '@pager/core';

/**
 * The merge gate.
 *
 * This is the only action in the system that changes what runs in production, so
 * every way it could be reached without a real human decision is tested here rather
 * than reasoned about. A failure in this file is a way for someone who learns a URL
 * to ship code.
 */

const SECRET = 'test-signing-secret';
const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';

function sign(body: string, timestamp: string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

const now = new Date('2026-09-14T00:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));

describe('Slack signature verification', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(() =>
      verifySlackSignature({ signingSecret: SECRET, signature: sign(BODY, ts), timestamp: ts, rawBody: BODY, now }),
    ).not.toThrow();
  });

  it('refuses a request signed with the wrong secret', () => {
    expect(() =>
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(BODY, ts, 'an-attackers-secret'),
        timestamp: ts,
        rawBody: BODY,
        now,
      }),
    ).toThrow(SlackSignatureError);
  });

  it('refuses a request whose body was altered after signing', () => {
    // The exact attack that matters: a valid signature lifted onto a payload that
    // names a different pull request.
    expect(() =>
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(BODY, ts),
        timestamp: ts,
        rawBody: BODY + '&tampered=1',
        now,
      }),
    ).toThrow(SlackSignatureError);
  });

  it('refuses a replayed request older than five minutes', () => {
    const old = String(Math.floor(now.getTime() / 1000) - 600);
    expect(() =>
      verifySlackSignature({ signingSecret: SECRET, signature: sign(BODY, old), timestamp: old, rawBody: BODY, now }),
    ).toThrow(/older than/);
  });

  it('refuses a request from the future beyond the window', () => {
    const future = String(Math.floor(now.getTime() / 1000) + 600);
    expect(() =>
      verifySlackSignature({ signingSecret: SECRET, signature: sign(BODY, future), timestamp: future, rawBody: BODY, now }),
    ).toThrow(SlackSignatureError);
  });

  it('refuses when no signing secret is configured, rather than accepting everything', () => {
    // The dangerous failure: an unconfigured deployment that merges on any request.
    expect(() =>
      verifySlackSignature({ signingSecret: '', signature: sign(BODY, ts), timestamp: ts, rawBody: BODY, now }),
    ).toThrow(/no signing secret/);
  });

  it('refuses a request carrying no signature at all', () => {
    expect(() =>
      verifySlackSignature({ signingSecret: SECRET, signature: undefined, timestamp: ts, rawBody: BODY, now }),
    ).toThrow(/no X-Slack-Signature/);
  });

  it('refuses a non-numeric timestamp rather than treating it as age zero', () => {
    expect(() =>
      verifySlackSignature({ signingSecret: SECRET, signature: sign(BODY, 'abc'), timestamp: 'abc', rawBody: BODY, now }),
    ).toThrow(SlackSignatureError);
  });
});

describe('merge permission', () => {
  it('is declared as a production write requiring approval', () => {
    expect(MERGE_TOOL.risk).toBe('PRODUCTION_WRITE');
    expect(MERGE_TOOL.requiresApproval).toBe(true);
    expect(MERGE_TOOL.audit).toBe(true);
    // The structural invariants the policy engine enforces on any registered tool.
    expect(() => validateToolDefinition(MERGE_TOOL)).not.toThrow();
  });

  it('refuses to merge at L3, even with an approval in hand', () => {
    // An approval satisfies the approval requirement; it never raises autonomy. L3
    // means the operator has not granted execution rights at all.
    expect(() => assertMergeAllowed('L3', 'approval-1')).toThrow(PermissionDeniedError);
  });

  it('refuses to merge at L4 without an approval', () => {
    expect(() => assertMergeAllowed('L4', undefined)).toThrow(PermissionDeniedError);
  });

  it('allows a merge at L4 with a recorded approval', () => {
    expect(() => assertMergeAllowed('L4', 'approval-1')).not.toThrow();
  });
});

describe('merge action payload', () => {
  it('round-trips a well-formed action', () => {
    const action = { repository: 'he11world/test', pullRequest: 4, incidentKey: 'INC-BE5404871B81' };
    const blocks = mergeButtonBlocks({
      headline: 'Fix ready', summary: 'reproduced and verified',
      pullRequestUrl: 'https://github.com/he11world/test/pull/4', action,
    }) as { type: string; elements?: { value?: string; action_id?: string }[] }[];
    const button = blocks.find((b) => b.type === 'actions')!.elements!.find((e) => e.action_id === 'pager_merge_pull_request')!;
    expect(decodeMergeAction(button.value)).toEqual(action);
  });

  it('refuses an action naming something that is not a repository', () => {
    expect(() => decodeMergeAction('{"repository":"../../etc","pullRequest":1,"incidentKey":"X"}')).toThrow();
  });

  it('refuses an action with no pull request number', () => {
    expect(() => decodeMergeAction('{"repository":"a/b","incidentKey":"X"}')).toThrow();
  });

  it('puts a confirmation dialog on the merge button', () => {
    // Merging is the one irreversible step; a misclick in a busy channel must not
    // ship code.
    const blocks = mergeButtonBlocks({
      headline: 'h', summary: 's', pullRequestUrl: 'https://example.com',
      action: { repository: 'a/b', pullRequest: 1, incidentKey: 'X' },
    }) as { type: string; elements?: { action_id?: string; confirm?: unknown }[] }[];
    const button = blocks.find((b) => b.type === 'actions')!.elements!.find((e) => e.action_id === 'pager_merge_pull_request')!;
    expect(button.confirm).toBeDefined();
  });
});
