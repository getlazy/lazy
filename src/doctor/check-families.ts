/**
 * Machine-readable classification of doctor findings.
 *
 * A check's label varies with what it found ("Git installed (v2.44)", "No
 * stale runner images (skipped — …)"), so neither the label nor the id derived
 * from it is a key a client can branch on. This table maps each check to a
 * stable FAMILY plus two facts a client needs in order to REACT to a finding
 * without parsing its prose:
 *
 * - `remedyKind` — what kind of act fixes it. `flag` means a
 *   `doctor.applyRemedy` flag does (the result also carries `remedyFlag`);
 *   every other kind says who has to act and where.
 * - `impact` — `work` when the finding stops or degrades task turns (a turn
 *   cannot launch, a credential is refused, pushes fail); `setup` when it is
 *   housekeeping or machine hygiene that work continues through.
 *
 * Diagnosis stays here: a client (Lazy Teams) decides what to DO with a
 * class, never what the class is. A check missing from the table gets the
 * conservative default — `manual`, `setup` — so an unclassified finding is
 * shown to an operator and never acted on or put in front of a user.
 */

export type DoctorRemedyKind =
  /** A `lazy doctor --<flag>` remedy (`doctor.applyRemedy`) fixes it. */
  | 'flag'
  /** Restarting the project's daemon fixes it. */
  | 'restart-daemon'
  /** An edit to lazy.toml fixes it. */
  | 'config'
  /** A credential has to be supplied, refreshed or replaced. */
  | 'credential'
  /** Something on the host machine has to be installed, started or freed. */
  | 'host'
  /** A person has to look at it and decide; there is no mechanical fix. */
  | 'manual';

export type DoctorImpact = 'work' | 'setup';

export interface DoctorCheckFamily {
  family: string;
  remedyKind: DoctorRemedyKind;
  impact: DoctorImpact;
}

interface FamilyRule extends DoctorCheckFamily {
  /** Label prefix, matched case-sensitively against the check's label. */
  prefix: string;
}

/**
 * Longest prefix wins, so order does not matter. Every prefix here is a label
 * the sweep emits (`src/doctor/sweep.ts`); `test/unit/doctor-check-families.test.ts`
 * scans the sweep so a renamed label cannot silently fall to the default.
 */
export const DOCTOR_CHECK_FAMILIES: readonly FamilyRule[] = [
  { prefix: 'Git installed', family: 'git-installed', remedyKind: 'host', impact: 'work' },
  { prefix: 'Actor identity', family: 'actor-identity', remedyKind: 'host', impact: 'work' },
  { prefix: 'Repository has commits', family: 'repository-has-commits', remedyKind: 'manual', impact: 'work' },
  { prefix: 'Model credential present', family: 'model-credential', remedyKind: 'credential', impact: 'work' },
  { prefix: 'Stored credentials are readable', family: 'stored-credentials', remedyKind: 'credential', impact: 'work' },
  { prefix: 'Model API accepts lazy credential', family: 'credential-accepted', remedyKind: 'credential', impact: 'work' },
  { prefix: 'Usage pause', family: 'usage-pause', remedyKind: 'manual', impact: 'work' },
  { prefix: 'Credentials (skipped', family: 'model-credential', remedyKind: 'config', impact: 'work' },
  { prefix: 'No legacy proxy audit log in the store', family: 'legacy-proxy-audit-log', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'Data directory', family: 'data-directory', remedyKind: 'host', impact: 'work' },
  { prefix: 'Builder scratch dir', family: 'builder-scratch', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'Daemon health', family: 'daemon-health', remedyKind: 'manual', impact: 'work' },
  { prefix: 'Daemon runs current code', family: 'daemon-code-current', remedyKind: 'restart-daemon', impact: 'setup' },
  { prefix: 'Dashboard address', family: 'dashboard-address', remedyKind: 'restart-daemon', impact: 'setup' },
  { prefix: 'Daemon state files consistent', family: 'daemon-state-files', remedyKind: 'restart-daemon', impact: 'setup' },
  { prefix: 'Daemon holds the storage lock but is not serving storage', family: 'storage-lock', remedyKind: 'restart-daemon', impact: 'work' },
  { prefix: 'Storage lock', family: 'storage-lock', remedyKind: 'manual', impact: 'work' },
  { prefix: 'No stale storage lock', family: 'storage-lock', remedyKind: 'manual', impact: 'work' },
  { prefix: 'Runner available', family: 'runner-available', remedyKind: 'restart-daemon', impact: 'work' },
  { prefix: 'Agent binary', family: 'agent-binary', remedyKind: 'host', impact: 'work' },
  { prefix: 'Worktree image adopt', family: 'worktree-image-adoption', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'Extra container run args', family: 'container-run-args', remedyKind: 'config', impact: 'setup' },
  { prefix: 'Container image exists', family: 'container-image', remedyKind: 'host', impact: 'work' },
  { prefix: 'Container image up to date', family: 'container-image-current', remedyKind: 'host', impact: 'setup' },
  { prefix: 'No stale runner images', family: 'stale-images', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'No orphaned containers', family: 'orphaned-containers', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'No worktrees left for finished tasks', family: 'finished-task-worktrees', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'No missing task runs', family: 'missing-task-runs', remedyKind: 'manual', impact: 'work' },
  { prefix: 'No stale locks', family: 'stale-locks', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'No split storage', family: 'split-storage', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'No tasks stranded in merging', family: 'stranded-merging', remedyKind: 'manual', impact: 'work' },
  { prefix: 'All conversations captured', family: 'conversation-capture', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'Builder conversations captured', family: 'conversation-capture', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'Conversation capture is live', family: 'conversation-capture', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'Conversation listings', family: 'conversation-listings', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'Shared memory', family: 'shared-memory-import', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'Injected memory context', family: 'memory-context', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'Protected tasks resolvable', family: 'protected-tasks', remedyKind: 'config', impact: 'work' },
  { prefix: 'Default-branch protection', family: 'default-branch-protection', remedyKind: 'config', impact: 'work' },
  { prefix: 'Approval passphrase', family: 'approval-passphrase', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'Legacy plaintext passphrase file', family: 'approval-passphrase', remedyKind: 'manual', impact: 'setup' },
  { prefix: 'Protection config coherent', family: 'protection-config', remedyKind: 'config', impact: 'setup' },
  { prefix: 'Protection off', family: 'protection-config', remedyKind: 'config', impact: 'setup' },
  { prefix: 'No task branches with upstream tracking', family: 'upstream-tracking', remedyKind: 'flag', impact: 'setup' },
  { prefix: 'Git LFS', family: 'git-lfs', remedyKind: 'host', impact: 'work' },
  { prefix: 'Disk space', family: 'disk-space', remedyKind: 'host', impact: 'work' },
  { prefix: 'Remote driver', family: 'remote-driver', remedyKind: 'credential', impact: 'work' },
  { prefix: 'Offline mode', family: 'offline-mode', remedyKind: 'config', impact: 'work' },
  { prefix: 'lazy.toml parses', family: 'config-parses', remedyKind: 'config', impact: 'work' },
  { prefix: "lazy.toml '", family: 'managed-config', remedyKind: 'config', impact: 'setup' },
  { prefix: 'No lazy.toml setting is being overridden', family: 'managed-config', remedyKind: 'config', impact: 'setup' },
  { prefix: 'Managed mode', family: 'managed-config', remedyKind: 'config', impact: 'setup' },
  { prefix: 'Config ', family: 'config-keys', remedyKind: 'config', impact: 'setup' },
  { prefix: 'No unknown config options', family: 'config-keys', remedyKind: 'config', impact: 'setup' },
  { prefix: 'No deprecated config options', family: 'config-keys', remedyKind: 'config', impact: 'setup' },
  { prefix: 'Feature flags', family: 'feature-flags', remedyKind: 'config', impact: 'setup' },
  { prefix: 'Shell detected', family: 'shell', remedyKind: 'host', impact: 'setup' },
  { prefix: 'Completions installed', family: 'completions', remedyKind: 'host', impact: 'setup' },
  { prefix: 'tmux', family: 'tmux', remedyKind: 'host', impact: 'setup' },
];

/**
 * Classify one check. A result that names a remedy flag is always `flag` —
 * the flag is the most specific remedy there is, whatever the family says.
 */
export function classifyDoctorCheck(label: string, fallbackId: string, remedyFlag?: string): DoctorCheckFamily {
  let best: FamilyRule | undefined;
  for (const rule of DOCTOR_CHECK_FAMILIES) {
    if (label.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  }
  const family = best?.family ?? fallbackId;
  const impact = best?.impact ?? 'setup';
  if (remedyFlag) return { family, remedyKind: 'flag', impact };
  // A family whose remedy is a flag only when the check actually offered one:
  // a skipped or passing variant carries no flag, and "flag" without one
  // would promise an act nothing can perform.
  const kind = best?.remedyKind ?? 'manual';
  return { family, remedyKind: kind === 'flag' ? 'manual' : kind, impact };
}
