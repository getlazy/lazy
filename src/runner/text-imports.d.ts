/**
 * Type declarations for Bun text imports of shell scripts.
 *
 * The boundary guard embeds `scripts/host-sandbox-probe.sh` as text so the
 * compiled binary carries the same evidence script CI runs — one definition of
 * the boundary, not a TypeScript reimplementation free to drift from it.
 */
declare module '*.sh' {
  const content: string;
  export default content;
}
