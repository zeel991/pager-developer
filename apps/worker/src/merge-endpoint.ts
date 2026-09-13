import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { SlackInteraction } from '@pager/agents';
import {
  MERGE_ACTION_ID,
  SlackSignatureError,
  assertMergeAllowed,
  decodeMergeAction,
  verifySlackSignature,
} from '@pager/agents';
import { PermissionDeniedError, type AutonomyLevel } from '@pager/core';
import type { SourceControlProvider } from '@pager/providers';

/**
 * The Slack interaction that merges a pull request.
 *
 * The agent never decides to merge. A person decides, in Slack, and this executes
 * the decision they recorded — which is only meaningful if the request carrying it
 * is really theirs, so nothing here trusts the payload until the signature checks
 * out.
 *
 * Order matters and is deliberate: verify, then parse, then authorise, then act.
 * Parsing before verifying would mean running a JSON decoder on unauthenticated
 * input; authorising before verifying would mean an attacker choosing the pull
 * request number.
 */

export interface MergeApproval {
  id: string;
  repository: string;
  pullRequest: number;
  incidentKey: string;
  approvedBy: string;
  decidedAt: string;
  outcome: string;
}

export interface MergeEndpointDeps {
  signingSecret: string;
  enabled: boolean;
  /** The operator's standing grant. Merging refuses below L4. */
  autonomy: AutonomyLevel;
  repository: string;
  sourceControl: SourceControlProvider;
  /** Recorded approvals, newest first. Shown on the dashboard. */
  approvals: MergeApproval[];
  log: (message: string) => void;
}

async function readBody(request: IncomingMessage, maxBytes = 256_000): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBytes) throw new Error('request body too large');
  }
  return body;
}

function reply(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ response_type: 'in_channel', replace_original: false, text }));
}

/**
 * Replace the message the button lived on.
 *
 * Once a pull request is merged the button is not merely useless, it is misleading:
 * it invites a click that can only fail, and it leaves the channel showing an
 * outstanding decision that was in fact taken. The outcome replaces the offer.
 */
function replaceMessage(response: ServerResponse, blocks: unknown[], fallback: string): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ replace_original: true, text: fallback, blocks }));
}

function outcomeBlocks(lines: string[]): unknown[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
}

export async function handleSlackInteraction(
  request: IncomingMessage,
  response: ServerResponse,
  deps: MergeEndpointDeps,
): Promise<void> {
  if (!deps.enabled) {
    // Refused rather than ignored: a 404 here would look like a misconfigured URL
    // when the truth is that this deployment deliberately does not offer merging.
    reply(response, 403, 'This Pager Developer deployment does not offer merging from Slack.');
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(request);
  } catch {
    reply(response, 413, 'Request body too large.');
    return;
  }

  // 1. Verify — before the payload is parsed, let alone believed.
  try {
    verifySlackSignature({
      signingSecret: deps.signingSecret,
      signature: request.headers['x-slack-signature'] as string | undefined,
      timestamp: request.headers['x-slack-request-timestamp'] as string | undefined,
      rawBody,
    });
  } catch (err) {
    const reason = err instanceof SlackSignatureError ? err.message : 'signature could not be verified';
    deps.log(`REFUSED a Slack interaction: ${reason}`);
    reply(response, 401, 'Could not verify that this request came from Slack.');
    return;
  }

  // 2. Parse.
  let interaction: SlackInteraction;
  try {
    const encoded = new URLSearchParams(rawBody).get('payload');
    if (!encoded) throw new Error('no payload field');
    interaction = JSON.parse(encoded) as SlackInteraction;
  } catch {
    reply(response, 400, 'Could not read the interaction payload.');
    return;
  }

  const action = (interaction.actions ?? []).find((a) => a.action_id === MERGE_ACTION_ID);
  if (!action) {
    // Another button on the same message, or a Slack event we do not handle.
    reply(response, 200, '');
    return;
  }

  let target;
  try {
    target = decodeMergeAction(action.value);
  } catch {
    reply(response, 400, 'That button carried an action this deployment does not recognise.');
    return;
  }

  // 3. The approval is scoped to exactly one pull request in one repository, and
  //    the repository is the one this worker watches — not one named by the payload.
  if (target.repository !== deps.repository) {
    deps.log(`REFUSED a merge for ${target.repository}: this worker watches ${deps.repository}`);
    reply(response, 403, `This worker does not watch ${target.repository}.`);
    return;
  }

  const approvedBy = interaction.user?.username ?? interaction.user?.name ?? interaction.user?.id ?? 'unknown';
  const approval: MergeApproval = {
    id: randomUUID(),
    repository: target.repository,
    pullRequest: target.pullRequest,
    incidentKey: target.incidentKey,
    approvedBy,
    decidedAt: new Date().toISOString(),
    outcome: 'approved',
  };

  // 4. Is the pull request still open? A message stays in the channel long after
  //    the decision it offered was taken, and clicking an old one must not be an
  //    error the person has to interpret — it means someone already decided.
  try {
    const current = await deps.sourceControl.getPullRequest(target.repository, target.pullRequest);
    if (current.state !== 'open') {
      approval.outcome = `no action: already ${current.state}`;
      deps.approvals.unshift(approval);
      replaceMessage(
        response,
        outcomeBlocks([
          `:white_check_mark: *#${target.pullRequest} is already ${current.state}.*`,
          `Nothing to do — someone decided this already.`,
        ]),
        `#${target.pullRequest} is already ${current.state}.`,
      );
      return;
    }
  } catch (err) {
    deps.log(`could not read #${target.pullRequest}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Authorise. The autonomy level is the operator's standing grant and the
  //    approval is this person's decision about this pull request; neither
  //    substitutes for the other, so both are required.
  try {
    assertMergeAllowed(deps.autonomy, approval.id);
  } catch (err) {
    approval.outcome = `refused: ${err instanceof PermissionDeniedError ? err.reason : 'not permitted'}`;
    deps.approvals.unshift(approval);
    reply(response, 403, `Refused: ${err instanceof Error ? err.message : 'not permitted'}`);
    return;
  }

  // 6. Act.
  try {
    const merged = await deps.sourceControl.mergePullRequest(target.repository, target.pullRequest, {
      method: 'squash',
      commitTitle: `${target.incidentKey}: merged by ${approvedBy} via Pager Developer`,
    });
    approval.outcome = merged.state === 'merged' ? 'merged' : `not merged (${merged.state})`;
    deps.approvals.unshift(approval);
    deps.log(`#${target.pullRequest} merged by ${approvedBy} — approval ${approval.id}`);
    // The button is gone: the offer has been taken, and leaving it would invite a
    // click that can only fail.
    replaceMessage(
      response,
      outcomeBlocks([
        `:white_check_mark: *#${target.pullRequest} merged by ${approvedBy}.*`,
        `Approval \`${approval.id}\` recorded against them. Pager Developer did not decide this.`,
        `<${merged.url}|View the pull request>`,
      ]),
      `#${target.pullRequest} merged by ${approvedBy}.`,
    );
  } catch (err) {
    // GitHub answers 405 when its own rules refuse the merge — conflicts, a failing
    // required check, branch protection. Surfaced as-is: that is a decision by the
    // repository, not a transient error to retry around.
    const message = err instanceof Error ? err.message : String(err);
    approval.outcome = `merge failed: ${message}`;
    deps.approvals.unshift(approval);
    deps.log(`merge of #${target.pullRequest} failed: ${message}`);
    reply(response, 200, `:x: Could not merge #${target.pullRequest}: ${message}`);
  }
}
