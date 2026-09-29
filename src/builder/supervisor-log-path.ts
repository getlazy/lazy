/**
 * Where the in-container builder supervisor writes its log: ONE fixed file per
 * builder id, so the daemon reading a dead builder's evidence copies exactly
 * that file out of the container (never a directory whose contents the
 * container chose). Launches without an 8-hex builder id (host-process, old
 * callers) keep a timestamped name nobody copies.
 */
export function builderSupervisorLogPath(builderId: string | undefined): string {
  return builderId && /^[0-9a-f]{8}$/.test(builderId)
    ? `/tmp/lazy-builder-${builderId}.log`
    : `/tmp/lazy-builder-${Date.now()}.log`;
}

/**
 * The HOST file a detached builder's supervisor log is bind-mounted from: one
 * per launch, in the member's launch dir on the project's persistent disk, so
 * the log survives the container's exit and the machine being replaced.
 */
export function builderSupervisorLogHostPath(launchDir: string, builderId: string): string {
  return `${launchDir}/supervisor-${builderId}.log`;
}
