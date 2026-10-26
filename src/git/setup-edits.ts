/** Historical init transformations, retained for exact-match managed checkout recovery. */
export function setupStorageText(content: string, externalPath: string): string {
  const quoted = JSON.stringify(externalPath);

  // The [storage] section body: from its header to the next section header
  // (or EOF). `m` so ^ matches line starts; the lookahead stops at `[next]`.
  const sectionMatch = content.match(/^\[storage\][^\n]*\n(?:(?!^\[)[\s\S])*/m);
  if (!sectionMatch) {
    const sep = content.endsWith('\n') ? '' : '\n';
    return `${content}${sep}\n[storage]\nbackend = "external"\nexternal_path = ${quoted}\n`;
  }

  let section = sectionMatch[0];
  section = /^external_path\s*=/m.test(section)
    ? section.replace(/^external_path\s*=.*$/m, `external_path = ${quoted}`)
    : section.replace(/^(\[storage\][^\n]*\n)/, `$1external_path = ${quoted}\n`);

  section = /^backend\s*=/m.test(section)
    ? section.replace(/^backend\s*=.*$/m, 'backend = "external"')
    : section.replace(/^(\[storage\][^\n]*\n)/, '$1backend = "external"\n');

  return content.replace(sectionMatch[0], section);
}

export const LAZY_IGNORE_ENTRIES = [
  '.env',
  '.lazy-task-sandbox/',
  '.lazy-lock',
  '.lazy/',
];

/**
 * Entries written by older versions of `lazy init`, back when the in-repo
 * storage backend kept task JSON in `.lazy/tasks/` and that state was
 * deliberately committed — so only the runtime subpaths could be ignored.
 *
 * That backend is gone (`src/config/loader.ts` rejects `backend = "in-repo"`
 * and `"orphan-branch"`), so these are removed and replaced by `.lazy/`.
 */
const LEGACY_LAZY_IGNORE_ENTRIES = [
  '.lazy/worktrees/',
  '.lazy/bin/',
  '.lazy/logs/',
  '.lazy/recovery/',
  '.lazy/tasks/*/*.tmp.*',
  '.lazy/tasks/*/*.backup.*',
  '.lazy/tasks/*/protocol/',
  '.lazy/storage.lock',
  '.lazy/.reconcile-lock',
  '.lazy/tmp',
  // The in-repo plaintext approval passphrase is GONE (v0.23) — it lives
  // hashed outside every repository now. Kept in this legacy list so init
  // sweeps the stale line out of existing .gitignore files.
  '.lazy/approve-passphrase',
];

/**
 * Reconcile the project's .gitignore with LAZY_IGNORE_ENTRIES.
 *
 * Idempotent: repeated runs converge on the same file. Any legacy enumerated
 * `.lazy/...` entry is dropped rather than left alongside the blanket rule, and
 * an existing blanket `.lazy/` is left in place (older versions of init actively
 * stripped it — that anti-migration is gone).
 *
 * Returns the exact text the historical init writes.
 */
export function setupGitignoreText(before: string): string {
  // Drop the legacy enumerated entries and the legacy `.workshop/` rule.
  // Line-exact matching only: a user's own `.lazy/tasks/*/protocol/` comment or
  // a negation (`!.lazy/keep-me`) is left untouched.
  const kept = before.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed === '.workshop/') return false;
    return !LEGACY_LAZY_IGNORE_ENTRIES.includes(trimmed);
  });

  const present = new Set(kept.map(line => line.trim()));
  const missing = LAZY_IGNORE_ENTRIES.filter(entry => !present.has(entry));

  let text = kept.join('\n');
  if (missing.length > 0) {
    text = text.trimEnd() + '\n' + missing.join('\n') + '\n';
  }

  return text;
}

export function setupRemoteText(content: string, overrides: Record<string, string>): string {
  for (const [key, value] of Object.entries(overrides)) {
    // Parse dotted key: "remote.driver" → section="remote", field="driver"
    const dotIdx = key.indexOf('.');
    if (dotIdx === -1) continue;

    const section = key.substring(0, dotIdx);
    const field = key.substring(dotIdx + 1);

    // Escape regex metacharacters in section/field names to prevent injection
    const escSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Replace the field value in the section
    const pattern = new RegExp(
      `^(\\[${escSection}\\]\\s*\\n(?:.*\\n)*?${escField}\\s*=\\s*)"[^"]*"`,
      'm',
    );
    content = content.replace(pattern, `$1"${value}"`);
  }

  return content;
}
