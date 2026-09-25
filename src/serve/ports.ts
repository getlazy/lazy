/**
 * `[serve]` — the ports a task's environment needs reachable from the host.
 *
 * The config names CONTAINER-SIDE facts (a service name and the port it listens
 * on inside the task environment), never runtime flags. That is deliberate: the
 * same declaration has to keep meaning when the task environment is a podman
 * container, a per-project VM, or a microVM sandbox. Only `buildPublishArgs`
 * knows that today's vehicle happens to be `docker run -p`.
 *
 * Two spellings, one list:
 *
 *   [serve]
 *   ports = [3000, 5173]        # identity is the port itself
 *
 *   [serve.services]
 *   web = 3000                  # identity is the name
 *   api = 8080
 *
 * `ports` is the zero-ceremony case — one line, no names to invent, and
 * `lazy url <task> 3000` already reads fine. `[serve.services]` is for the task
 * that runs several things and where "the 8080 one" stops being a name anyone
 * remembers. Both fill the same `ServicePort[]`, so everything downstream —
 * publishing, discovery, `lazy url` — sees one list either way, and a project
 * can start with `ports` and grow names later without relearning anything.
 *
 * Host binding is always `127.0.0.1:0`: loopback so a task never exposes a
 * service to the network (matching the daemon's own bind posture), and port 0
 * so the OS assigns a free host port — parallel tasks declaring the same
 * container port can never collide. The runtime is therefore the only source of
 * truth for the actual host port, which is why discovery reads it back
 * (`parsePortBindings`) instead of computing it.
 */

/** One declared service: a name and the port it listens on inside the task environment. */
export interface ServicePort {
  /** Human-meaningful identity. For a bare `ports` entry this is the port as a string. */
  name: string;
  /** Port the service listens on INSIDE the task environment. */
  port: number;
}

/** A live host↔environment port mapping, read back from the runtime. */
export interface PortBinding {
  /** Port inside the task environment. */
  containerPort: number;
  /** Host address the port is published on (always loopback for lazy). */
  hostAddress: string;
  /** Ephemeral host port the runtime assigned. */
  hostPort: number;
}

/** A declared service resolved against the live bindings. */
export interface ResolvedService extends ServicePort {
  /** The live binding, or null when the environment does not publish this port. */
  binding: PortBinding | null;
  /** `http://127.0.0.1:<hostPort>`, or null when unpublished. */
  url: string | null;
  /**
   * `http://<service>.<task>.lazy.localhost:<dashboard-port>` — the name the
   * daemon's reverse proxy answers on, or null when there is no proxy to route
   * through (nothing published, or a process that does not know where the
   * dashboard is; see src/serve/subdomain.ts).
   *
   * ADDED alongside `url`, never replacing it: `url` stays the raw host-side
   * mapping, which is what a script needs (`lazy url --direct`) and what the
   * lazy-teams UI composes with its own VM→host hop before showing anything.
   * Absent on a state that was never decorated — treat it as null.
   */
  publicUrl?: string | null;
}

/** Host address lazy publishes on. Loopback only — never `0.0.0.0`. */
export const SERVE_BIND_HOST = '127.0.0.1';

const MAX_PORT = 65535;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function assertValidPort(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(
      `${where}: port must be an integer, got ${JSON.stringify(value)}. ` +
      `Declare the port the service listens on inside the task environment, e.g. 3000.`,
    );
  }
  if (value < 1 || value > MAX_PORT) {
    throw new Error(`${where}: port ${value} is out of range — must be between 1 and ${MAX_PORT}.`);
  }
  return value;
}

/**
 * Resolve `[serve]` into the flat list of services, validating as it goes.
 *
 * Throws with an actionable message on anything malformed — a bad `[serve]`
 * block is a typo in the user's config, and the alternative to failing here is
 * a task that silently starts with no ports published and no explanation.
 */
export function resolveServicePorts(serve: ServeConfigInput | undefined): ServicePort[] {
  if (!serve) return [];

  const services: ServicePort[] = [];
  /** container port → the name that already claimed it, for the collision error. */
  const seenPorts = new Map<number, string>();

  const claim = (name: string, port: number, where: string) => {
    const owner = seenPorts.get(port);
    if (owner !== undefined) {
      throw new Error(
        `${where}: port ${port} is declared twice (already declared as "${owner}"). ` +
        `Each port may be declared once — remove the duplicate.`,
      );
    }
    seenPorts.set(port, name);
    services.push({ name, port });
  };

  if (serve.ports !== undefined) {
    if (!Array.isArray(serve.ports)) {
      throw new Error(
        `lazy.toml [serve] ports: must be an array of port numbers, e.g. ports = [3000, 5173].`,
      );
    }
    serve.ports.forEach((raw, index) => {
      const where = `lazy.toml [serve] ports entry #${index + 1}`;
      const port = assertValidPort(raw, where);
      claim(String(port), port, where);
    });
  }

  if (serve.services !== undefined) {
    if (typeof serve.services !== 'object' || serve.services === null || Array.isArray(serve.services)) {
      throw new Error(
        `lazy.toml [serve.services]: must be a table of name = port, e.g.\n` +
        `  [serve.services]\n  web = 3000\n  api = 8080`,
      );
    }
    for (const [name, raw] of Object.entries(serve.services)) {
      const where = `lazy.toml [serve.services] "${name}"`;
      if (!NAME_PATTERN.test(name)) {
        // An all-digit name would be indistinguishable from a port in
        // `lazy url <task> <name-or-port>`, and that lookup has to stay
        // unambiguous — so names start with a letter, full stop.
        throw new Error(
          `${where}: invalid service name. Names must start with a letter and contain only ` +
          `letters, digits, "_" or "-" (a name that looks like a number would be ambiguous ` +
          `with a port in \`lazy url <task> <name-or-port>\`).`,
        );
      }
      claim(name, assertValidPort(raw, where), where);
    }
  }

  return services;
}

/** The `[serve]` shape as it comes out of lazy.toml, before validation. */
export interface ServeConfigInput {
  ports?: unknown;
  services?: unknown;
  start_services_cmd?: unknown;
}

/**
 * Validate `[serve] start_services_cmd` — the command that brings the project's
 * services up inside a task's environment (`bin/dev`, `npm run dev`, …).
 *
 * Optional; empty string when unset. A present-but-blank or non-string value is
 * a typo in the user's config and fails loud: the alternative is a "Start
 * services" button that runs nothing and reports success.
 */
/**
 * The one rule for a Start services command, whatever surface it came from:
 * after trim it must be non-empty and a single line (no newline or other C0
 * control except tab). Returns the problem, or null when `trimmed` is valid.
 * Each surface words its own error around this.
 */
export function startServicesCmdProblem(trimmed: string): 'empty' | 'multiline' | null {
  if (trimmed === '') return 'empty';
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(trimmed)) return 'multiline';
  return null;
}

export function resolveStartServicesCmd(serve: ServeConfigInput | undefined): string {
  const raw = serve?.start_services_cmd;
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new Error(
      `lazy.toml [serve] start_services_cmd: must be a string, got ${JSON.stringify(raw)}. ` +
      `Give the command that starts your services inside the task environment, e.g. ` +
      `start_services_cmd = "bin/dev".`,
    );
  }
  const command = raw.trim();
  const problem = startServicesCmdProblem(command);
  if (problem === 'empty') {
    throw new Error(
      `lazy.toml [serve] start_services_cmd: must not be empty. ` +
      `Either give a command (e.g. start_services_cmd = "npm run dev") or remove the key.`,
    );
  }
  // A start command is one line. Newlines and other C0 controls (except tab)
  // used to be written as an unescaped TOML basic string, which closed the
  // quotes and made the rest of lazy.toml unreadable. Reject them here so
  // load and the dashboard write path stay one validator.
  if (problem === 'multiline') {
    throw new Error(
      `lazy.toml [serve] start_services_cmd: must be a single line. ` +
      `Newlines and other control characters cannot be saved — they would make ` +
      `the config file unreadable, or run as a multi-line shell script. ` +
      `Paste one command, e.g. start_services_cmd = "bin/dev".`,
    );
  }
  return command;
}

/**
 * `docker run` arguments that publish the declared ports.
 *
 * `-p 127.0.0.1:0:<port>` per service: loopback-only, OS-assigned host port.
 * Empty for a project with no `[serve]` section, so the launch argv of every
 * existing task is byte-identical to before.
 *
 * NOTE: a container's published ports are fixed when it is CREATED — neither
 * docker nor podman can add a mapping to a running container. Editing `[serve]`
 * therefore takes effect the next time the task's container is created.
 */
export function buildPublishArgs(services: ServicePort[]): string[] {
  const args: string[] = [];
  // Two names for one port are one binding, not two: dedupe defensively even
  // though resolveServicePorts already rejects duplicate ports.
  const seen = new Set<number>();
  for (const service of services) {
    if (seen.has(service.port)) continue;
    seen.add(service.port);
    args.push('-p', `${SERVE_BIND_HOST}:0:${service.port}`);
  }
  return args;
}

/**
 * Parse `docker port <container>` output into live bindings.
 *
 * Lines look like `3000/tcp -> 127.0.0.1:49154`. Unparsable lines and non-tcp
 * protocols are skipped rather than throwing: this is discovery of someone
 * else's output format, and one odd line must not take down `lazy url`.
 */
export function parsePortBindings(output: string): PortBinding[] {
  const bindings: PortBinding[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)(?:\/(\w+))?\s*->\s*(.+):(\d+)$/.exec(trimmed);
    if (!match) continue;
    const [, containerPort, proto, hostAddress, hostPort] = match;
    if (proto && proto !== 'tcp') continue;
    bindings.push({
      containerPort: Number(containerPort),
      hostAddress,
      hostPort: Number(hostPort),
    });
  }
  return bindings;
}

/** `http://127.0.0.1:<port>` for a binding. IPv6 host addresses are bracketed. */
export function urlForBinding(binding: PortBinding): string {
  const host = binding.hostAddress.includes(':') ? `[${binding.hostAddress}]` : binding.hostAddress;
  return `http://${host}:${binding.hostPort}`;
}

/** Join declared services with live bindings, preserving declaration order. */
export function resolveServices(services: ServicePort[], bindings: PortBinding[]): ResolvedService[] {
  const byPort = new Map(bindings.map(b => [b.containerPort, b]));
  return services.map(service => {
    const binding = byPort.get(service.port) ?? null;
    return { ...service, binding, url: binding ? urlForBinding(binding) : null };
  });
}

/**
 * Look up one service by name or by container port.
 *
 * Name match is exact and case-insensitive; a purely numeric query is also
 * matched against container ports (which is how a bare `ports = [3000]` entry
 * is addressed). Returns null when nothing matches — the caller owns the error
 * message, because it knows what else to list.
 */
export function findService(services: ResolvedService[], query: string): ResolvedService | null {
  const needle = query.trim();
  const byName = services.find(s => s.name.toLowerCase() === needle.toLowerCase());
  if (byName) return byName;
  if (/^\d+$/.test(needle)) {
    const port = Number(needle);
    return services.find(s => s.port === port) ?? null;
  }
  return null;
}
