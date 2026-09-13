/**
 * Preflight: verify that the external dependencies this system requires are actually
 * reachable, and report precisely which are not.
 *
 * Run this before anything else. It answers, with evidence rather than assumption:
 *   - is the Arga API key valid, and which twins does this account actually offer?
 *   - is a Datadog twin available, or must observability fall back?
 *   - is Lemma configured, and does an ingest actually land?
 *   - is a reasoning model key present?
 *
 * It deliberately reports failures as failures rather than degrading quietly.
 */

import { Arga } from 'arga-sdk';
import { Lemma } from '@uselemma/tracing';

const REQUIRED_TWINS = ['github', 'datadog', 'slack'];

type Check = { name: string; ok: boolean; detail: string };

const results: Check[] = [];

function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(28)} ${detail}`);
}

async function checkArga(): Promise<void> {
  const apiKey = process.env.ARGA_API_KEY;
  if (!apiKey) {
    report('arga.credentials', false, 'ARGA_API_KEY is not set in the environment');
    return;
  }

  const client = new Arga({ apiKey });
  let available: Set<string>;
  try {
    const twins = await client.twins.list();
    available = new Set(twins.map((t) => t.name));
    report('arga.auth', true, `authenticated; ${twins.length} twins offered`);
  } catch (err) {
    report('arga.auth', false, `twins.list() failed: ${message(err)}`);
    return;
  }

  for (const name of REQUIRED_TWINS) {
    const present = available.has(name);
    report(
      `arga.twin.${name}`,
      present,
      present ? 'available' : `NOT offered by this account; offered: ${[...available].sort().join(', ')}`,
    );
  }
}

async function checkLemma(): Promise<void> {
  const { LEMMA_API_KEY, LEMMA_PROJECT_ID } = process.env;
  if (!LEMMA_API_KEY || !LEMMA_PROJECT_ID) {
    report('lemma.credentials', false, 'LEMMA_API_KEY and/or LEMMA_PROJECT_ID are not set');
    return;
  }

  const lemma = new Lemma({
    apiKey: LEMMA_API_KEY,
    projectId: LEMMA_PROJECT_ID,
    ...(process.env.LEMMA_RELEASE ? { release: process.env.LEMMA_RELEASE } : {}),
  });

  try {
    // Send a real trace rather than merely constructing a client: a key that parses
    // but cannot ingest is not a working integration.
    await lemma.trace({ name: 'pager.preflight', input: { check: true } }, async (t) => {
      t.recordTool({ name: 'preflight.noop', input: {}, output: { ok: true }, status: 'OK' });
      return 'ok';
    });
    report('lemma.ingest', true, 'trace accepted');
  } catch (err) {
    report('lemma.ingest', false, `trace ingest failed: ${message(err)}`);
  }
}

function checkModel(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  report(
    'model.credentials',
    Boolean(key),
    key ? `ANTHROPIC_API_KEY present; model ${process.env.PAGER_MODEL ?? 'claude-opus-5'}` : 'ANTHROPIC_API_KEY is not set',
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  console.log('\nPager Developer — preflight\n');
  await checkArga();
  await checkLemma();
  checkModel();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.` +
      (failed.length ? ` Blocked on: ${failed.map((f) => f.name).join(', ')}\n` : '\n'),
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

void main();
