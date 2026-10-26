/**
 * Constants shared by the two halves of an SSH service forward — the daemon
 * route (./service-forward.ts) and the in-container forwarder
 * (./service-forwarder.ts), which ships in the lazy-agent binary and so must
 * not import daemon code.
 */

/** Where the forwarder listens inside a member container. Off 127.0.0.1, so it never collides with the member's own servers. */
export const SERVICE_FORWARD_ADDR = '127.0.1.1';
/** The host name every bare-port service is reached by (`ssh -L 3000:services:3000`). */
export const SERVICES_HOST_ALIAS = 'services';
/** The daemon route a forwarder connects to. */
export const SERVICE_FORWARD_PATH = '/ssh-forward/ws';

/** The forwarder's environment, set per SSH connection. */
export const FORWARD_ENV = {
  url: 'LAZY_SSH_FORWARD_URL',
  token: 'LAZY_SSH_FORWARD_TOKEN',
  ports: 'LAZY_SSH_FORWARD_PORTS',
  hosts: 'LAZY_SSH_FORWARD_HOSTS',
} as const;
