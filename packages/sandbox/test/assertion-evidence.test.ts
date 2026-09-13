import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReproductionAgent } from '../src/reproduction.js';
import { ValidationEngine } from '../src/validation.js';
import { singleTestCommand, type RepositoryProfile } from '../src/repository-profile.js';
import type { SourceControlProvider } from '@pager/providers';
import { Sandbox } from '../src/sandbox.js';

/**
 * What is allowed to count as "the bug reproduced".
 *
 * A non-zero exit code is the weakest possible evidence: a typo in the test, a
 * missing import, a runner that could not start, and an unrelated test that was
 * already red all produce one. Each case below is a way the system could have
 * claimed a reproduction it never had.
 */

/** A source control provider serving a fixed set of files, for sandbox creation. */
function provider(files: Record<string, string>): SourceControlProvider {
  return {
    kind: 'source-control',
    async listFiles() { return Object.keys(files); },
    async getFile(_r, _ref, path) { return files[path] ?? null; },
  } as unknown as SourceControlProvider;
}

const WORKING_MODULE = `export function total(items) {
  return items.reduce((s, i) => s + i, 0);
}
`;

const BROKEN_MODULE = `export function total(items) {
  // The bug: crashes when given nothing, instead of returning zero.
  return items.reduce((s, i) => s + i);
}
`;

const REAL_TEST = `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/total.js';
it('totals an empty basket as zero', () => {
  assert.equal(total([]), 0);
});
`;

async function build(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'pager-assert-'));
  const sandbox = await Sandbox.create(provider(files), 'acme/demo', 'rev-1', { rootDir: root });
  const validation = new ValidationEngine(sandbox);
  return {
    sandbox,
    validation,
    reproduction: new ReproductionAgent(sandbox, validation),
    async dispose() {
      await sandbox.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const BASE_FILES = {
  'package.json': JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }),
  'src/total.js': BROKEN_MODULE,
};

describe('reproduction evidence', () => {
  it('accepts a real failing assertion as a reproduction', async () => {
    const h = await build(BASE_FILES);
    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: REAL_TEST,
      command: 'node --test test/regression.test.js',
      expectedFailureMarkers: ['Reduce of empty array'],
    });

    expect(attempt.failureReason).toBeNull();
    expect(attempt.assertionEvidence.assertionFailed).toBe(true);
    expect(attempt.assertionEvidence.foundMarkers).toContain('Reduce of empty array');
    expect(attempt.assertionEvidence.problems).toEqual([]);
    await h.dispose();
  });

  it('refuses a syntax error as a reproduction', async () => {
    const h = await build(BASE_FILES);
    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: `import { it } from 'node:test'\nit('x', () => { this is not javascript })\n`,
      command: 'node --test test/regression.test.js',
    });

    expect(attempt.failureReason).toMatch(/failed to load|SyntaxError/i);
    expect(attempt.assertionEvidence.problems.join(' ')).toMatch(/SyntaxError/);
    await h.dispose();
  });

  it('refuses a missing dependency as a reproduction', async () => {
    const h = await build(BASE_FILES);
    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: `import { it } from 'node:test';\nimport { thing } from 'a-package-that-does-not-exist';\nit('x', () => thing());\n`,
      command: 'node --test test/regression.test.js',
    });

    expect(attempt.failureReason).toMatch(/not a demonstrated reproduction/);
    expect(attempt.assertionEvidence.problems.join(' ')).toMatch(/Cannot find|MODULE_NOT_FOUND/i);
    await h.dispose();
  });

  it('refuses a command that could not be executed', async () => {
    const h = await build(BASE_FILES);
    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: REAL_TEST,
      command: 'definitely-not-a-real-binary --test',
    });

    expect(attempt.failureReason).toMatch(/could not be executed \(exit 127\)/);
    expect(attempt.assertionEvidence.commandExecuted).toBe(false);
    await h.dispose();
  });

  it('refuses a reproduction when the expected failure never appeared', async () => {
    const h = await build(BASE_FILES);
    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: REAL_TEST,
      command: 'node --test test/regression.test.js',
      // The real failure is a reduce error, not a null dereference.
      expectedFailureMarkers: ["Cannot read properties of null (reading 'percentOff')"],
    });

    expect(attempt.failureReason).toMatch(/none of the expected failure markers/);
    expect(attempt.assertionEvidence.foundMarkers).toEqual([]);
    await h.dispose();
  });

  it('refuses to credit a new assertion when the suite was already failing', async () => {
    const h = await build({
      ...BASE_FILES,
      'test/existing.test.js': `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('was already broken', () => assert.equal(1, 2));\n`,
    });

    const baseline = await h.validation.runCheck('test', 'node --test');
    expect(baseline.passed).toBe(false);

    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: REAL_TEST,
      command: 'node --test',
      baseline,
    });

    expect(attempt.failureReason).toMatch(/already failed/);
    expect(attempt.assertionEvidence.preexistingFailure).toBe(true);
    await h.dispose();
  });

  it('still refuses a test that passes against the unpatched code', async () => {
    const h = await build({ ...BASE_FILES, 'src/total.js': WORKING_MODULE });
    const attempt = await h.reproduction.demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: REAL_TEST,
      command: 'node --test test/regression.test.js',
    });

    expect(attempt.failureReason).toMatch(/passed against the unpatched code/);
    await h.dispose();
  });
});

describe('singleTestCommand', () => {
  const profile = (scripts: Record<string, string>, testCommand: string | null): RepositoryProfile => ({
    language: 'javascript', packageManager: 'npm', testCommand, buildCommand: null,
    lintCommand: null, typecheckCommand: null, entryPoint: null, hasDockerfile: false,
    hasCi: false, scripts, gaps: [],
  });

  it('targets a single file for node --test', () => {
    expect(singleTestCommand(profile({ test: 'node --test' }, 'npm run test'), 'test/a.test.js'))
      .toBe('node --test test/a.test.js');
  });

  it('targets a single file for vitest, adding run when absent', () => {
    expect(singleTestCommand(profile({ test: 'vitest' }, 'npm run test'), 'test/a.test.ts'))
      .toBe('vitest run test/a.test.ts');
  });

  it('returns null for a runner it cannot target, rather than guessing', () => {
    // The caller must then record that the reproduction was not isolated.
    expect(singleTestCommand(profile({ test: 'make check' }, 'npm run test'), 'test/a.test.js')).toBeNull();
  });
});
