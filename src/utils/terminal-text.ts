/** Terminal control sequences (a TTY run's output) and stray control bytes. */
// eslint-disable-next-line no-control-regex
export const TERMINAL_CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * The last `maxLines` lines of TTY output that still say something once the
 * control sequences are gone. A program that repaints or restores the screen
 * as it exits leaves its final lines as pure escape codes, so a raw tail can
 * strip to nothing while the error printed just before it is right there.
 */
export function printableTail(raw: string, maxLines: number): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(TERMINAL_CONTROL, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-maxLines)
    .join('\n');
}
