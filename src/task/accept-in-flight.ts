/**
 * Task metadata naming the status an accept's merge phase started from, set
 * for as long as that accept is in flight (see src/daemon/stranded-merge.ts).
 * Lives here, outside the daemon, because storage reads it too: its read-path
 * self-heal must leave a task with a live accept to that accept.
 */
export const ACCEPT_IN_FLIGHT_KEY = 'accept_in_flight_from';
