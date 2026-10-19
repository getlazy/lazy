import { describe, test, expect } from 'bun:test';
import { createRecipeHandler, allTools } from '../../src/mcp/tools';
import { TOOL_ACCESS } from '../../src/mcp/tool-access';
import { isToolForRole } from '../../src/mcp/tool-roles';
import { DEFAULT_DOCKERFILE } from '../../src/capture/claude';
import { getAgentPackaging } from '../../src/agent/registry';

describe('lazy_recipe', () => {
  const handler = createRecipeHandler();

  test('no name lists every recipe with a one-line description', async () => {
    const result = await handler({}) as { recipes: { name: string; description: string }[] };
    const taskImage = result.recipes.find(r => r.name === 'task-image');
    expect(taskImage).toBeDefined();
    expect(taskImage!.description).not.toContain('\n');
  });

  test('a name returns the rendered body with no placeholders left', async () => {
    const result = await handler({ name: 'task-image' }) as { name: string; body: string };
    expect(result.name).toBe('task-image');
    expect(result.body).toContain('Dockerfile.lazy');
    expect(result.body).not.toContain('{{');
  });

  // INVARIANT: the recipe quotes the default image verbatim, so what it tells
  // an agent the base contains cannot drift from what the base installs.
  test('the task-image recipe embeds the default Dockerfile and non-Claude agent install lines', async () => {
    const { body } = await handler({ name: 'task-image' }) as { body: string };
    expect(body).toContain(DEFAULT_DOCKERFILE.trimEnd());
    expect(body).toContain(getAgentPackaging('cursor').dockerInstallCommand());
    expect(body).toMatch(/next task/i);
  });

  test('an unknown name throws naming the available recipes', async () => {
    await expect(handler({ name: 'no-such-recipe' })).rejects.toThrow(/No recipe named 'no-such-recipe'.*task-image/);
  });

  // INVARIANT: recipes are served to every harness and both roles on every
  // toolset — it is a pure read, and an ask/review turn may need one too.
  test('is registered, read-classified and served to agents and builders', () => {
    expect(allTools.some(t => t.name === 'lazy_recipe')).toBe(true);
    expect(TOOL_ACCESS.lazy_recipe).toBe('read');
    expect(isToolForRole('lazy_recipe', 'agent')).toBe(true);
    expect(isToolForRole('lazy_recipe', 'builder')).toBe(true);
  });
});
