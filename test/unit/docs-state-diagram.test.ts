import { test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { VALID_TRANSITIONS } from '../../src/task-state-machine';
import { taskStateDiagram } from '../../src/docs/diagrams';

// INVARIANT: the public diagram must match every daemon transition exactly, so an added or removed edge fails until the page is regenerated.
test('public state diagram matches the canonical transition table', async () => {
  const page = await readFile(join(import.meta.dir, '../../public-docs/state-machine.md'), 'utf8');
  const source = page.match(/```mermaid\n%% caption: [^\n]+\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBe(taskStateDiagram());
  for (const status of Object.keys(VALID_TRANSITIONS)) expect(source).toContain(status);
});
