/**
 * Built-in recipes: harness-independent instructions an agent loads on demand.
 *
 * A recipe is a markdown file under `src/prompts/recipes/`, served by ONE MCP
 * tool (`lazy_recipe`): no name lists every recipe with its one-line
 * description, a name returns the body. Serving them over lazy's MCP rather
 * than as a harness's own "skill" is what makes them reach every agent lazy
 * runs — Claude Code, Codex, Pi and Cursor all see the same tool list.
 *
 * Built-in only. Project-local recipes (a committed `.lazy/` directory) are a
 * later step and deliberately not read here.
 */

import { composeRunnerDockerfile } from '../docker/runner-dockerfile';
import taskImageRecipe from '../prompts/recipes/task-image.md' with { type: 'text' };
import { getAgentPackaging, listSelectableAgents } from '../agent/registry';

export interface Recipe {
  name: string;
  /** One line: WHEN an agent should load it. */
  description: string;
  /** Rendered lazily so placeholder values are always current. */
  render: () => string;
}

function indent(text: string): string {
  return text.split('\n').map(line => `  ${line}`).join('\n');
}

/**
 * Install lines for every agent that can run in a container, for a project
 * Dockerfile on a base OTHER than lazy-runner (which has them all) — each a
 * fenced block, since some span several lines.
 */
function agentInstallLines(): string {
  return listSelectableAgents()
    .map(id => ({ id, pkg: getAgentPackaging(id) }))
    .filter(({ pkg }) => pkg.supportsContainerRunner())
    .map(({ id, pkg }) => `  ${id}:\n\n  \`\`\`dockerfile\n${indent(pkg.dockerInstallCommand())}\n  \`\`\``)
    .join('\n\n');
}

export const RECIPES: readonly Recipe[] = [
  {
    name: 'task-image',
    description:
      'Your work needs a tool, language or runtime the container lacks (node, cargo, python, …): ' +
      'add it to the project\'s task image, Dockerfile.lazy, correctly.',
    render: () => taskImageRecipe
      // Function replacements: the text is inserted verbatim, so a `$&` or `$'`
      // inside a Dockerfile can never be read as a replacement pattern.
      .replace('{{defaultDockerfile}}', () => composeRunnerDockerfile().trimEnd())
      .replace('{{agentInstallLines}}', () => agentInstallLines()),
  },
];

export function listRecipes(): { name: string; description: string }[] {
  return RECIPES.map(({ name, description }) => ({ name, description }));
}

/** The rendered body of a recipe, or null when no recipe has that name. */
export function getRecipe(name: string): string | null {
  const recipe = RECIPES.find(r => r.name === name.trim().toLowerCase());
  return recipe ? recipe.render() : null;
}
