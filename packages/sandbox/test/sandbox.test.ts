import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubAppTokenSource,
  GitHubProvider,
  PAGER_APP_MANIFEST,
  registerViaManifest,
} from '@pager/providers';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { Sandbox, SandboxPathError, scrubEnvironment } from '../src/sandbox.js';
import { profileRepository } from '../src/repository-profile.js';
import { ValidationEngine, parseTestCounts, splitCommand } from '../src/validation.js';
import { ReproductionAgent, ReproductionError, describeReproduction } from '../src/reproduction.js';

let server: LocalTwinServer;
let github: GitHubProvider;
let sandbox: Sandbox | null = null;

beforeEach(async () => {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(INC_001));
  const endpoints = await server.start();
  const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
  const tokens = new GitHubAppTokenSource(endpoints.github, creds);
  github = new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() });
});

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = null;
  await server.stop();
});

async function headSha(): Promise<string> {
  const history = await github.listCommits('acme/checkout-api', { limit: 5 });
  return history[0]!.sha;
}

async function makeSandbox(): Promise<Sandbox> {
  sandbox = await Sandbox.create(github, 'acme/checkout-api', await headSha());
  return sandbox;
}

describe('Sandbox containment', () => {
  it('materialises the repository at an exact revision', async () => {
    const s = await makeSandbox();
    expect(await s.readFile('src/checkout/service.ts')).toContain('createOrder');
    expect(await s.readFile('package.json')).toContain('checkout-api');
    expect(await s.readFile('does/not/exist.ts')).toBeNull();
  });

  it('refuses to write outside the sandbox', async () => {
    const s = await makeSandbox();
    await expect(s.writeFile('../escaped.txt', 'x')).rejects.toThrow(SandboxPathError);
    await expect(s.writeFile('../../.ssh/config', 'x')).rejects.toThrow(SandboxPathError);
    await expect(s.readFile('/etc/passwd')).rejects.toThrow(SandboxPathError);
  });

  it('strips credentials from the command environment', () => {
    // Code written by a model runs in here. It must not be able to read the keys
    // this process holds.
    const scrubbed = scrubEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      ARGA_API_KEY: 'arga_sk_secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      GITHUB_TOKEN: 'ghs_secret',
      DATABASE_URL: 'postgres://user:pw@host/db',
      MY_SERVICE_SECRET: 'x',
      NODE_ENV: 'test',
    });
    expect(scrubbed).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', NODE_ENV: 'test' });
  });

  it('does not leak this process credentials into a child', async () => {
    const s = await makeSandbox();
    const result = await s.run('node', ['-e', 'console.log(JSON.stringify(process.env))']);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.ARGA_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('reports a missing binary as a failure, never as a pass', async () => {
    const s = await makeSandbox();
    const result = await s.run('definitely-not-a-real-binary', []);
    expect(result.exitCode).toBe(127);
  });

  it('kills a runaway command rather than hanging the incident', async () => {
    const s = await makeSandbox();
    const result = await s.run('node', ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 600 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('passes arguments without a shell, so metacharacters cannot inject', async () => {
    const s = await makeSandbox();
    const result = await s.run('node', ['-e', 'console.log(process.argv[1] ?? "none")', '; rm -rf /']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('; rm -rf /');
  });

  it('refuses to build a sandbox from an empty revision', async () => {
    const empty = { ...github, listFiles: async () => [] } as unknown as GitHubProvider;
    await expect(Sandbox.create(empty, 'acme/checkout-api', 'abc')).rejects.toThrow(/no files/);
  });
});

describe('repository profile', () => {
  it('reads the real commands out of the working copy', async () => {
    const s = await makeSandbox();
    const profile = await profileRepository(s);
    expect(profile.language).toBe('typescript');
    expect(profile.testCommand).toBe('npm run test');
    expect(profile.typecheckCommand).toBe('npm run typecheck');
  });

  it('records a gap when there is no test script, rather than inventing one', async () => {
    const s = await makeSandbox();
    await s.writeFile('package.json', JSON.stringify({ name: 'x', scripts: {} }));
    const profile = await profileRepository(s);
    expect(profile.testCommand).toBeNull();
    expect(profile.gaps.join(' ')).toMatch(/No test script found/);
  });
});

describe('validation', () => {
  it('parses node:test counts from both its reporters', () => {
    expect(parseTestCounts('ℹ pass 12\nℹ fail 0')).toEqual({ passed: 12, failed: 0 });
    expect(parseTestCounts('# pass 5\n# fail 2')).toEqual({ passed: 5, failed: 2 });
    expect(parseTestCounts('Tests  3 failed | 184 passed')).toEqual({ passed: 184, failed: 3 });
  });

  it('returns null counts for unrecognised output rather than zero', () => {
    // "0 tests failed" and "we could not tell" must not look the same.
    expect(parseTestCounts('something else entirely')).toEqual({ passed: null, failed: null });
  });

  it('splits a command into an executable and arguments', () => {
    expect(splitCommand('npm run test')).toEqual({ bin: 'npm', args: ['run', 'test'] });
  });

  it('actually executes the repository test suite', async () => {
    const s = await makeSandbox();
    const engine = new ValidationEngine(s);
    const run = await engine.runCheck('test', 'node --test');

    expect(run.skipped).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.passed).toBe(true);
    // The deployed code's own tests pass — which is exactly why the bug shipped.
    expect(run.testsPassed).toBe(2);
    expect(run.testsFailed).toBe(0);
  });

  it('marks a missing command as skipped, which is not passing', async () => {
    const s = await makeSandbox();
    const run = await new ValidationEngine(s).runCheck('lint', null);
    expect(run.skipped).toBe(true);
    expect(run.passed).toBe(false);
    expect(run.exitCode).toBeNull();
  });

  it('does not report an all-skipped suite as a pass', async () => {
    const s = await makeSandbox();
    const summary = await new ValidationEngine(s).runAll(
      { testCommand: null, lintCommand: null, typecheckCommand: null, buildCommand: null } as never,
    );
    expect(summary.allPassed).toBe(false);
    expect(summary.skipped).toHaveLength(4);
  });
});

describe('reproduction: FAIL before, PASS after', () => {
  // The regression test Pager must produce: it exercises the path the existing
  // suite never covers — a checkout with no discount code.
  const REGRESSION_TEST = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';

describe('CheckoutService regression INC-1', () => {
  it('creates an order when no discount code is supplied', () => {
    const order = new CheckoutService().createOrder({
      customerId: 'cus_9',
      items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }],
    });
    assert.equal(order.discountCents, 0);
    assert.equal(order.totalCents, 1000);
    assert.equal(order.appliedCode, null);
  });
});
`;

  // The patch: guard the optional field instead of dereferencing it.
  const PATCHED_SERVICE = `import type { OrderRequest } from './types.ts';

export interface Order {
  customerId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  appliedCode: string | null;
}

export class CheckoutService {
  createOrder(request: OrderRequest): Order {
    const subtotalCents = request.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );

    const code = request.discountCode ?? null;
    const discountCents = code ? Math.round(subtotalCents * (code.percentOff / 100)) : 0;

    return {
      customerId: request.customerId,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      appliedCode: code ? code.value : null,
    };
  }
}
`;

  async function agentFor(s: Sandbox) {
    return new ReproductionAgent(s, new ValidationEngine(s));
  }

  it('proves the failure, then proves the patch removes it', async () => {
    const s = await makeSandbox();
    const agent = await agentFor(s);

    const attempt = await agent.demonstrateFailure({
      testPath: 'test/regression-inc-1.test.ts',
      testSource: REGRESSION_TEST,
      command: 'node --test',
    });

    // Before: the new test genuinely fails against the deployed revision.
    expect(attempt.beforeFix.passed).toBe(false);
    expect(attempt.beforeFix.exitCode).toBe(1);
    expect(attempt.beforeFix.output).toMatch(/Cannot read properties of (null|undefined)/);
    expect(attempt.failureReason).toBeNull();
    expect(describeReproduction(attempt)).toMatch(/Failure demonstrated/);

    // Apply the patch and re-run.
    await s.writeFile('src/checkout/service.ts', PATCHED_SERVICE);
    const confirmed = await agent.confirmFix(attempt);

    expect(confirmed.proven).toBe(true);
    expect(confirmed.afterFix!.passed).toBe(true);
    // The pre-existing tests still pass alongside the new one.
    expect(confirmed.afterFix!.testsPassed).toBe(3);
    expect(confirmed.afterFix!.testsFailed).toBe(0);
    expect(describeReproduction(confirmed)).toMatch(/failed with exit 1 before the patch and passed after it/);
  });

  it('rejects a test that passes before the patch as not a reproduction', async () => {
    const s = await makeSandbox();
    const agent = await agentFor(s);

    const attempt = await agent.demonstrateFailure({
      testPath: 'test/useless.test.ts',
      testSource: `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('trivially true', () => assert.ok(true));\n`,
      command: 'node --test',
    });

    expect(attempt.beforeFix.passed).toBe(true);
    expect(attempt.proven).toBe(false);
    expect(attempt.failureReason).toMatch(/does not exercise the reported failure/);
    // And the agent cannot proceed to claim a fix from it.
    await expect(agent.confirmFix(attempt)).rejects.toThrow(ReproductionError);
  });

  it('reports a patch that does not work, rather than declaring success', async () => {
    const s = await makeSandbox();
    const agent = await agentFor(s);

    const attempt = await agent.demonstrateFailure({
      testPath: 'test/regression-inc-1.test.ts',
      testSource: REGRESSION_TEST,
      command: 'node --test',
    });
    expect(attempt.beforeFix.passed).toBe(false);

    // A patch that changes something but does not fix the bug.
    await s.writeFile(
      'src/checkout/service.ts',
      (await s.readFile('src/checkout/service.ts'))!.replace('const subtotalCents', 'const subtotalCents /* touched */'),
    );
    const confirmed = await agent.confirmFix(attempt);

    expect(confirmed.proven).toBe(false);
    expect(confirmed.failureReason).toMatch(/still fails after the patch/);
    expect(describeReproduction(confirmed)).toMatch(/Not reproduced/);
  });

  it('refuses to confirm a fix when the reproduction command could not run', async () => {
    const s = await makeSandbox();
    const agent = await agentFor(s);
    const attempt = await agent.demonstrateFailure({
      testPath: 'test/x.test.ts',
      testSource: 'export {};',
      command: 'no-such-runner --test',
    });
    expect(attempt.failureReason).toMatch(/could not be executed \(exit 127\)/);
    await expect(agent.confirmFix(attempt)).rejects.toThrow(ReproductionError);
  });
});
