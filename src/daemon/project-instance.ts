/**
 * The project instance id — "is the daemon on this port the one I started?"
 *
 * WHY THIS EXISTS. A fleet supervisor starts a daemon, remembers a port, and
 * later has to decide whether the thing answering on that port is still ITS
 * daemon. Daemons share one TCP port window, so a stale port mapping pointing at
 * a neighbour's daemon is an ordinary event, not an exotic one — and answering
 * "yes" wrongly means driving another tenant's project.
 *
 * The existing answers do not survive a VM boundary:
 *
 *  - `projectRoot` on /daemon/status is the daemon's own view of its path. It
 *    works only while the supervisor and the daemon see the same filesystem.
 *    Once the daemon runs inside a sandbox, the supervisor is comparing a host
 *    path against a guest path and the comparison is meaningless — and a
 *    passthrough that happens to preserve the path makes it accidentally right,
 *    which is worse than wrong.
 *  - `instanceId` in the /daemon/status payload is PER-PROCESS: minted with
 *    `randomUUID()` on every start. It answers "did it restart", not "is this
 *    mine". A supervisor restarting its own daemon would see a value it has
 *    never seen before, which is exactly the shape of the answer it must not
 *    treat as a foreign daemon.
 *
 * So the identity is SEEDED, not minted: the supervisor generates it, passes it
 * in the daemon's environment, and compares it to what the daemon echoes back.
 * That is mode-independent — same check on a local daemon, a sandboxed daemon,
 * or anything later — and it needs no shared filesystem.
 *
 * WHY AN ENVIRONMENT VARIABLE. Same reason as managed mode (src/config/managed.ts):
 * `lazy.toml` is untrusted input on a fleet host, so a repository must not be
 * able to claim an identity by committing a config key. The environment is out
 * of the repository's reach.
 *
 * NOT A SECRET, NOT A CREDENTIAL. It authenticates nothing and grants nothing —
 * `/daemon/status` is unauthenticated and echoes it to anyone who asks. It is a
 * nametag, and the supervisor is the only party that has anything to compare it
 * against. Do not start using it as a token.
 */

/** Seeds this daemon's project identity. Set by the fleet supervisor. */
export const PROJECT_INSTANCE_ENV = 'LAZY_PROJECT_INSTANCE_ID';

/**
 * Shape of an acceptable id: a bounded, printable, log-safe token.
 *
 * Deliberately narrow. The value lands in a JSON payload, in log lines and in a
 * supervisor's error text, so whitespace, control characters and unbounded
 * length are all excluded at the boundary rather than sanitised at each use.
 * A UUID — what LocalSupervisor and SandboxSupervisor both seed — fits easily.
 */
const VALID = /^[A-Za-z0-9._:-]{8,128}$/;

export class ProjectInstanceIdInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectInstanceIdInvalidError';
  }
}

/**
 * Read the seeded project instance id, or `undefined` when none was seeded.
 *
 * FAILS LOUD ON A BAD VALUE, silently on an absent one — the same split
 * `readFleetValues` makes. Unset means "nobody is supervising this daemon",
 * which is the ordinary single-user case and must stay free. Set-but-malformed
 * means a fleet supervisor tried to seed an identity and got it wrong; carrying
 * on would leave every later identity check failing with "not my daemon" and
 * nothing anywhere saying why.
 */
export function readProjectInstanceId(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = env[PROJECT_INSTANCE_ENV];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  // An explicitly empty value is "unset" spelled awkwardly — a shell exporting
  // an unset variable produces it. Treat it as absent rather than as an error.
  if (value === '') return undefined;
  if (!VALID.test(value)) {
    throw new ProjectInstanceIdInvalidError(
      `${PROJECT_INSTANCE_ENV} is not a valid project instance id: ${JSON.stringify(raw)}\n` +
        '  Expected 8-128 characters of [A-Za-z0-9._:-] (a UUID is the usual choice).\n' +
        '  This variable is set by the fleet supervisor that started this daemon.'
    );
  }
  return value;
}
