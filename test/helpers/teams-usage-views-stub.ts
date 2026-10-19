/**
 * The stand-in for `Api::Cli::UsageViewsController`: `usagePause`,
 * `usageLimits` and `tokenBudget` are not relayed on the member's token (the
 * daemon refuses it) — Rails asks as the CONTROL plane and answers with the
 * view narrowed to the member, in the daemon's own shape. This mirrors the
 * action list, the body keys and the narrowing rule of that controller and of
 * `ReadsUsagePause#narrow` / `ReadsTokenBudget#narrow`; the Rails suite owns
 * proving the real thing.
 */

export const USAGE_VIEW_COMMANDS = new Set(['usagePause', 'usageLimits', 'tokenBudget']);

const SERVICE_CREDENTIAL = 'user:__service__';
const MEMBER_ENDPOINT_PREFIX = 'credential:member-endpoint:';
const USAGE_PAUSE_ACTIONS = new Set(['get', 'admitInteractive', 'admitOneshot']);
const USAGE_PAUSE_KEYS = new Set([
  'action', 'taskId', 'agentId', 'beside', 'surface', 'peek', 'overrideUsagePause', 'usagePauseOverrideEligible', 'actor',
]);
const ACTOR_ROLES = new Set(['human', 'builder', 'agent', 'system', 'supervisor']);
const MEMBER_STORE_ERROR =
  "saved usage readings unreadable on this project's daemon: pausing cannot engage, and lazy refuses every " +
  'launch the pause would judge until a site administrator moves the file aside or restores it.';

export interface UsageViewsOptions {
  daemonTarget: () => string;
  /** The daemon's control token (what Rails holds) — the member's own token is refused these commands. */
  controlToken: () => string;
  projectRoot: string;
  memberEmail: string;
}

type Json = Record<string, any>;

export async function answerUsageView(
  command: string, params: Json, opts: UsageViewsOptions,
): Promise<Response> {
  const own = (credential: string) => {
    if (credential.startsWith(MEMBER_ENDPOINT_PREFIX)) {
      try {
        const member = JSON.parse(credential.slice(MEMBER_ENDPOINT_PREFIX.length))[0];
        return typeof member === 'string' && member.trim().toLowerCase() === opts.memberEmail.trim().toLowerCase();
      } catch {
        return false; // an unreadable owner is hidden, as in Rails
      }
    }
    return !credential.startsWith('user:') || credential === SERVICE_CREDENTIAL || credential === `user:${opts.memberEmail}`;
  };
  const ask = async (cmd: string, body: Json): Promise<Response | Json> => {
    const reply = await fetch(`${opts.daemonTarget()}/rpc/${cmd}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.controlToken()}`,
        'X-Lazy-Project': opts.projectRoot,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!reply.ok) {
      // As Rails does: a refusal over unreadable saved readings must not carry the file's path.
      const text = (await reply.text()).replace(
        /saved usage readings unreadable at .*?may be over the threshold\.(?: \(.*\))?/gs,
        'saved usage readings unreadable on this project\'s daemon: pausing cannot engage, and lazy refuses every launch the pause would judge until a site administrator moves the file aside or restores it.',
      );
      return new Response(text, {
        status: reply.status, headers: { 'Content-Type': reply.headers.get('content-type') ?? 'application/json' },
      });
    }
    return (await reply.json()) as Json;
  };

  if (command === 'usageLimits' || command === 'tokenBudget') {
    const extra = Object.keys(params);
    if (extra.length > 0) return refuse(command, extra);
    const state = await ask(command, {});
    if (state instanceof Response) return state;
    if (command === 'usageLimits') {
      return Response.json({ readings: (state.readings ?? []).filter((r: Json) => own(String(r.credential))) });
    }
    return Response.json({
      ...state,
      credentials: (state.credentials ?? []).filter((c: Json) => own(String(c.credential))),
    });
  }

  const action = params.action ?? 'get';
  if (!USAGE_PAUSE_ACTIONS.has(action)) {
    return Response.json(
      { error: `'usagePause' cannot take action ${JSON.stringify(action)} from a clone logged in to Lazy Teams.` },
      { status: 403 },
    );
  }
  const extra = Object.keys(params).filter((k) => !USAGE_PAUSE_KEYS.has(k));
  if (extra.length > 0) return refuse(command, extra);

  const sent: Json = { ...params };
  delete sent.actor;
  if ('actor' in params || params.beside || String(action).startsWith('admit')) {
    const role = ACTOR_ROLES.has(params.actor) ? params.actor : 'builder';
    sent.actor = { role, email: opts.memberEmail };
  }
  if (params.taskId) sent.ownerEmail = opts.memberEmail;
  const state = await ask('usagePause', sent);
  if (state instanceof Response) return state;
  return Response.json(narrowPause(state, own));
}

function refuse(command: string, extra: string[]): Response {
  return Response.json(
    { error: `'${command}' cannot carry ${extra.map((k) => JSON.stringify(k)).join(', ')} from a clone logged in to Lazy Teams.` },
    { status: 403 },
  );
}

function narrowPause(state: Json, own: (credential: string) => boolean): Json {
  const verdict = (v: Json) => (v?.storeError ? { ...v, storeError: MEMBER_STORE_ERROR } : v);
  const out: Json = { ...state, override: null, overrideSetAt: null };
  out.paused = (state.paused ?? []).filter((v: Json) => own(String(v.credential))).map(verdict);
  out.held = (state.held ?? []).filter((h: Json) => own(String(h.hold?.credential)));
  out.coverage = (state.coverage ?? []).filter((c: Json) => own(String(c.credential)));
  if (state.storeError) out.storeError = { path: null, message: MEMBER_STORE_ERROR };
  if (state.configured) {
    out.configured = {
      ...state.configured,
      credentials: Object.fromEntries(
        Object.entries(state.configured.credentials ?? {}).filter(([c]) => own(c)),
      ),
    };
  }
  for (const key of ['task', 'beside']) {
    if (state[key]?.verdict) out[key] = { ...state[key], verdict: verdict(state[key].verdict) };
  }
  return out;
}
