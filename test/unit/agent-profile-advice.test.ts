/**
 * What lazy tells a reader to do about an agent profile, and the source scan
 * that stops the managed-host trap coming back.
 *
 * The trap, in one sentence: `agents.*.endpoint` and `agents.*.credential` are
 * REFUSED on a managed host, and a refusal fails the config load — so a message
 * advising somebody to add such a block does not merely fail to help them, it
 * takes their whole project down if they follow it.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'path';
import {
  addCredentialToProfileAdvice,
  addProfileAdvice,
  builderProfileAdvice,
  changeProfileEndpointAdvice,
  defineProfileAdvice,
  generatedConfigProfileExamples,
  keepProfileOnEndpointAdvice,
  localModelProfileAdvice,
  piUpstreamExamples,
  replaceWithProfileAdvice,
  unreferencedCredentialAdvice,
  unrunnableProfileRefusal,
} from '../../src/config/agent-profile-advice';
import { MANAGED_ENV } from '../../src/config/managed-mode';

const before = process.env[MANAGED_ENV];
afterEach(() => {
  if (before === undefined) delete process.env[MANAGED_ENV];
  else process.env[MANAGED_ENV] = before;
});

function managed<T>(on: boolean, fn: () => T): T {
  if (on) process.env[MANAGED_ENV] = '1';
  else delete process.env[MANAGED_ENV];
  return fn();
}

/**
 * Every piece of advice that NAMES an `[agents.<name>]` block when unmanaged.
 *
 * `keepProfileOnEndpointAdvice` is deliberately not here: it is the other shape
 * — advice to set a refused KEY on a profile already under discussion, with no
 * table header anywhere — and gets its own assertion below.
 */
const BRANCHING_ADVICE: { name: string; render: () => string }[] = [
  { name: 'defineProfileAdvice', render: () => defineProfileAdvice('pi') },
  { name: 'addProfileAdvice', render: addProfileAdvice },
  { name: 'changeProfileEndpointAdvice', render: () => changeProfileEndpointAdvice('pi') },
  { name: 'builderProfileAdvice', render: builderProfileAdvice },
  { name: 'piUpstreamExamples', render: piUpstreamExamples },
  { name: 'addCredentialToProfileAdvice', render: () => addCredentialToProfileAdvice('pi') },
  { name: 'unreferencedCredentialAdvice', render: () => unreferencedCredentialAdvice('codex') },
  { name: 'localModelProfileAdvice', render: localModelProfileAdvice },
  { name: 'generatedConfigProfileExamples', render: generatedConfigProfileExamples },
  {
    name: 'replaceWithProfileAdvice',
    render: () => replaceWithProfileAdvice('  [agents.x]\n  endpoint = "http://h"', 'Then delete it.'),
  },
];

describe('agent profile advice', () => {
  // INVARIANT: no message lazy produces on a managed host may tell the reader to
  // put an `[agents.<name>]` block in the repository's lazy.toml. The managed
  // policy REFUSES `agents.*.endpoint` and `agents.*.credential`, and a refusal
  // fails the config load — so following that advice replaces "this agent will
  // not start" with "this project will not load", which is worse and was
  // reached by doing what lazy said.
  //
  // Asserted as the ABSENCE of the instruction rather than the presence of new
  // wording, because it is the instruction that does the damage: a future
  // rewrite that keeps some managed-sounding sentence but restores the "add a
  // block" clause has reintroduced the bug and must fail here.
  test.each(BRANCHING_ADVICE)('$name does not recommend a block on a managed host', ({ render }) => {
    const text = managed(true, render);
    expect(text).not.toMatch(/(?:add|define|write|create)[^.]{0,40}\[agents\./i);
    expect(text).not.toMatch(/change \[agents\.[^\]]+\] in lazy\.toml/i);
  });

  // The other half of the pair: unmanaged, the reader owns the file and the
  // block IS the answer. Without this, every assertion above could be satisfied
  // by deleting the advice outright.
  test.each(BRANCHING_ADVICE)('$name still names the block when unmanaged', ({ render }) => {
    expect(managed(false, render)).toMatch(/\[agents\./);
  });

  // Managed wording has a job beyond not-lying: somebody has to be able to act
  // on it, and it must not read as though the reader chose wrongly.
  test('managed advice names who can change it', () => {
    for (const { render } of BRANCHING_ADVICE) {
      const text = managed(true, render);
      expect(text).toMatch(/installation/i);
    }
  });

  // The second shape of the same trap: no table header at all, just "Add
  // endpoint = …" about a profile already under discussion. It is the one the
  // first version of the source scan could never have found, so it is asserted
  // by key rather than by header.
  test('advice to set a refused key is dropped on a managed host', () => {
    const anthropic = 'https://api.anthropic.com';
    expect(managed(false, () => keepProfileOnEndpointAdvice(anthropic, 'the local Ollama')))
      .toMatch(/Add endpoint = /);
    const onManaged = managed(true, () => keepProfileOnEndpointAdvice(anthropic, 'the local Ollama'));
    expect(onManaged).not.toMatch(/\b(add|set|write)\b[^.]{0,40}endpoint\s*=/i);
    expect(onManaged).toMatch(/installation/i);
    // The half that is still the reader's to act on must survive: they CAN
    // change the model, and telling them only what they cannot do is useless.
    expect(onManaged).toMatch(/set a model the local Ollama serves/i);
  });

  test('the create-time refusal names the agent, its upstream and the remedy', () => {
    const text = unrunnableProfileRefusal('pi', 'http://localhost:11434');
    expect(text).toMatch(/"pi"/);
    expect(text).toMatch(/http:\/\/localhost:11434/);
    expect(text).toMatch(/ask whoever runs it/i);
    expect(text).not.toMatch(/\[agents\./);
  });
});


/**
 * The detector, as a pure function of a file's TEXT.
 *
 * Text and not lines, because the shape the bug takes is a message ASSEMBLED
 * across several string literals — a `[agents.<name>]` header on one line, the
 * `endpoint` it needs three lines down, the verb that introduces the whole
 * thing ten lines up. The first version of this scan required the header and
 * the verb on ONE line, which is a shape that stopped existing the moment the
 * advice module took those strings over: it reported zero while four
 * paste-ready remedies sat in the tree.
 */
function adviceHits(text: string, routedNames: readonly string[]): string[] {
  // A message may be introduced by its verb well before the block it prints.
  const WINDOW = 16;
  const VERB = /\b(add|define|write|create|change|replace|paste|set|move|give|point)\b/i;
  // The two keys a managed host REFUSES. An assignment to one of them beside an
  // `[agents.` header is a paste-ready block whatever words surround it.
  const REFUSED_KEY = /\b(endpoint|credential)\b\s*=/;
  // …and the same advice with no header in sight: "Add endpoint = …" said about
  // a profile already under discussion. This is how `agent-profiles.ts` spelled
  // it, and no amount of window around `[agents.` would have found it, because
  // the header was bound to a variable 140 lines earlier.
  const SET_REFUSED_KEY = /\b(add|set|write|paste|put|give|move)\b[^\n]{0,70}?\b(endpoint|credential)\b\s*=/i;
  // A call into the advice module IS the fix: the block is then data handed to
  // the function that decides whether a managed reader should see it at all.
  const ROUTED = new RegExp(`\\b(${routedNames.join('|')})\\s*\\(`);

  const lines = text.split('\n').map((line) => {
    // Comments are for whoever edits the file, not for the reader of a message.
    const trimmed = line.trim();
    return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*') ? '' : line;
  });

  const hits: string[] = [];
  lines.forEach((line, i) => {
    const window = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
    const printsABlock = line.includes('[agents.') && (VERB.test(window) || REFUSED_KEY.test(window));
    if (!printsABlock && !SET_REFUSED_KEY.test(line)) return;
    if (ROUTED.test(window)) return;
    hits.push(line.trim());
  });
  return hits;
}

/**
 * Sites the scan flags that are allowed to stand, keyed by file AND by a
 * distinctive piece of the line — never by file alone, because these files also
 * contain the real advice this task fixed, and a whole-file exemption would
 * hide a regression there.
 *
 * Every `why` is a claim that a managed reader is not misled by that line:
 * either they cannot reach it, or it describes configuration rather than
 * recommending it.
 */
const REVIEWED_MENTIONS: { file: string; match: string; why: string }[] = [
  // Flag documentation. `--agent` takes a profile name, and saying where
  // profile names come from is describing the argument, not recommending that
  // the reader go and write one.
  { file: 'cli/commands/start.ts', match: '--agent <profile>', why: 'usage text describing what the flag takes' },
  { file: 'cli/commands/edit.ts', match: '--agent <profile>', why: 'usage text describing what the flag takes' },
  { file: 'cli/commands/create.ts', match: '--agent <profile>', why: 'usage text describing what the flag takes' },
  { file: 'cli/commands/unblock.ts', match: '--agent <profile>', why: 'usage text describing what the flag takes' },
  {
    file: 'cli/commands/system-agent.ts',
    match: 'are joined by any [agents.<name>]',
    why: 'usage text describing where the listed profiles come from',
  },
  // Printed only when there is NOTHING to migrate, and its command refuses
  // outright on a managed host before it can get there.
  {
    file: 'cli/commands/doctor-fix-agents.ts',
    match: 'A profile is an [agents.<name>] block',
    why: 'unreachable on a managed host — the command refuses before printing it',
  },
  // `lazy auth` describes which profiles BILL a stored credential, and that a
  // profile may name one. Neither tells anybody to write a block.
  { file: 'cli/commands/auth.ts', match: '● used by', why: 'names the profiles already billing a stored credential' },
  { file: 'cli/commands/auth.ts', match: 'Or any name an [agents.<profile>] block references', why: 'describes what a credential name may be' },
  { file: 'cli/commands/auth.ts', match: 'from a profile: [agents.work-codex]', why: 'usage text explaining per-profile billing' },
  // "…whose profile PINS endpoint = X, so set model in [agents.X]". A pinned
  // endpoint cannot exist on a managed host — `agents.*.endpoint` is refused,
  // so a config carrying one never loads and this error is unreachable there.
  {
    file: 'utils/role-target.ts',
    match: 'set model in lazy.toml',
    why: 'only reachable for a pinned endpoint, which a managed host refuses',
  },
  // The dashboard is OFF in managed mode (`resolveDashboardAvailability`
  // answers `{ available: false, reason: "off" }`), so no managed reader sees
  // its picker hint.
  {
    file: 'server/templates.ts',
    match: 'These are the same',
    why: 'the dashboard does not run on a managed host',
  },
  // The `lazy doctor --fix agents` planner. Its only caller refuses wholesale
  // on a managed host before a plan is built.
  { file: 'config/agent-migration.ts', match: '[agents.${draft.name}]', why: 'its command refuses wholesale on a managed host' },
  { file: 'config/agent-migration.ts', match: 'write the [agents.${name}] block by hand', why: 'its command refuses wholesale on a managed host' },
  { file: 'config/agent-migration.ts', match: '[agents.codex]\\n  harness', why: 'its command refuses wholesale on a managed host' },
  // Says an endpoint is NOT an opt-out from the proxy. It is a correction, not
  // an instruction to add one.
  {
    file: 'config/loader.ts',
    match: 'There is no per-agent opt-out',
    why: 'denies that the key does something, rather than recommending it',
  },
  // A proxy diagnostic about a profile that already exists.
  {
    file: 'proxy/credential-deps.ts',
    match: 'resolves to credential',
    why: 'describes an existing profile\'s routing, recommends nothing',
  },
];

describe('the source scan that keeps the advice in one place', () => {
  const srcDir = join(import.meta.dir, '..', '..', 'src');
  const ADVICE_MODULE = 'config/agent-profile-advice.ts';

  /** Every function the advice module exports — calling one is what "routed" means. */
  async function routedNames(): Promise<string[]> {
    const text = await Bun.file(join(srcDir, ADVICE_MODULE)).text();
    const names = [...text.matchAll(/export function (\w+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    return names;
  }

  // The detector has to be shown to WORK before its zero result means anything,
  // and it has to be shown on the shape the bug is REALLY written in. The first
  // version of this proof used one-line samples, which is why it passed while
  // four multi-line remedies stood untouched.
  test('flags a paste-ready remedy assembled across several lines', async () => {
    const names = await routedNames();

    // `config/loader.ts`'s `[ollama]` refusal, as it stood before this task.
    // Header, keys and the verb that introduces them are on five different
    // lines, and no single one of them would have tripped a line-scoped rule.
    const ollamaRemedy = [
      "  throw new Error(",
      "    'lazy.toml has an [ollama] section — it has been removed.\\n\\n' +",
      "    'Replace it with:\\n\\n' +",
      "    '  [agents.local-ollama]\\n' +",
      "    `  harness = ${JSON.stringify(harnessName)}\\n` +",
      "    `  endpoint = ${JSON.stringify(endpoint)}\\n\\n` +",
      "    'Run `lazy doctor --fix agents` to have lazy rewrite this for you.',",
      "  );",
    ].join('\n');
    expect(adviceHits(ollamaRemedy, names).length).toBeGreaterThan(0);

    // The same message once it is routed: the block is still authored here, but
    // the decision about whether a managed reader sees it is not.
    const routed = ollamaRemedy.replace("'Replace it with:\\n\\n' +", 'replaceWithProfileAdvice(');
    expect(adviceHits(routed, names)).toEqual([]);

    // …and the variable-bound case, where the header is nowhere near the advice.
    const boundHeader = [
      '  const where = `[agents.${name}]`;',
      ...Array.from({ length: 40 }, () => '  // …a hundred lines of profile resolution…'),
      '    warn(',
      '      `lazy.toml ${where} sets model = "${declaredModel}" — an Anthropic model. ` +',
      '      `Add endpoint = "https://api.anthropic.com" to keep this profile on Anthropic.`,',
      '    );',
    ].join('\n');
    expect(adviceHits(boundHeader, names).length).toBeGreaterThan(0);
  });

  // …and is not so greedy that it flags anything mentioning a profile.
  test('leaves descriptive mentions alone', async () => {
    const names = await routedNames();
    expect(adviceHits("const s = 'this task names it, but no [agents.<name>] block defines it';", names)).toEqual([]);
    expect(adviceHits(' * A profile lazy defines itself, as if an `[agents.<name>]` block had written it.', names)).toEqual([]);
  });

  // INVARIANT: advice about `[agents.<name>]` is built in one module, which
  // decides from managed mode what to say. A surface that spells the sentence
  // itself cannot branch, and the next one written will be wrong in the same
  // way the ones this task fixed were — so this is mechanical rather than a
  // review habit.
  test('no surface spells its own [agents.<name>] advice', async () => {
    const names = await routedNames();
    const offenders: string[] = [];

    for await (const rel of new Glob('**/*.ts').scan({ cwd: srcDir })) {
      if (rel === ADVICE_MODULE) continue;
      for (const hit of adviceHits(await Bun.file(join(srcDir, rel)).text(), names)) {
        if (REVIEWED_MENTIONS.some((m) => m.file === rel && hit.includes(m.match))) continue;
        offenders.push(`src/${rel}: ${hit}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // An allowlist nobody prunes is an allowlist that stops meaning anything: a
  // reviewed exception whose line has since been rewritten should be deleted,
  // not carried forever as an unexamined claim about code that moved on.
  test('every reviewed exception still has something to except', async () => {
    const names = await routedNames();
    const byFile = new Map<string, string[]>();
    for (const { file } of REVIEWED_MENTIONS) {
      if (byFile.has(file)) continue;
      byFile.set(file, adviceHits(await Bun.file(join(srcDir, file)).text(), names));
    }
    for (const { file, match } of REVIEWED_MENTIONS) {
      expect(
        byFile.get(file)!.some((hit) => hit.includes(match)),
        `src/${file} no longer has a line matching ${JSON.stringify(match)} — delete the exception`,
      ).toBe(true);
    }
  });
});
