/**
 * The "Services" card: which `[serve]` services a task declares, where each is
 * reachable on this machine, whether anything is actually listening, and the
 * `lazy url` command that answers the same question from a terminal.
 *
 * ONE renderer for the review page and the task detail page, so the two
 * surfaces can never disagree about what a task is serving — the same rule
 * `lazy show` and the dashboard's Serving row already follow. Liveness comes
 * from src/serve/probe.ts (bare TCP connect, closed on connect, no bytes), the
 * same probe `lazy url` and the daemon's `servePorts` RPC use; the caller runs
 * it server-side at render and hands the probed state in.
 *
 * The card renders in EVERY state, including "declares no services": an absent
 * card would leave the reviewer wondering whether the task serves nothing or
 * the page just failed to say. The one exception is a null state — the serve
 * config could not be read at all — where saying nothing beats guessing.
 */

import type { TaskServeState } from '../serve/discovery';
import type { ProbedService } from '../serve/probe';
import type { BranchServeAdvice } from '../serve/branch-advice';
import { displayUrlFor } from '../serve/subdomain';
import { viewedCardHtml } from './viewed-cards';
import { startContainerHtml, type ContainerControls } from './container-start';
import { escapeHtml } from './escape';

/**
 * What the page can offer alongside the service list. Optional everywhere: a
 * caller with no action port (a Storage-only handler, most unit tests) renders
 * the same card minus the buttons.
 */
export interface ServicesCardControls extends ContainerControls {
  /** The task these buttons act on — the form target and the shell panel's id. */
  taskId: string;
  /**
   * The project's Start services command from the store (lazy.toml's
   * `[serve] start_services_cmd` only as a one-time import), or '' when unset.
   * Never a task worktree's value: a branch is agent-writable and must never
   * decide what a human's click runs.
   */
  startServicesCmd: string;
  /** True when the shell panel on this page can actually take the command. */
  shellAvailable: boolean;
  /**
   * True when the dashboard can persist a designation (ServeActions port is
   * wired). Without it the form is hidden — a button that 503s is noise.
   */
  canDesignate: boolean;
}

/** A serve state whose services have been through the liveness probe. */
export interface ProbedServeState extends Omit<TaskServeState, 'services'> {
  services: ProbedService[];
}

/**
 * Widen a plain serve state to a probed one. Services that already carry a
 * probe result keep it (the spread preserves a runtime `listening`); services
 * that were never probed read as `listening: null`. Lets a caller that only
 * has resolution (no probe ran) still render the card honestly.
 */
export function toProbedState(serve: TaskServeState): ProbedServeState {
  return {
    ...serve,
    services: serve.services.map((s) => ({ listening: null, ...s } as ProbedService)),
  };
}

/** Green/grey liveness dot. `null` = the probe could not be attempted. */
function dotHtml(listening: boolean | null, titleOverride?: string): string {
  const cls = listening === true ? 'svc-dot-on' : listening === false ? 'svc-dot-off' : 'svc-dot-unknown';
  const title = titleOverride ?? (listening === true
    ? 'Listening — a TCP connect to the published port succeeds'
    : listening === false
      ? 'Nothing listening on the published port'
      : 'Not probed — the port has no live binding');
  return `<span class="svc-dot ${cls}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
}

/** The copyable `lazy url <task> <service>` command with its copy button. */
function commandHtml(taskRef: string, serviceName: string): string {
  const cmd = `lazy url ${taskRef} ${serviceName}`;
  return `<span class="svc-cmd"><code>${escapeHtml(cmd)}</code>` +
    // Hidden until the island unhides it: copy needs the clipboard API, and
    // with JS off the selectable <code> IS the fallback.
    `<button type="button" class="svc-copy" data-svc-copy="${escapeHtml(cmd)}" hidden>Copy</button></span>`;
}

/**
 * The card body for one probed serve state. Exported for tests; pages go
 * through {@link servicesCardHtml}.
 */
export function servicesBodyHtml(
  taskRef: string,
  serve: ProbedServeState,
  controls?: ServicesCardControls,
): string {
  // Start services + designate ride every card state: starting the command
  // only needs a shell (which brings the container up itself), and designating
  // the project-wide command does not depend on ports being published.
  const actions = `${startServicesHtml(controls)}${designateStartCmdHtml(controls)}`;

  if (serve.declared.length === 0) {
    return `<p class="rv-hint">This task declares no services. Declare the ports it serves in ` +
      `lazy.toml — <code>[serve]</code> <code>ports = [3000]</code> or <code>[serve.services]</code> — ` +
      `and restart the task to publish them.</p>` +
      actions;
  }

  if (serve.unavailable === 'no-container-runner') {
    return `<p class="rv-hint">${escapeHtml(serve.runnerType)} runner — services share this machine's ` +
      `network, so anything the task starts is already on <code>http://127.0.0.1:&lt;port&gt;</code>. ` +
      `There is no container mapping to look up.</p>` +
      actions;
  }

  if (serve.unavailable === 'not-running') {
    // ONE line for the whole card, not one per service. When the container is
    // down every service is down for the SAME reason, and repeating it per row
    // read as a list of live services on a quick glance — which is exactly the
    // misreading this card exists to prevent. The remedy goes next to it.
    const names = serve.declared.map((s) => s.name).join(', ');
    return `<p class="svc-down">${dotHtml(false, 'Container not running — no ports are published')}` +
      `<span class="text-muted">` +
      `Container not running — nothing is published. ` +
      `${serve.declared.length} declared: ${escapeHtml(names)}.</span>` +
      (controls ? startContainerHtml(controls.taskId, controls) : '') +
      `</p>` +
      actions;
  }

  const rows = serve.services
    .map((s) => {
      let target: string;
      if (!s.url) {
        target = `<span class="text-muted">not published — restart the task to pick up [serve]</span>`;
      } else if (s.listening === false) {
        // Published, but the app is not up. NOT a link: the subdomain URL
        // would redirect a navigation straight back to this task's page with a
        // "nothing is listening" banner — and this card IS that page's answer,
        // with the start buttons already on it. The greyed text is the whole
        // point of running the probe server-side.
        target = `<span class="svc-dead">nothing listening on port ${s.port}</span>`;
      } else {
        // The subdomain name when the daemon is serving one, else the raw
        // mapping. Either way it is loopback-only by construction, so the link
        // is only ever clickable from the machine the task runs on — which is
        // the machine serving this page.
        const shown = displayUrlFor(s) ?? s.url;
        target = `<a href="${escapeHtml(shown)}">${escapeHtml(shown)}</a>`;
      }
      const cls = s.listening === true ? 'svc-row svc-up' : s.listening === false ? 'svc-row svc-off' : 'svc-row';
      return `<li class="${cls}">${dotHtml(s.listening)}` +
        `<span class="svc-name">${escapeHtml(s.name)}</span>${target}${commandHtml(taskRef, s.name)}</li>`;
    })
    .join('');

  return `<ul class="svc-list">${rows}</ul>${actions}`;
}

/**
 * The "Start services" button — shown only when the project has a
 * Start services command designated AND this page has a live shell to run it in.
 *
 * It runs the command in the SHELL panel over the shell's own PTY, but the
 * terminal itself mounts IN PLACE, in the empty slot right beneath this
 * button — the same `data-lz-shell-mount` pattern the How-to-verify Run
 * buttons use (`review-verify.ts`'s `codePanelHtml`). No tab switch either
 * way: the reader presses the button and watches the output right there on
 * the Services tab, rather than getting yanked to Shell and having to
 * navigate back. Sessions still show up in the Shell tab's index afterwards
 * (`shell-ui.ts`'s `refreshIndex`/`goToSession`) — a long-lived service
 * process is still reachable from there, "go to" now returns the reader to
 * this tab instead of a hardcoded one. Once a session is live, Start services
 * gives way to Open / Re-run (`shell-ui.ts`'s `setStepLive`, the same pair
 * Verify's Run buttons use) — a service you restart is a normal thing to want,
 * not a dead control once it has been pressed once.
 */
function startServicesHtml(controls?: ServicesCardControls): string {
  if (!controls?.startServicesCmd || !controls.shellAvailable) return '';
  const cmd = controls.startServicesCmd;
  return `<div class="svc-start" data-lz-shell-step>` +
    `<p class="svc-start-row">` +
    `<button type="button" class="btn btn-sm rv-cmd-run" data-lz-shell-run="${escapeHtml(cmd)}"` +
    ` data-lz-shell-for="${escapeHtml(controls.taskId)}" data-lz-shell-label="Services">Start services</button>` +
    `<button type="button" class="rv-cmd-open" hidden>Open</button>` +
    `<button type="button" class="rv-cmd-rerun" hidden>Re-run</button>` +
    `<code class="text-muted">${escapeHtml(cmd)}</code>` +
    `</p>` +
    `<div class="lz-shell-mount" data-lz-shell-mount data-lz-live-children hidden></div>` +
    `</div>`;
}

/**
 * Designate or change the project-wide Start services command.
 *
 * Empty state: the human types the command and saves it to the project's
 * store — never a per-task override, and never lazy.toml. Set state: the same
 * form pre-filled so they can change it. POST-only; the handler lives on
 * `/tasks/:id/services/start-cmd`. Hidden when the ServeActions port is absent
 * (a Storage-only dashboard cannot save it).
 */
function designateStartCmdHtml(controls?: ServicesCardControls): string {
  if (!controls?.canDesignate) return '';
  const cmd = controls.startServicesCmd;
  const hasCmd = cmd.length > 0;
  const heading = hasCmd
    ? 'Change the project-wide Start services command'
    : 'Designate the project-wide command that Start services will run';
  const hint = hasCmd
    ? 'Saved for the whole project — not a per-task override.'
    : 'This is the project-wide command Start services will run. It is saved for the ' +
      'whole project, not a per-task override.';
  const submit = hasCmd ? 'Save' : 'Save command';
  return `<div class="svc-designate">` +
    `<p class="svc-designate-head">${heading}</p>` +
    `<p class="rv-hint">${hint}</p>` +
    `<form method="POST" action="/tasks/${escapeHtml(controls.taskId)}/services/start-cmd" ` +
    `class="svc-designate-form">` +
    `<label class="svc-designate-label" for="svc-start-cmd-${escapeHtml(controls.taskId)}">Command</label>` +
    `<input type="text" class="input" name="command" id="svc-start-cmd-${escapeHtml(controls.taskId)}" ` +
    `value="${escapeHtml(cmd)}" placeholder="bin/dev" required autocomplete="off" spellcheck="false">` +
    `<button type="submit" class="btn btn-sm">${submit}</button>` +
    `</form>` +
    // Clear is its own POST form (never a GET, never nested in the designate
    // form), offered only when there is a command to clear.
    (hasCmd
      ? `<form method="POST" action="/tasks/${escapeHtml(controls.taskId)}/services/start-cmd/clear" ` +
        `class="svc-designate-clear">` +
        `<button type="submit" class="btn btn-sm">Clear command</button>` +
        `</form>`
      : '') +
    `</div>`;
}

/**
 * The Services card. `serve` is null when the state could not be resolved at
 * all (no project root, runner error) — the card then renders nothing rather
 * than a guess.
 */
export function servicesCardHtml(
  task: { id: string; code?: string | null },
  serve: ProbedServeState | null,
  controls?: ServicesCardControls,
): string {
  if (!serve) return '';
  const taskRef = task.code ?? task.id.substring(0, 8);
  const live = serve.services.filter((s) => s.listening === true).length;
  const summary = serve.declared.length === 0
    ? 'none declared'
    : serve.unavailable === 'not-running'
      // Say the state, not a count: "2 declared" next to a card whose services
      // are all unreachable is the reading the engineer flagged.
      ? 'container not running'
      : serve.unavailable
        ? `${serve.declared.length} declared`
        : `${live}/${serve.services.length} listening`;
  const bodyHtml = servicesBodyHtml(taskRef, serve, controls);
  return viewedCardHtml({
    key: 'services',
    // The tick clears when what the card SAYS changes — so it hashes the URL as
    // shown, not the mapping behind it. A subdomain name survives a container
    // recreate that moves the 127.0.0.1 port, and the card is then genuinely
    // unchanged. Liveness still flips as servers come and go.
    content: JSON.stringify({
      declared: serve.declared,
      unavailable: serve.unavailable,
      services: serve.services.map((s) => ({ name: s.name, url: displayUrlFor(s) ?? s.url, listening: s.listening })),
    }),
    headHtml: `<strong>Services</strong> <span class="rv-hint">${escapeHtml(summary)}</span>`,
    bodyHtml,
    sectionClass: 'svc-card',
    // A one-line status readout, not review material to work through.
    allowViewed: false,
    // No buttons, no script: a state with nothing to copy ships no dead JS.
  }) + (bodyHtml.includes('data-svc-copy') ? servicesCopyScript() : '');
}

/**
 * Advice for `[serve]` ports the task branch declared that the root does not.
 *
 * Read as data only — never as authority. The command is copyable text; we
 * never run it. Empty input renders nothing so a leaf with no branch extras
 * stays an honest empty Services tab rather than a heading over a blank list.
 */
export function branchServeAdviceHtml(advice: BranchServeAdvice[]): string {
  if (advice.length === 0) return '';
  const rows = advice.map((a) => {
    const cmd = a.command;
    return `<li class="lz-branch-advice-item">` +
      `<strong>${escapeHtml(a.name)}</strong> on port ${a.port}` +
      ` — this branch declared it; the project root does not, so the container does not publish it. ` +
      `<span class="svc-cmd"><code>${escapeHtml(cmd)}</code>` +
      `<button type="button" class="svc-copy" data-svc-copy="${escapeHtml(cmd)}" hidden>Copy</button></span>` +
      `</li>`;
  }).join('');
  return `<div class="lz-branch-advice">` +
    `<h3>Ports on this branch only</h3>` +
    `<p>A task worktree's lazy.toml does not govern the container. Reach these with <code>lazy forward</code> while the container is up:</p>` +
    `<ul>${rows}</ul>` +
    `</div>` +
    servicesCopyScript();
}

/**
 * The tiny island behind the copy buttons. Unhides them (JS is what makes them
 * work) and copies via the clipboard API, with a moment of "Copied" feedback.
 */
function servicesCopyScript(): string {
  return `<script>
(function () {
  var buttons = document.querySelectorAll('.svc-copy');
  if (!buttons.length || !navigator.clipboard) return;
  for (var i = 0; i < buttons.length; i++) buttons[i].hidden = false;
  // This can be emitted twice on one Services body (the main card and the
  // branch-advice block each carry their own copy of this island), and the
  // whole body re-runs on every data-lz-stale refetch (task-tabs.ts's
  // activateScripts) — either way, an un-guarded \`document.addEventListener\`
  // here adds another permanent listener on top of whichever ran before, so
  // one click flips the button text twice and it sticks on "Copied". One
  // listener for the whole page is all this ever needs: it re-derives the
  // clicked button from the event every time, nothing here is per-run state.
  //
  // window.lzOnce is a hard assumption here, not a feature check, but the
  // fallback below (not an \`if\`) is deliberate too — see the matching note
  // in changesViewScript (review-presentation.ts).
  (window.lzOnce || function (k, f) { f(); })('services-copy', function () {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.svc-copy') : null;
      if (!btn) return;
      navigator.clipboard.writeText(btn.getAttribute('data-svc-copy') || '').then(function () {
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
  });
})();
</script>`;
}
