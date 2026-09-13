import type { ScenarioFixture } from '../seed.js';
import { INC_001 } from './inc-001.js';

export const FIXTURES: Record<string, ScenarioFixture> = {
  'INC-001': INC_001,
};

export function fixture(id: string): ScenarioFixture {
  const found = FIXTURES[id];
  if (!found) {
    throw new Error(`No local fixture for ${id}. Available: ${Object.keys(FIXTURES).join(', ')}`);
  }
  return found;
}

export { INC_001 };
