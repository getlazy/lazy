# Running the product at any commit

Tasks exist to ship a product, and sometimes you want to look at the product
itself: the default branch as it stands, a colleague's branch, or the exact
commit a bug report names. A **run** is that — the project's app at one commit,
started the same way a task's services are, without creating a task.

A run is not a task. It has no agent, no turns, no review and no pull request,
and it never appears in task lists or task counts.

## Where to find it in Lazy Teams

Every project has a **Run** page, next to **Tasks** in the project's menu. It
has two ways to pick what to run:

- **A branch** — a list of the remote's branches, with the default branch
  already selected, so **Run this branch** runs the default branch unless you
  pick another. Branches lazy made for tasks (`lazy/…`) are hidden until you
  choose **Show task branches**. **Fetch from the remote** brings the list up
  to date.
- **A commit** — type its id and press **Run this commit**. An id the remote
  does not have is refused right there, with the reason, and what you typed is
  kept.

Below them, the project's runs are listed, each with the exact commit it
serves. Asking for a run that already exists takes you to it.

A run's own page has, from top to bottom:

- **Commit** — what the run follows or is pinned to, the commit it serves, how
  many newer commits its branch has, who created it and who last pulled it,
  and the **Pull latest** (branch runs only) and **Remove** buttons.
- **Services** — the same card as a task's Services tab: **Run services** and
  **Stop services** with each step shown as it happens, what is running in
  the run's environment and its output, and **Open** for each service. Open
  goes through Lazy Teams exactly as it does for a task, so the address is
  `<run name>-<port>-<project>-<team>-<id>.<services host>`; while the app is still
  starting, Open waits on a page that goes through as soon as it answers.
- **Shell** — open as many shells in the run's environment as you like. If the
  environment is not running yet, **Start the environment** brings it up.
- **Environment** — the names of the project's entries that apply to every
  task, which the run receives. No value is shown.

Anyone on the project can do all of this. Team admins have nothing extra here;
the Start services command a run uses is the project's, set under
**Settings → Configuration**.

## What a run checks out

You pick what to run in one of three ways:

- **The default branch** — what you get when you name nothing: the newest
  commit of the remote's default branch.
- **A branch** — its newest commit on the remote. A branch run *follows* its
  branch: **Pull latest** moves it to the branch's newest commit.
- **A commit** — any commit id (7 to 40 hexadecimal characters) that is on one
  of the remote's branches. A commit run is *pinned*: it is exactly that commit
  and has nothing to pull.

Everything is checked against the project's **remote**. A branch that exists
only on one machine, or a commit nobody pushed, is refused with a message saying
so — it is somebody's work in progress. While the project is offline
(`lazy system offline`, or `offline = true` under `[remote]`), nothing can be
resolved and runs cannot be created or pulled.

Each run shows the exact commit it serves (its id, subject and date), and a
branch run also shows how many newer commits the branch has, as of the
project's last fetch.

There is one run per branch and one per commit, shared by everyone on the
project: asking for a run that already exists takes you to it. Anyone on the
project can start, stop, pull or remove it, and the run records who created it
and who last pulled it.

## In the dashboard

Open **Runs** in the dashboard's navigation (`/runs`):

- **Run a commit** lists what you can run. The default branch is selected,
  with its newest commit; below it are a field for a commit id and the
  remote's branches, newest first. Task branches (`lazy/…`) are hidden until
  you choose **Show task branches**, and **Fetch now** updates the list from
  the remote. Press **Run**: each step is shown as it happens, and a branch
  or commit the remote does not have is refused with the reason.
- Below it, **Runs** lists the runs that exist and the exact commit each one
  serves.

A run's own page shows the commit it serves, how many newer commits its
branch has, its services with links, **Run services** / **Stop services** /
**Stop environment**,
what is running in its environment and its output, **Pull latest** (branch
runs only), **Remove**, and a **Shell**. A service that is starting has
**Open when it answers**, which waits for it and then opens it. When Pull
latest or Remove would discard changes, the files and commits are listed
and nothing happens until you confirm.

## Running services

A run has the same tools as a task's **Services** tab:

- **Run services** starts the project's Start services command in the run's
  environment, bringing that environment up first, with each step shown as it
  happens. **Stop services** runs the Stop services command, if one is set, and
  ends what Start services started.
- Every service declared in `[serve]` (see
  [Reaching a task's dev server](serve-ports.md)) gets a link. The run's name
  takes the task's place in it: the default branch `main` answers at
  `main.web.lazy.localhost` on the dashboard's port, and under Lazy Teams at
  `main-3000-<project>-<team>-<id>.<services host>`. A branch's name is made into a host
  name — lowercased, other characters turned into `-`, at most 40 characters
  (`feature/Login.v2` becomes `feature-login-v2`); a commit run is named
  `sha-` and the commit's first 12 characters.
- Opening a service that is not running takes you to the run's page, which says
  why and offers **Run services**. Opening a link never starts anything by
  itself.
- A **shell** opens inside the run's environment, in the checkout. Like the
  services, it is shared: what one person starts there, everyone sees.

Nothing stops a run for being idle. Restarting the project's daemon stops every
run's environment, as it stops tasks' environments; the run itself stays, and
**Run services** starts it again.

A task's code and a run's name can never be the same, so a link always reaches
the one it names: a run is refused where an open task already uses the name,
and a task code is refused where a run uses it.

## Pull latest, and changes made in a run

The run's checkout belongs to lazy, but people can change files in it through
the shell. Lazy never throws those changes away without asking:

- **Pull latest** with nothing changed moves the checkout to the branch's
  newest commit. If services were running, they are restarted on the new
  commit, and that step is shown too.
- If files were changed, or somebody committed in the run's shell, Pull latest
  stops and lists them. Confirming discards the edits to tracked files, any new
  file the newer commit also has (it is replaced), and commits made in the run
  that were never pushed; other new files stay where they are. What was
  discarded is listed afterwards. In Lazy Teams the list appears on the run's
  page with **Discard them and pull** and **Keep the changes**; keeping them
  leaves the run where it is.
- If somebody moved the checkout to another commit through the shell, the run
  shows the commit it is actually at, beside the one it was started on.
- **Remove** asks the same way, then removes the run's environment, its
  checkout and its record.

## Environment, secrets and files

A run receives the project's environment entries and files that apply to
**every** task. Entries a person selects per task do not apply to runs. When an
admin adds, changes or deletes one of those entries, every existing run is given
the new set at once, as tasks are. A run whose environment is already running
picks the change up the next time that environment starts — **Run services** or
**Start the environment** starts it afresh when its set changed.

## What a run's environment holds — and what it does not

A run executes whatever code the commit contains, so its environment is built
to hold as little as possible:

- the project's container image, its declared ports, and the project's mounts
  that no task can write to;
- the checkout, writable; the rest of the repository read-only, and git's
  branches, configuration and hooks read-only, so nothing in a run can move a
  branch or change what git runs elsewhere;
- **no agent credential of any kind**, no connection to lazy's credential proxy,
  and no access to lazy's own tools. Running a commit spends no model usage.

With Docker, each run is on a network of its own that tasks' environments cannot
reach, and that cannot reach theirs. Network access to the outside world is not
restricted, as for every environment lazy runs: a run is not a sandbox for
untrusted code beyond what its container provides.

If the project's own image is still building, or failed to build, a run does
not start on another image by itself: you can choose to run it on lazy's default
image instead, and that choice stays with the run. In Lazy Teams the run's page
says when the project's image is not ready and offers **Use lazy's default
image**; once the project's image is ready, **Use the project's image** switches
back; if the run's environment is running, it is started again on the
project's image, which stops what was running in it.

Runs need a container runtime (Docker or Podman); a project on the host-process
runner cannot run commits.
