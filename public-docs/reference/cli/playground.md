# lazy playground

This page is generated from `lazy playground --help`.

```text
Usage: lazy playground <up|down|status> [--root PATH] [--repo URL|PATH] [--teams] [--fleet smolvm]

Provision a throwaway lazy project with a real daemon and tasks in every state,
so agents and humans can exercise the dashboard, the review surfaces, the CLI
and Lazy Teams without touching a real project.

Everything lives under one root (default: ~/.lazy-playground) — the fixture git repo,
its store, the playground daemon's state and the fake agent. Nothing is written to
any real project, and the playground daemon runs on a deliberately fake credential,
so no model API is ever called and nothing is ever spent.

Runs from a lazy SOURCE checkout only. Playground turns need the host-process runner,
which is compiled out of released binaries — a released lazy can create the
project but cannot run a turn in it.

Subcommands:
  up        Provision the playground, replacing any previous one, and print how to reach it
  down      Stop the playground daemon and remove everything it created
  status    Show what is provisioned, whether it is alive, and a fresh sign-in link

Options:
  --root PATH   Use this playground root instead of ~/.lazy-playground
  --teams       Also boot Lazy Teams against the playground and provision the project
                into it (up only)
  --fleet smolvm
                With --teams: run Teams on the REAL smolvm backend instead of its
                stand-in mode — no daemon or agent on this host, the project in a
                microVM, YOUR Claude credential from the shell (CLAUDE_CODE_OAUTH_TOKEN
                or ANTHROPIC_API_KEY), and one real task whose first turn builds the
                agent image inside the guest: a detached server on the repository's
                first [serve] port when its lazy.toml declares one, a plain describe-
                the-repo task when it does not. Needs LAZY_SMOLVM_BINARY and
                LAZY_DAEMON_IMAGE exported, and --repo. "lazy playground status" prints the
                service address (or says the repo serves none); "lazy playground down"
                deletes the machine.
  --repo URL    The repository to use as the project instead of the generated
                fixture. Without --fleet: anything git can clone (a URL or a local
                path); when it is the lazy playground, its starter tasks are
                created in the backlog, and any other repository gets no tasks.
                The clone's origin is removed, so nothing is ever pushed back.
                Commands its lazy.toml declares (post_turn and the like) run
                UNSANDBOXED on this machine when a task runs — only use
                repositories you trust.
                With --fleet: the public git URL the guest clones — checked from
                this machine first with no credentials, because the guest has none
                and reaches only public IP space.
  --memory MIB  With --fleet: the machine's memory budget in MiB (default 8192,
                or LAZY_SMOLVM_MEMORY_MIB from the shell). The daemon, dockerd,
                the agent-image build and the agent container all share it;
                "lazy playground status" prints what the guest is using, so raise it
                from a measurement, not a guess.
  --model NAME  With --fleet: the model the seeded task runs on (haiku, sonnet, opus
                or a model id). Its turn spends real tokens on your account; default
                is the daemon's own.

Examples:
  lazy playground up                  # Provision and print the dashboard link
  lazy playground up --teams          # …and boot Lazy Teams against it
  lazy playground up --repo https://github.com/getlazy/playground.git
                                      # the playground app and its starter tasks
  lazy playground up --teams --fleet smolvm --repo https://github.com/you/some-public-repo.git
                                      # the end-to-end proof: a project in a microVM, one real task
  lazy playground status                    # Fresh sign-in link and the seeded tasks
  lazy playground down                      # Stop the daemon and delete the root
```
