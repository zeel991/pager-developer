import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JiraProvider,
  JiraStateError,
  LinearApiError,
  LinearProvider,
  NotionProvider,
  type IssueTrackerProvider,
} from '@pager/providers';
import { LocalTwinServer } from '../src/server.js';
import { seedFromFixture } from '../src/seed.js';
import { INC_001 } from '../src/fixtures/index.js';

let server: LocalTwinServer;
let endpoints: Awaited<ReturnType<LocalTwinServer['start']>>;

beforeEach(async () => {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(INC_001));
  endpoints = await server.start();
});
afterEach(async () => {
  await server.stop();
});

const jira = () => new JiraProvider({ baseUrl: endpoints.jira, projectKey: 'INC', siteUrl: 'https://acme.atlassian.net' });
const linear = () => new LinearProvider({ baseUrl: endpoints.linear, teamId: 'team_eng', apiKey: 'lin_api_test' });
const notion = () => new NotionProvider({ baseUrl: endpoints.notion, token: 'secret_test', parentPageId: 'runbook-checkout' });

/**
 * Both trackers must satisfy the same interface, so the lifecycle is asserted once
 * against each rather than written twice with different expectations.
 */
describe.each([
  ['Jira', () => jira() as IssueTrackerProvider],
  ['Linear', () => linear() as IssueTrackerProvider],
])('%s issue tracker', (name, make) => {
  it('creates an incident issue and reads it back', async () => {
    const tracker = make();
    const ref = await tracker.createIssue({
      title: 'INC-184 checkout-api error rate 0.4% -> 17.8%',
      description: 'Production regression detected after deployment.\n\nUnder investigation.',
      priority: 'urgent',
    });
    expect(ref.key).toBeTruthy();
    expect(ref.url).toMatch(/^https?:\/\//);

    const issue = await tracker.getIssue(ref.id);
    expect(issue).not.toBeNull();
    expect(issue!.title).toContain('checkout-api');
    expect(issue!.description).toContain('Under investigation');
    expect(issue!.state).toBe('open');
  });

  it('returns null for an issue that does not exist', async () => {
    expect(await make().getIssue('does-not-exist')).toBeNull();
  });

  it('appends incident updates as comments rather than rewriting the description', async () => {
    const tracker = make();
    const ref = await tracker.createIssue({ title: 't', description: 'original' });

    await tracker.addComment(ref.id, 'Root cause suspected in CheckoutService.createOrder.');
    await tracker.addComment(ref.id, 'Failure reproduced.');

    const comments = await tracker.listComments(ref.id);
    expect(comments.map((c) => c.body)).toEqual([
      'Root cause suspected in CheckoutService.createOrder.',
      'Failure reproduced.',
    ]);
    expect((await tracker.getIssue(ref.id))!.description).toBe('original');
  });

  it('walks an incident through its states', async () => {
    const tracker = make();
    const ref = await tracker.createIssue({ title: 't', description: 'd' });

    await tracker.updateIssue(ref.id, { state: 'in_progress' });
    expect((await tracker.getIssue(ref.id))!.state).toBe('in_progress');

    await tracker.updateIssue(ref.id, { state: 'resolved' });
    expect((await tracker.getIssue(ref.id))!.state).toBe('resolved');
  });

  it('updates the title without disturbing the state', async () => {
    const tracker = make();
    const ref = await tracker.createIssue({ title: 'old', description: 'd' });
    await tracker.updateIssue(ref.id, { state: 'in_progress' });
    await tracker.updateIssue(ref.id, { title: 'new' });

    const issue = await tracker.getIssue(ref.id);
    expect(issue!.title).toBe('new');
    expect(issue!.state).toBe('in_progress');
  });
});

describe('Jira specifics', () => {
  it('round-trips multi-paragraph text through Atlassian Document Format', async () => {
    const tracker = jira();
    const description = 'Error rate rose sharply.\n\nDeployment attribution is under investigation.';
    const ref = await tracker.createIssue({ title: 't', description });
    expect((await tracker.getIssue(ref.id))!.description).toBe(description);
  });

  it('fails loudly when the workflow offers no transition to the target state', async () => {
    // The twin's workflow allows no direct To Do -> Resolved transition, exactly as
    // a constrained real workflow would. Reporting success here would leave an
    // incident believing it was resolved while the tracker still said open.
    const tracker = jira();
    const ref = await tracker.createIssue({ title: 't', description: 'd' });
    await expect(tracker.updateIssue(ref.id, { state: 'resolved' })).rejects.toThrow(JiraStateError);
    await expect(tracker.updateIssue(ref.id, { state: 'resolved' })).rejects.toThrow(/Available from its current status/);
  });

  it('reaches blocked through a legal transition path', async () => {
    const tracker = jira();
    const ref = await tracker.createIssue({ title: 't', description: 'd' });
    await tracker.updateIssue(ref.id, { state: 'in_progress' });
    await tracker.updateIssue(ref.id, { state: 'blocked' });
    expect((await tracker.getIssue(ref.id))!.state).toBe('blocked');
  });
});

describe('Linear specifics', () => {
  it('treats a GraphQL errors array as a failure despite HTTP 200', async () => {
    const tracker = linear();
    await expect(tracker.addComment('no-such-issue', 'hi')).rejects.toThrow(LinearApiError);
    await expect(tracker.addComment('no-such-issue', 'hi')).rejects.toThrow(/Entity not found/);
  });

  it('resolves a workflow state id for the team rather than guessing', async () => {
    const tracker = linear();
    const ref = await tracker.createIssue({ title: 't', description: 'd' });
    await tracker.updateIssue(ref.id, { state: 'blocked' });
    // 'Blocked' is a started-type state, distinct from 'In Progress'.
    expect((await tracker.getIssue(ref.id))!.state).toBe('blocked');
  });

  it('maps a canceled state to closed rather than resolved', async () => {
    const tracker = linear();
    const ref = await tracker.createIssue({ title: 't', description: 'd' });
    await tracker.updateIssue(ref.id, { state: 'closed' });
    expect((await tracker.getIssue(ref.id))!.state).toBe('closed');
  });

  it('rejects a create with no title', async () => {
    await expect(linear().createIssue({ title: '', description: 'd' })).rejects.toThrow(/title is required/);
  });
});

describe('Notion knowledge provider', () => {
  it('finds the runbook by content, not just title', async () => {
    const results = await notion().search('rollback');
    expect(results.map((r) => r.title)).toContain('Runbook: checkout-api');
  });

  it('reads a full page across pagination boundaries', async () => {
    // The twin pages children two at a time, so a runbook read that ignored
    // pagination would silently truncate.
    const doc = await notion().getDocument('runbook-checkout');
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('Runbook: checkout-api');
    expect(doc!.content).toContain('# Runbook: checkout-api');
    expect(doc!.content).toContain('Escalation');
    expect(doc!.content).toContain('Do not modify the production database');
  });

  it('finds the title property by type, since database pages name it arbitrarily', async () => {
    // The twin exposes the title under "Name", not "title".
    expect((await notion().getDocument('doc-checkout-arch'))!.title).toBe('checkout-api architecture');
  });

  it('returns null for a missing document', async () => {
    expect(await notion().getDocument('nope')).toBeNull();
  });

  it('writes a postmortem and reads it back', async () => {
    const n = notion();
    const created = await n.createDocument({
      title: 'Postmortem: INC-184',
      content: '# Postmortem: INC-184\n\nRoot cause: discountCode widened to optional.\n\nFix: PR #378.',
    });
    expect(created.id).toBeTruthy();

    const read = await n.getDocument(created.id);
    expect(read!.title).toBe('Postmortem: INC-184');
    expect(read!.content).toContain('discountCode widened to optional');
  });

  it('refuses to create an orphan page rather than failing at the API', async () => {
    const n = new NotionProvider({ baseUrl: endpoints.notion, token: 't' });
    await expect(n.createDocument({ title: 't', content: 'c' })).rejects.toThrow(/needs a parent/);
  });

  it('requires the Notion-Version header', async () => {
    // Omitting it is a runtime-only failure against the real API, so the twin
    // enforces it to keep that mistake catchable in tests.
    const res = await fetch(`${endpoints.notion}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('restores seeded pages and issues on reset', async () => {
    await jira().createIssue({ title: 't', description: 'd' });
    await notion().createDocument({ title: 'p', content: 'c' });
    expect(server.current.issues).toHaveLength(1);
    expect(server.current.pages).toHaveLength(3);

    server.reset();
    expect(server.current.issues).toHaveLength(0);
    expect(server.current.pages).toHaveLength(2);
  });
});
