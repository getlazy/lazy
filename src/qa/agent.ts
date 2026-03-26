/**
 * qa-agent entry point — deterministic, scriptable agent for e2e testing.
 *
 * Reads a scenario file, matches the prompt against scenario entries,
 * executes canned actions (create/edit/delete files, run shell commands),
 * commits changes, and outputs a JSON response the supervisor can parse.
 *
 * Usage:
 *   QA_SCENARIO_FILE=/path/to/scenarios.json bun run src/qa/agent.ts -p "the prompt" --worktree /path/to/worktree
 */

import { writeFileSync, readFileSync, mkdirSync, unlinkSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from '../utils/spawn';
import { randomUUID } from 'crypto';

// --- Scenario schema ---

interface ScenarioAction {
  type: 'create_file' | 'write_file' | 'edit_file' | 'delete_file' | 'shell' | 'append_file';
  path?: string;
  content?: string;
  find?: string;
  replace?: string;
  command?: string;
}

// A single matchable step with actions and response
interface ScenarioStep {
  name?: string;
  match: string;
  actions: ScenarioAction[];
  commit_message: string;
  response: string;
}

// Nested format: scenarios is an object keyed by name, each with a steps array
interface NestedScenario {
  steps: ScenarioStep[];
}

// The scenario file supports two formats:
// 1. Flat array:   { "scenarios": [ { match, actions, ... } ] }
// 2. Nested object: { "scenarios": { "name": { "steps": [ { match, actions, ... } ] } } }
interface ScenarioFile {
  scenarios: ScenarioStep[] | Record<string, NestedScenario>;
}

// Normalize both formats into a flat list of steps
function flattenScenarios(scenarios: ScenarioStep[] | Record<string, NestedScenario>): ScenarioStep[] {
  if (Array.isArray(scenarios)) {
    return scenarios;
  }
  const steps: ScenarioStep[] = [];
  for (const [name, scenario] of Object.entries(scenarios)) {
    for (const step of scenario.steps) {
      steps.push({ ...step, name: step.name ?? name });
    }
  }
  return steps;
}

// --- Arg parsing ---

function parseArgs(argv: string[]): { prompt: string; worktreePath: string } {
  let prompt = '';
  let worktreePath = '';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-p' && i + 1 < argv.length) {
      prompt = argv[i + 1];
      i++;
    } else if (argv[i] === '--worktree' && i + 1 < argv.length) {
      worktreePath = argv[i + 1];
      i++;
    }
  }

  if (!prompt) {
    throw new Error('qa-agent: missing required -p <prompt> argument');
  }
  if (!worktreePath) {
    throw new Error('qa-agent: missing required --worktree <path> argument');
  }

  return { prompt, worktreePath };
}

// --- Action execution ---

function executeAction(action: ScenarioAction, worktreePath: string): void {
  switch (action.type) {
    case 'create_file':
    case 'write_file': {
      if (!action.path || action.content === undefined) {
        throw new Error('create_file action requires path and content');
      }
      const fullPath = join(worktreePath, action.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, action.content);
      break;
    }
    case 'edit_file': {
      if (!action.path || !action.find || action.replace === undefined) {
        throw new Error('edit_file action requires path, find, and replace');
      }
      const fullPath = join(worktreePath, action.path);
      const content = readFileSync(fullPath, 'utf-8');
      const updated = content.replace(action.find, action.replace);
      if (updated === content) {
        throw new Error(`edit_file: pattern "${action.find}" not found in ${action.path}`);
      }
      writeFileSync(fullPath, updated);
      break;
    }
    case 'delete_file': {
      if (!action.path) {
        throw new Error('delete_file action requires path');
      }
      const fullPath = join(worktreePath, action.path);
      unlinkSync(fullPath);
      break;
    }
    case 'append_file': {
      if (!action.path || action.content === undefined) {
        throw new Error('append_file action requires path and content');
      }
      const fullPath = join(worktreePath, action.path);
      if (!existsSync(fullPath)) {
        mkdirSync(dirname(fullPath), { recursive: true });
      }
      appendFileSync(fullPath, action.content);
      break;
    }
    case 'shell': {
      if (!action.command) {
        throw new Error('shell action requires command');
      }
      const result = spawnSync(['sh', '-c', action.command], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(`shell command failed (exit ${result.exitCode}): ${action.command}\n${stderr}`);
      }
      break;
    }
    default:
      throw new Error(`Unknown action type: ${(action as ScenarioAction).type}`);
  }
}

function commitChanges(worktreePath: string, message: string): void {
  // Stage all changes
  const addResult = spawnSync(['git', 'add', '-A'], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (addResult.exitCode !== 0) {
    throw new Error(`git add failed: ${addResult.stderr.toString()}`);
  }

  // Check if there are staged changes
  const diffResult = spawnSync(['git', 'diff', '--cached', '--quiet'], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // exitCode 1 means there are differences (changes to commit)
  if (diffResult.exitCode === 0) {
    // No changes to commit — that's fine
    return;
  }

  const commitResult = spawnSync(['git', 'commit', '-m', message], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (commitResult.exitCode !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr.toString()}`);
  }
}

// --- Config resolution ---

// Resolve scenario file path: QA_SCENARIO_FILE env var (override) → lazy.toml [agent.qa].scenario_file → error
function resolveScenarioFilePath(worktreePath: string): string {
  const envPath = process.env.QA_SCENARIO_FILE;
  if (envPath) {
    return envPath;
  }

  // Read lazy.toml from the worktree root
  const configPath = join(worktreePath, process.env.LAZY_CONFIG || 'lazy.toml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = Bun.TOML.parse(raw) as Record<string, unknown>;
      const agent = config.agent as Record<string, unknown> | undefined;
      const qa = agent?.qa as Record<string, unknown> | undefined;
      const scenarioFile = qa?.scenario_file;
      if (typeof scenarioFile === 'string' && scenarioFile) {
        return scenarioFile;
      }
      // [agent.qa] exists but scenario_file is wrong type — tell them
      if (qa && 'scenario_file' in qa) {
        throw new Error(`qa-agent: [agent.qa].scenario_file in ${configPath} must be a non-empty string, got: ${JSON.stringify(qa.scenario_file)}`);
      }
      // No [agent.qa] section — fall through to the "not configured" error
    } catch (err) {
      // Re-throw our own errors, only wrap unexpected parse errors
      if (err instanceof Error && err.message.startsWith('qa-agent:')) throw err;
      throw new Error(`qa-agent: failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error(
    'qa-agent: scenario file not configured. Set QA_SCENARIO_FILE env var or add ' +
    '[agent.qa] scenario_file = "/path/to/scenarios.json" to lazy.toml'
  );
}

// --- Main ---

function main(): void {
  const { prompt, worktreePath } = parseArgs(process.argv.slice(2));

  const scenarioFilePath = resolveScenarioFilePath(worktreePath);

  let scenarioFile: ScenarioFile;
  try {
    const raw = readFileSync(scenarioFilePath, 'utf-8');
    scenarioFile = JSON.parse(raw) as ScenarioFile;
  } catch (err) {
    throw new Error(`qa-agent: failed to read scenario file ${scenarioFilePath}: ${err instanceof Error ? err.message : err}`);
  }

  if (!scenarioFile.scenarios || (typeof scenarioFile.scenarios !== 'object')) {
    throw new Error('qa-agent: scenario file must have a "scenarios" field (array or object)');
  }

  const steps = flattenScenarios(scenarioFile.scenarios);

  // Match prompt against steps (first match wins)
  let matched: ScenarioStep | undefined;
  for (const step of steps) {
    const regex = new RegExp(step.match, 'i');
    if (regex.test(prompt)) {
      matched = step;
      break;
    }
  }

  if (!matched) {
    // Output error response in expected JSON format
    const errorResponse = {
      result: `qa-agent: no scenario matched the prompt. Prompt: "${prompt.substring(0, 200)}"`,
      session_id: randomUUID(),
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    process.stdout.write(JSON.stringify(errorResponse));
    process.exit(0);
  }

  // Execute all actions
  for (const action of matched.actions) {
    executeAction(action, worktreePath);
  }

  // Commit changes
  commitChanges(worktreePath, matched.commit_message);

  // Output success response
  const response = {
    result: matched.response,
    session_id: randomUUID(),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  process.stdout.write(JSON.stringify(response));
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`qa-agent error: ${message}\n`);
  process.exit(1);
}
