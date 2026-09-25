/**
 * Teach a client process where the dashboard answers, so it can print the NAME
 * form of a task service URL (`http://web.my-task.lazy.localhost:26024`).
 *
 * That URL is only composable by something that knows the dashboard's host and
 * port, because the proxy serving it rides the dashboard's listener. Inside the
 * daemon that is known at bind time and set once (src/daemon/server.ts). Any
 * other process has to ask, which is what this does — once, cheaply, and never
 * fatally: when the daemon is down or too old to report its port, the authority
 * stays null and every surface falls back to the direct `127.0.0.1:<port>` URL
 * it printed before. A stopped daemon means the proxy is not answering anyway,
 * so the direct URL is also the more useful of the two right then.
 */

import { checkDaemonHealth } from '../daemon/lifecycle';
import { dashboardHostFor } from '../daemon/dashboard-url';
import { setDashboardAuthority } from '../serve/subdomain';

/**
 * Set the process-wide dashboard authority from the running daemon, if there is
 * one. Safe to call from any command; safe to call more than once.
 */
export async function primeDashboardAuthority(projectRoot: string): Promise<void> {
  try {
    const status = await checkDaemonHealth(projectRoot);
    if (!status.running || !status.webPort) return;
    setDashboardAuthority(`${dashboardHostFor(status.bindHost)}:${status.webPort}`);
  } catch (err) {
    // Deliberately swallowed, and the only place in this feature where that is
    // right: this is a display nicety layered on top of an answer the command
    // already has. Failing `lazy url` because a health probe timed out would
    // trade a working URL for no URL. checkDaemonHealth is itself bounded and
    // catches its own transport errors, so reaching here at all means something
    // unforeseen — the authority stays null and the direct URL is printed.
    void err;
  }
}
