import { describe, expect, it } from 'vitest';
import { changedPaths, deriveWindows } from '../src/domain/deployment.js';

describe('deriveWindows', () => {
  const deployedAt = new Date('2026-09-13T14:31:00Z');

  it('never lets the baseline and observation windows overlap', () => {
    const { before, after } = deriveWindows(deployedAt);
    expect(before.to.getTime()).toBeLessThan(after.from.getTime());
  });

  it('excludes the deployment instant from the baseline', () => {
    // A provider treating the range as inclusive would otherwise average the first
    // post-deployment sample into the baseline.
    const { before, after } = deriveWindows(deployedAt);
    expect(before.to.toISOString()).toBe('2026-09-13T14:30:59.999Z');
    expect(after.from.toISOString()).toBe('2026-09-13T14:31:00.000Z');
  });

  it('spans the configured durations', () => {
    const { before, after } = deriveWindows(deployedAt, { baselineMinutes: 60, observationMinutes: 15 });
    expect(before.from.toISOString()).toBe('2026-09-13T13:31:00.000Z');
    expect(after.to.toISOString()).toBe('2026-09-13T14:46:00.000Z');
  });

  it('collects changed paths as a set', () => {
    const paths = changedPaths({
      changedFiles: [
        { path: 'a.ts', status: 'modified', additions: 1, deletions: 0 },
        { path: 'b.ts', status: 'added', additions: 2, deletions: 0 },
      ],
    });
    expect(paths).toEqual(new Set(['a.ts', 'b.ts']));
  });
});
