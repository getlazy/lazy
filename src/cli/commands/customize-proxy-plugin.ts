/**
 * `lazy customize proxy-plugin <name>` — scaffold a proxy request plugin into
 * the project's `.lazy/plugins/` directory.
 *
 * The proxy's plugin chain is convention-loaded: presence of a module in
 * `.lazy/plugins/` is the enable switch, so scaffolding a file IS installing the
 * plugin. The template therefore ships as a working no-op — it loads, it passes
 * its smoke test, and it forwards every request unchanged — so a user can
 * confirm the wiring before writing any behaviour.
 *
 * The command also prints a guide prompt the user can hand to their own agent
 * to develop the plugin further. That prompt is a .md in src/prompts/ per
 * CLAUDE.md; the code templates live in ./customize-proxy-plugin-template.
 */

import { mkdir, writeFile, access } from 'fs/promises';
import { join, relative } from 'path';
import { parseFlags, requireLazyRoot } from '../helpers';
import { PLUGIN_DIR_RELATIVE } from '../../proxy';
import { PLUGIN_TEMPLATE, TEST_TEMPLATE } from './customize-proxy-plugin-template';
import guidePrompt from '../../prompts/customize-proxy-plugin-guide.md' with { type: 'text' };

/**
 * Plugin names become both a filename and a log identifier, so they are held to
 * a conservative kebab shape rather than sanitised into something the user did
 * not type. Rejecting is louder than silently rewriting.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // access() throws for both "missing" and "not permitted"; either way the
    // caller only needs "can I safely write here", and writeFile will report a
    // permission problem with a far better message than we could here.
    return false;
  }
}

export async function commandCustomizeProxyPlugin(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'force', aliases: ['f'], takesValue: false },
    { name: 'no-prompt', takesValue: false },
  ], 'customize proxy-plugin');

  const name = parsed.positional[0];
  if (!name) {
    customizeProxyPluginUsage();
    process.exit(1);
  }

  if (!NAME_PATTERN.test(name)) {
    console.error(
      `Error: "${name}" is not a valid plugin name.\n` +
      'Use lowercase letters, digits and dashes (e.g. strip-trailing-space).\n' +
      'The name becomes the filename and the identifier lazy logs at startup.',
    );
    process.exit(1);
  }

  const root = requireLazyRoot();
  const dir = join(root, PLUGIN_DIR_RELATIVE);
  const pluginPath = join(dir, `${name}.ts`);
  const testPath = join(dir, `${name}.test.ts`);
  const force = parsed.flags.get('force') === true;

  if (!force) {
    for (const path of [pluginPath, testPath]) {
      if (await exists(path)) {
        console.error(
          `Error: ${relative(root, path)} already exists.\n` +
          'Pass --force to overwrite it, or choose a different plugin name.',
        );
        process.exit(1);
      }
    }
  }

  await mkdir(dir, { recursive: true });

  const fill = (template: string): string =>
    template.replace(/\{\{name\}\}/g, name).replace(/\{\{module\}\}/g, name);

  await writeFile(pluginPath, fill(PLUGIN_TEMPLATE), 'utf-8');
  await writeFile(testPath, fill(TEST_TEMPLATE), 'utf-8');

  const relPlugin = relative(root, pluginPath);
  const relTest = relative(root, testPath);
  // The leading ./ is required: bun treats a dot-leading test filter as a
  // pattern rather than a path, and `bun test .lazy/plugins/x.test.ts` matches
  // nothing at all.
  const testCommand = `bun test ./${relTest}`;

  console.log(`Scaffolded proxy request plugin "${name}":`);
  console.log(`  ${relPlugin}   the plugin (a working no-op — edit transformRequest)`);
  console.log(`  ${relTest}   its smoke test (${testCommand})`);
  console.log('');
  console.log(`The plugin is ALREADY INSTALLED: lazy's proxy loads every module in`);
  console.log(`${PLUGIN_DIR_RELATIVE}/ — presence is the enable switch, there is no config key.`);
  console.log('Run `lazy daemon restart` and the startup log will name it.');
  console.log('');
  console.log(`${PLUGIN_DIR_RELATIVE}/ is not gitignored, so commit these files to share the`);
  console.log('plugin with your team. Plugin code runs inside the lazy daemon process,');
  console.log('on the host, unsandboxed — review it like any other code you run.');

  if (parsed.flags.get('no-prompt') !== true) {
    console.log('');
    console.log('--- Hand the prompt below to your agent to develop the plugin ---');
    console.log('');
    console.log(
      guidePrompt
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{pluginPath\}\}/g, relPlugin)
        .replace(/\{\{testCommand\}\}/g, testCommand)
        .replace(/\{\{testPath\}\}/g, relTest),
    );
  }
}

export function customizeProxyPluginUsage(): void {
  console.log(`Usage: lazy customize proxy-plugin <name> [--force] [--no-prompt]

Scaffold a proxy request plugin into ${PLUGIN_DIR_RELATIVE}/.

Lazy's proxy sits on every agent's model traffic. A request plugin receives the
parsed JSON body of each outbound request and may return a replacement body.
Plugins are loaded by convention from ${PLUGIN_DIR_RELATIVE}/ in sorted-filename
order — presence is the enable switch, there is no lazy.toml key. A project with
no plugin directory forwards every request byte-for-byte, as it always has.

Two files are written: the plugin (a working no-op you edit) and a smoke test
encoding the contract. A guide prompt is printed afterwards for handing to an
agent. ${PLUGIN_DIR_RELATIVE}/ is not gitignored — commit them to share the
plugin with your team.

Plugin code runs INSIDE the lazy daemon process, on the host, unsandboxed, and
is loaded from the main checkout only — never from a task worktree.

Arguments:
  <name>          Plugin name: lowercase letters, digits and dashes

Options:
  -f, --force     Overwrite existing files with the same name
  --no-prompt     Scaffold only; do not print the agent guide prompt

Examples:
  lazy customize proxy-plugin strip-trailing-space
  lazy customize proxy-plugin redact-secrets --no-prompt
  bun test ./.lazy/plugins/strip-trailing-space.test.ts`);
}
