/**
 * The docs site's navigation manifest: which section every `public-docs/` page
 * belongs to, in reading order.
 *
 * A page's place in the Diátaxis structure (tutorials, how-to guides,
 * reference, explanation) is decided HERE, not by its directory, so existing
 * pages keep their flat URLs. The strict build (`buildDocsSite({ strict })`)
 * fails when a page exists that this file does not list, or when this file lists
 * a page that does not exist — adding a page means adding its entry.
 *
 * Paths are `public-docs/`-relative with no `.md`. `''` is the site index.
 */

/** One page. `title` overrides the page's own first heading in the navigation. */
export interface NavPage {
  path: string;
  title?: string;
}

/**
 * Every page under a directory, sorted by path — for generated trees such as the
 * CLI reference, so a new page needs no edit here. A directory with no pages
 * yet expands to nothing.
 */
export interface NavDir {
  dir: string;
  /** Label shown above the expanded pages. */
  title: string;
}

/** A labelled sub-group inside a section (Reference › Configuration). */
export interface NavGroup {
  group: string;
  items: (NavPage | NavDir)[];
}

export type NavItem = NavPage | NavDir | NavGroup;

export interface NavSection {
  title: string;
  /** One line shown under the section heading on the index page. */
  intro: string;
  items: NavItem[];
}

/**
 * A page that moved. The generator writes a stub at `from` that sends the
 * reader to `to` (`new/path` or `new/path#anchor`); the source file is deleted.
 */
export interface NavRedirect {
  from: string;
  to: string;
}

export interface DocsNav {
  sections: NavSection[];
  redirects: NavRedirect[];
}

export const DOCS_NAV: DocsNav = {
  sections: [
    {
      title: 'Start here',
      intro: 'Where to begin: pick the tutorial for the surface you use.',
      items: [{ path: 'start-here' }, { path: '', title: 'Overview' }],
    },
    {
      title: 'Tutorials',
      intro: 'Step-by-step lessons for your first time with lazy.',
      items: [{ path: 'tutorials/dashboard' }, { path: 'getting-started' }, { path: 'tutorials/lazy-teams' }],
    },
    {
      title: 'How-to guides',
      intro: 'Recipes for a specific job, once you know the basics.',
      items: [
        { path: 'how-to/create-and-start-a-task' },
        { path: 'how-to/give-feedback' },
        { path: 'how-to/review-and-accept' },
        { path: 'how-to/use-a-builder' },
        { path: 'how-to/set-env-and-secrets' },
        { path: 'how-to/upgrade' },
        { path: 'how-to/back-up-and-restore' },
        { path: 'serve-ports' },
        { path: 'task-env' },
        { path: 'lazy-teams-environment' },
        { path: 'upgrade-image-rebuild' },
        { path: 'store-backups' },
        { path: 'link' },
        { path: 'renaming-tasks' },
        { path: 'comparing-runs' },
        { path: 'pairing' },
        { path: 'conversation-import' },
        { path: 'teams-login' },
        { path: 'teams-bound-clone-agents' },
        { path: 'self-hosting-lazy-teams' },
        { path: 'deploying-lazy-teams-digitalocean' },
        { path: 'lazy-teams-setup' },
        { path: 'slack-rooms' },
        { path: 'pi-agent' },
        { path: 'troubleshooting' },
      ],
    },
    {
      title: 'Reference',
      intro: 'Exact descriptions of commands, screens, tools and settings.',
      items: [
        { dir: 'reference/dashboard', title: 'Dashboard' },
        { dir: 'reference/cli', title: 'CLI' },
        { dir: 'reference/teams', title: 'Lazy Teams' },
        {
          group: 'Configuration',
          items: [{ path: 'lazy-toml' }, { path: 'managed-config' }, { path: 'lazy-md' }],
        },
        { path: 'mcp-tools' },
        { path: 'surface-asymmetries' },
        { path: 'search' },
        { path: 'artifacts' },
        { path: 'turn-reports' },
        { path: 'review' },
        { path: 'web-review' },
        { path: 'web-shell' },
        { path: 'review-regions' },
        { path: 'system-messages' },
        { path: 'memory' },
        { path: 'token-budgets' },
        { path: 'proxy-plugins' },
        { path: 'playground' },
        { path: 'builder-scratch-dir' },
      ],
    },
    {
      title: 'Explanation',
      intro: 'The concepts behind lazy, explained once.',
      items: [
        { path: 'explanation/tasks-and-turns' },
        { path: 'cluster-tasks' },
        { path: 'explanation/review-and-accept' },
        { path: 'review-paradigm' },
        { path: 'low-high-loop' },
        { path: 'accept-check' },
        { path: 'protected-branches' },
        { path: 'raised-items' },
        { path: 'explanation/the-builder' },
        { path: 'explanation/daemon-and-proxy' },
        { path: 'proxy-jit-credentials' },
        { path: 'agent-container' },
        { path: 'identity' },
        { path: 'credentials' },
        { path: 'explanation/lazy-teams' },
        { path: 'lazy-teams-agents' },
        { path: 'lazy-teams-builders' },
        { path: 'lazy-teams-task-review' },
        { path: 'resurrection-guard' },
        { path: 'lfs-guard' },
      ],
    },
    {
      title: 'Architecture',
      intro: 'How the parts of lazy fit together.',
      items: [
        { path: 'architecture/index' },
        { path: 'architecture/what-runs-where' },
        { path: 'architecture/agents-and-proxy' },
        { path: 'architecture/forges' },
        { path: 'architecture/daemon-and-state' },
        { path: 'architecture/tasks-in-git' },
        { path: 'state-machine' },
      ],
    },
  ],
  redirects: [
    { from: 'lazy-agent-design', to: 'architecture/index' },
    { from: 'lazy-report-example-20260523', to: 'reference/cli/report' },
    { from: 'legacy-mcp-config-purge', to: 'credentials' },
  ],
};
