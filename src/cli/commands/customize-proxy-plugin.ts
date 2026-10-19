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
 * AGENTS.md; the code templates live in ./customize-proxy-plugin-template.
 */

import { mkdir, writeFile, access } from 'fs/promises';
import { join, relative } from 'path';
import { parseFlags, requireLazyRoot } from '../helpers';
import { PLUGIN_DIR_RELATIVE } from '../../proxy';
import { repositoryPluginsDisabled, REPOSITORY_PLUGINS_NOT_RUN } from '../../config/managed-repo-code';
import { PLUGIN_TEMPLATE, TEST_TEMPLATE } from './customize-proxy-plugin-template';
import guidePrompt from '../../prompts/customize-proxy-plugin-guide.md' with { type: 'text' };
import notRunNoticeTemplate from '../../prompts/customize-proxy-plugin-not-run.md' with { type: 'text' };

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

  // Keyed off repositoryPluginsDisabled() so restoring loading removes every warning.
  const notRun = repositoryPluginsDisabled();
  if (notRun) {
    console.log(`WARNING: ${REPOSITORY_PLUGINS_NOT_RUN}. The files below are scaffolded anyway, so the work is not lost if loading comes back.`);
    console.log('');
  }
  console.log(`Scaffolded proxy request plugin "${name}":`);
  console.log(`  ${relPlugin}   the plugin (a working no-op — edit transformRequest)`);
  console.log(`  ${relTest}   its smoke test (${testCommand})`);
  console.log('');
  if (notRun) {
    console.log(`lazy does not currently run repository plugins, so this plugin will NOT be loaded — the daemon log and \`lazy doctor\` will say so. You can still develop and test it with ${testCommand}.`);
  }

  if (parsed.flags.get('no-prompt') !== true) {
    console.log('');
    console.log('--- Hand the prompt below to your agent to develop the plugin ---');
    console.log('');
    console.log(
      guidePrompt
        .replace(/\{\{notRunNotice\}\}/g, notRun ? guideNotRunNotice() : '')
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{pluginPath\}\}/g, relPlugin)
        .replace(/\{\{testCommand\}\}/g, testCommand)
        .replace(/\{\{testPath\}\}/g, relTest),
    );
  }
}

function guideNotRunNotice(): string {
  return notRunNoticeTemplate.replace('{{notRun}}', () => REPOSITORY_PLUGINS_NOT_RUN);
}

export function customizeProxyPluginUsage(): void {
  console.log(`Usage: lazy customize proxy-plugin <name> [--force] [--no-prompt]

Scaffold a proxy request plugin into ${PLUGIN_DIR_RELATIVE}/.

Lazy's proxy sits on every agent's model traffic. A request plugin receives the
parsed JSON body of each outbound request and may return a replacement body.
${repositoryPluginsDisabled() ? `NOTE: ${REPOSITORY_PLUGINS_NOT_RUN}. A scaffolded plugin is NOT
loaded; the daemon log and lazy doctor say so.
` : ''}
Two files are written: the plugin (a working no-op you edit) and a smoke test
encoding the contract. A guide prompt is printed afterwards for handing to an
agent. ${PLUGIN_DIR_RELATIVE}/ is not gitignored — commit them to share the
plugin with your team.

${repositoryPluginsDisabled() ? 'Were plugins loaded, their code would run INSIDE the lazy daemon process, on the\nhost, unsandboxed — which is why they are not.\n' : ''}
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
