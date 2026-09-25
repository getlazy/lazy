/**
 * Convention-based loader for USER-authored proxy request plugins.
 *
 * WHERE: `<project>/.lazy/plugins/`. That location is deliberate — `.lazy` is
 * not gitignored, so a plugin a team writes can be committed and shared like
 * any other project file. Presence is the enable switch: no directory, or a
 * directory with no plugin modules in it, means an EMPTY chain, which the proxy
 * treats as "forward the original bytes verbatim". There is no lazy.toml key.
 *
 * WHAT A PLUGIN LOOKS LIKE — a Bun-importable `.ts`/`.js` module whose DEFAULT
 * export is either the plugin object itself:
 *
 *     // .lazy/plugins/strip-trailing-space.ts
 *     export default {
 *       name: 'strip-trailing-space',
 *       transformRequest(body, ctx) {
 *         return null;   // null = "no change", the cheap path
 *       },
 *     };
 *
 * or a zero-argument factory returning one (useful when the plugin needs to
 * precompute a table at load time):
 *
 *     export default () => ({ name: '…', transformRequest });
 *
 * The factory runs ONCE at daemon startup. `transformRequest` itself must obey
 * the seam contract in ./types.ts: pure, synchronous, deterministic, no I/O, no
 * mutation of `body` in place.
 *
 * LOAD ORDER is the sorted filename, so a `10-first.ts` / `20-second.ts` naming
 * convention gives an explicit, reviewable chain. Order matters: the chain is a
 * fold, each plugin seeing the previous one's output.
 *
 * FAILURE POSTURE, in two halves — this split is the whole point:
 *
 *   - LOAD TIME fails LOUD. A file that will not import, or that does not
 *     export the expected shape, throws {@link ProxyPluginLoadError} and takes
 *     the daemon's proxy startup with it. The user wrote that file on purpose;
 *     silently ignoring it would leave them staring at a proxy that appears to
 *     work while their transform never runs. Same posture as a bad lazy.toml.
 *   - RUN TIME fails OPEN. Once loaded, a plugin that throws on a request is
 *     logged and skipped by `applyRequestPlugins`, and the request goes through
 *     unmodified. The proxy is on every agent's critical path; a buggy
 *     transform must degrade to passthrough, never to a failed request.
 *
 * TRUST: plugin code runs INSIDE the daemon process, on the host, with the
 * daemon's full privileges. It is not sandboxed. Loading a plugin is exactly as
 * much of a trust decision as running any other code from the repository.
 *
 * SCOPE: loaded from the MAIN project checkout only. Task worktrees are agent
 * output — a plugin that appeared in a worktree would let a task agent rewrite
 * every other agent's outbound requests, which is not a thing an agent gets to
 * do. The daemon roots at the project directory and passes that path here.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { ProxyRequestPlugin } from './types';

/** Directory, relative to the project root, that plugins are loaded from. */
export const PLUGIN_DIR_RELATIVE = join('.lazy', 'plugins');

/** Absolute path of a project's proxy plugin directory. */
export function proxyPluginDir(projectRoot: string): string {
  return join(projectRoot, PLUGIN_DIR_RELATIVE);
}

/** Module extensions the loader will import. */
const PLUGIN_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'];

/**
 * Load-time failure. Distinct type so the daemon can report "your plugin is
 * broken" separately from "the proxy could not bind".
 */
export class ProxyPluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyPluginLoadError';
  }
}

/**
 * Files in the plugin dir that are NOT plugins:
 *   - dotfiles and `_`-prefixed files (shared helpers a plugin imports)
 *   - `.d.ts` type declarations
 *   - `*.test.*` / `*.spec.*` — the scaffolded smoke test sits next to the
 *     plugin it tests, and must not itself be loaded as one.
 */
function isPluginFile(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (name.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(name)) return false;
  return PLUGIN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

const SHAPE_HINT =
  'A plugin module must default-export either a plugin object ' +
  '`{ name: string, transformRequest(body, ctx) { … } }` or a zero-argument ' +
  'factory returning one. Run `lazy customize proxy-plugin <name>` for a working template.';

/** Narrow an imported value to a plugin, or throw a load error naming the file. */
function coercePlugin(value: unknown, file: string): ProxyRequestPlugin {
  // A factory is called once, here at load time — never per request.
  let candidate = value;
  if (typeof candidate === 'function') {
    try {
      candidate = (candidate as () => unknown)();
    } catch (err) {
      throw new ProxyPluginLoadError(
        `Proxy plugin ${file}: its default-exported factory threw while being called at load time: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (candidate === null || typeof candidate !== 'object') {
    throw new ProxyPluginLoadError(
      `Proxy plugin ${file}: default export is ${candidate === null ? 'null' : typeof candidate}, ` +
        `not a plugin. ${SHAPE_HINT}`,
    );
  }

  const plugin = candidate as Partial<ProxyRequestPlugin>;
  if (typeof plugin.name !== 'string' || plugin.name.trim() === '') {
    throw new ProxyPluginLoadError(
      `Proxy plugin ${file}: missing a non-empty string \`name\`. ${SHAPE_HINT}`,
    );
  }
  if (typeof plugin.transformRequest !== 'function') {
    throw new ProxyPluginLoadError(
      `Proxy plugin ${file}: \`transformRequest\` is missing or not a function. ${SHAPE_HINT}`,
    );
  }

  return plugin as ProxyRequestPlugin;
}

/**
 * Load every plugin in `<projectRoot>/.lazy/plugins/`, in sorted-filename order.
 *
 * Returns `[]` when the directory does not exist — the overwhelmingly common
 * case, and the one that must cost nothing. Throws {@link ProxyPluginLoadError}
 * if the directory exists but a file in it cannot be imported or does not export
 * a plugin.
 */
export async function loadProxyRequestPlugins(
  projectRoot: string,
): Promise<ProxyRequestPlugin[]> {
  const dir = proxyPluginDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // No plugin directory is the default state, not an error — fall through to
    // an empty chain. Anything else (a permission problem, a file where the
    // directory should be) is real and must surface.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ProxyPluginLoadError(
      `Failed to read the proxy plugin directory ${dir}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const files = entries.filter(isPluginFile).sort();
  const plugins: ProxyRequestPlugin[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const abs = join(dir, file);
    let mod: { default?: unknown };
    try {
      // Cache-busted by absolute path only; the daemon loads each plugin once
      // per process, so a plugin edit takes effect on the next daemon restart.
      mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
    } catch (err) {
      throw new ProxyPluginLoadError(
        `Proxy plugin ${abs} failed to load: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!('default' in mod) || mod.default === undefined) {
      throw new ProxyPluginLoadError(
        `Proxy plugin ${abs} has no default export. ${SHAPE_HINT}`,
      );
    }

    const plugin = coercePlugin(mod.default, abs);
    // Names appear in logs and in `appliedBy`; two plugins sharing one makes
    // that record ambiguous, so it is a load error rather than a surprise later.
    const previous = seen.get(plugin.name);
    if (previous) {
      throw new ProxyPluginLoadError(
        `Proxy plugins ${previous} and ${abs} both use the name "${plugin.name}". ` +
          'Plugin names must be unique — they identify the plugin in logs.',
      );
    }
    seen.set(plugin.name, abs);
    plugins.push(plugin);
  }

  return plugins;
}
