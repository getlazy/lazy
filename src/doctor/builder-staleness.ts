/**
 * Doctor: a running builder container that predates the current config or image.
 *
 * `lazy upgrade` deliberately leaves builders running (they reconnect in place),
 * so a builder's container keeps the `--model` it was launched with and the
 * image it started from for as long as it lives. This check is how that
 * becomes visible: it compares each running builder's launch argv and image to
 * what a fresh `lazy builder` would use now.
 */

import type { CheckResult } from './types';
import { spawn } from '../utils/spawn';
import { MODEL_OVERRIDE_FLAG, resolveBuilderLaunchDirective } from '../builder/launch-directive';
import type { ResolvedConfig } from '../config/types';
import type { Runner } from '../runner';

const INSPECT_TIMEOUT_MS = 15_000;

export interface BuilderContainerFacts {
  name: string;
  /** Image ID the container was created from. */
  imageId: string;
  /** The container's command line (`.Config.Cmd`). */
  cmd: string[];
  /** `--model` on the RUNNING claude process, when it could be read (else the container argv's). */
  runningModel?: string | null;
}

/** The `--model` value a builder's claude args carry, or null when it passes none. */
export function modelFromBuilderCmd(cmd: string[]): string | null {
  const dashdash = cmd.indexOf('--');
  const args = dashdash === -1 ? cmd : cmd.slice(dashdash + 1);
  const i = args.lastIndexOf('--model');
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

/** The LAST `--model` in a process line (the system prompt earlier in it may mention the flag). */
export function runningModelFromProcessLine(line: string): string | null {
  const all = [...line.matchAll(/(?:^|\s)--model (\S+)/g)];
  return all.length > 0 ? all[all.length - 1][1] : null;
}

/** Why each stale builder is stale; empty when all match. Pure. */
export function describeStaleBuilders(
  builders: BuilderContainerFacts[],
  expectedModel: string | null,
  currentImageId: string | null,
): string[] {
  const out: string[] = [];
  for (const b of builders) {
    const reasons: string[] = [];
    // A model the person typed on `lazy builder` is deliberately pinned: the
    // supervisor keeps it, so it is never stale against the config.
    const typed = b.cmd.includes(MODEL_OVERRIDE_FLAG);
    // runningModel undefined = the live process could not be read. The container argv
    // is the FIRST start's model, which a relaunched Claude no longer uses, so it is
    // no evidence either way: skip rather than report a false stale.
    const model = b.runningModel;
    if (!typed && model !== undefined && (model ?? null) !== (expectedModel ?? null)) {
      reasons.push(`runs model ${model ?? '(default)'}, config now says ${expectedModel ?? '(default)'}`);
    }
    if (currentImageId && b.imageId !== currentImageId) {
      reasons.push('started from an older image than the current one');
    }
    if (reasons.length > 0) out.push(`${b.name}: ${reasons.join('; ')}`);
  }
  return out;
}

async function dockerText(args: string[]): Promise<string | null> {
  const proc = spawn(args, { stdout: 'pipe', stderr: 'ignore', timeout: INSPECT_TIMEOUT_MS });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? text.trim() : null;
}

export async function checkBuildersCurrent(opts: {
  root: string;
  runner: Runner;
  binary: 'docker' | 'podman';
  imageName: string;
  config: ResolvedConfig;
}): Promise<CheckResult> {
  const label = 'Running builders match current config';
  let names: string[];
  try {
    names = await opts.runner.discoverProjectBuilderRuns(opts.root);
  } catch (err) {
    return { ok: true, label: `${label} (skipped — could not list builders)`, warning: err instanceof Error ? err.message : String(err) };
  }
  if (names.length === 0) return { ok: true, label };

  const builders: BuilderContainerFacts[] = [];
  for (const name of names) {
    const top = await dockerText([opts.binary, 'top', name, '-eo', 'args']);
    const claudeLine = top?.split('\n').filter(l => l.includes('--append-system-prompt')).pop();
    const runningModel = claudeLine === undefined ? undefined : runningModelFromProcessLine(claudeLine);
    const raw = await dockerText([opts.binary, 'inspect', name, '--format', '{{.Image}}|{{json .Config.Cmd}}']);
    if (raw === null) continue; // exited between list and inspect
    const sep = raw.indexOf('|');
    try {
      builders.push({ name, imageId: raw.slice(0, sep), cmd: JSON.parse(raw.slice(sep + 1)) as string[], runningModel });
    } catch (err) {
      return { ok: true, label: `${label} (skipped — unreadable inspect output for ${name})`, warning: err instanceof Error ? err.message : String(err) };
    }
  }

  const currentImageId = await dockerText([opts.binary, 'image', 'inspect', opts.imageName, '--format', '{{.Id}}']);
  const expected = resolveBuilderLaunchDirective(opts.config).model;
  const stale = describeStaleBuilders(builders, expected, currentImageId || null);
  const shown = builders.map(b => `${b.name.replace('lazy-builder-', '')}: ${b.runningModel === undefined ? 'model unreadable' : b.runningModel ?? 'default model'}`).join(', ');
  if (stale.length === 0) return { ok: true, label: `${label} (${shown})` };
  return {
    ok: false,
    label,
    detail: `${stale.length} running builder(s) predate the current config or image — ${stale.join(' | ')}. ` +
      'Quit each (it keeps its session) and start it again with `lazy builder --resume <id>` to pick up the current model, prompt and image. ' +
      'A builder whose supervisor predates daemon-served model/effort needs this manual restart once; after that, in-place reconnects follow the config.',
  };
}
