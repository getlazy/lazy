/**
 * The client half of the device-authorization exchange (design doc §4.2).
 *
 * WHY DEVICE AUTHORIZATION. A pasted token is a secret in a shell history and on
 * a screen share; a local callback server assumes the browser is on the machine
 * running the command, which is exactly what a remote client is not. So the CLI
 * prints a code that authorizes nothing, and polls. The human approves it in a
 * browser that is already authenticated — on whatever machine their browser
 * happens to be on — and only then does a credential exist.
 *
 * Every response is PARSED AND CONFIRMED here rather than trusted: this is an
 * external surface, and the thing on the other end of the URL is whatever the
 * user typed. A server that answers 200 with something else must fail with a
 * message naming the address, not with a `TypeError` five lines later. That
 * includes VALUES and not only types: the two timings the server chooses are
 * clamped to a sane range before anything acts on them (see below).
 */

export interface DeviceCodeGrant {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds between polls, as the server asked. */
  interval: number;
  /** Seconds until the code stops being approvable. */
  expiresIn: number;
}

export interface TeamsProject {
  id: string;
  /** `team/project` — what `--project` takes and what the binding records. */
  slug: string;
  name: string;
  team: string;
}

/** A request to the Teams install failed in a way the user must see. */
export class TeamsRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TeamsRequestError';
  }
}

type Fetcher = typeof fetch;

/** Seconds a poll loop keeps going if the server never said how long it has. */
const FALLBACK_EXPIRES_IN = 900;

/**
 * Bounds on the two numbers the server gets to choose.
 *
 * Confirming the TYPE is not confirming the VALUE: `expires_in: 999999999` is a
 * number, and taking it at face value made `lazy login` sit in a polling loop
 * essentially forever while telling the person their code expired in sixteen
 * million minutes. An interval of 0.001 is the same problem pointed the other
 * way. Clamp, and print the clamped figure so the message and the behaviour
 * agree.
 */
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 60;
const MAX_EXPIRES_IN = 3600;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function readInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 5;
  return clamp(value, MIN_INTERVAL, MAX_INTERVAL);
}

function readExpiresIn(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return FALLBACK_EXPIRES_IN;
  return clamp(value, MIN_INTERVAL, MAX_EXPIRES_IN);
}

async function readJson(response: Response, url: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    // The usual cause is an address that is a web server but not a Teams
    // install — a proxy's error page, a landing page, a 404 in HTML. Say what
    // was asked and what came back rather than "unexpected token < in JSON".
    throw new TeamsRequestError(
      `${url} answered ${response.status} with something that is not JSON. ` +
      `Check the address — it should be the root of a Lazy Teams install, ` +
      `e.g. https://teams.example.com`,
      response.status,
    );
  }
}

function requireString(body: Record<string, unknown>, key: string, url: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TeamsRequestError(
      `${url} answered without a '${key}'. That address does not look like a Lazy Teams install.`,
    );
  }
  return value;
}

/** Step 1: ask the install to start a login for this machine. */
export async function requestDeviceCode(
  teamsUrl: string,
  deviceName: string,
  fetcher: Fetcher = fetch,
): Promise<DeviceCodeGrant> {
  const url = `${teamsUrl}/api/cli/device/code`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_name: deviceName }),
    });
  } catch (err) {
    throw new TeamsRequestError(
      `Could not reach ${teamsUrl}: ${err instanceof Error ? err.message : String(err)}\n` +
      `Check the address and that you can reach the install from this machine.`,
    );
  }

  if (!response.ok) {
    throw new TeamsRequestError(
      `${teamsUrl} refused to start a login (HTTP ${response.status}). ` +
      `Check the address, and that the install is running a version of Lazy Teams ` +
      `that supports \`lazy login\`.`,
      response.status,
    );
  }

  const body = await readJson(response, url);
  const interval = readInterval(body.interval);
  const expiresIn = readExpiresIn(body.expires_in);

  return {
    userCode: requireString(body, 'user_code', url),
    deviceCode: requireString(body, 'device_code', url),
    verificationUri: requireString(body, 'verification_uri', url),
    verificationUriComplete:
      typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
    interval,
    expiresIn,
  };
}

export type PollOutcome =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'approved'; token: string; email: string }
  | { status: 'refused'; reason: string };

/** Step 2, once: has a human approved it yet? */
export async function pollDeviceToken(
  teamsUrl: string,
  deviceCode: string,
  fetcher: Fetcher = fetch,
): Promise<PollOutcome> {
  const url = `${teamsUrl}/api/cli/device/token`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
  } catch (err) {
    // A poll runs for minutes; one blip must not end a login the human is
    // halfway through approving. Treated as "not yet" and retried by the loop.
    return { status: 'pending' };
  }

  // A 5xx is infrastructure, not an answer: a proxy or load balancer restarting
  // in front of the install returns one, usually with an HTML body. Treated as
  // "not yet", exactly like the dropped connection above — the hard failure on a
  // non-Teams address belongs to `requestDeviceCode`, where it is the correct
  // diagnosis. Here it is both wrong and fatal, and can land AFTER the human has
  // clicked Approve: the token exists, the record sits approved-but-uncollected,
  // and the person is told to check their address.
  if (response.status >= 500) return { status: 'pending' };

  let body: Record<string, unknown>;
  try {
    body = await readJson(response, url);
  } catch {
    // Same reasoning for a body that is not JSON at all. The loop's own deadline
    // ends the login if this never clears.
    return { status: 'pending' };
  }
  const status = typeof body.status === 'string' ? body.status : '';

  if (status === 'approved') {
    const token = requireString(body, 'token', url);
    const user = body.user;
    const email =
      user && typeof user === 'object' && typeof (user as { email?: unknown }).email === 'string'
        ? (user as { email: string }).email
        : 'your account';
    return { status: 'approved', token, email };
  }

  if (status === 'slow_down') {
    return { status: 'slow_down', interval: readInterval(body.interval) };
  }

  if (status === 'pending') return { status: 'pending' };

  // denied / expired / completed / unknown — each is a dead end with a
  // different remedy, and the server's own sentence is the one that says which.
  const reason = typeof body.error === 'string' && body.error
    ? body.error
    : `The login request was refused (${status || `HTTP ${response.status}`}).`;
  return { status: 'refused', reason };
}

/** Step 5: which projects may this member bind a clone to? */
export async function fetchProjects(
  teamsUrl: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<TeamsProject[]> {
  const url = `${teamsUrl}/api/cli/projects`;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new TeamsRequestError(
      `Could not reach ${teamsUrl} to list your projects: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await readJson(response, url).catch(() => ({} as Record<string, unknown>));
    const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new TeamsRequestError(`${teamsUrl} refused to list your projects: ${detail}`, response.status);
  }

  const body = await readJson(response, url);
  const raw = body.projects;
  if (!Array.isArray(raw)) {
    throw new TeamsRequestError(`${url} answered without a project list.`);
  }

  return raw.map((item) => {
    const project = (item ?? {}) as Record<string, unknown>;
    const slug = typeof project.slug === 'string' ? project.slug : '';
    const id = typeof project.id === 'string' ? project.id : String(project.id ?? '');
    if (!slug || !id) {
      throw new TeamsRequestError(`${url} answered with a project that has no slug or id.`);
    }
    return {
      id,
      slug,
      name: typeof project.name === 'string' ? project.name : slug,
      team: typeof project.team === 'string' ? project.team : '',
    };
  });
}
