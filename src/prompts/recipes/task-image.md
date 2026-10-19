# Recipe: put a toolchain into the task image

Use this when your work needs a language, compiler, runtime or tool the container
does not have — a Node service with no `node`, a Rust service with no `cargo`, a
Python script with no `python3`, a database client, a CLI your tests call. That
tool is part of the project now: every future task on this project will need it
too, so it belongs in the project's task image, `Dockerfile.lazy` at the
repository root. Installing it by hand in this container alone fixes only this
turn.

## 1. Check what is present

Look before you add anything, and write down what you found:

```sh
command -v node npm cargo rustc python3 go java ruby 2>/dev/null
node --version; cargo --version   # …for whatever the work needs
```

Only add what is genuinely missing. Do not add tools "just in case".

## 2. Write or extend `Dockerfile.lazy` at the repository root

First check the project's `lazy.toml`: if its `[docker]` section sets `dockerfile`
to another file, that file is the task image — extend it instead of creating
`Dockerfile.lazy`, and say so in your report.

- **If `Dockerfile.lazy` already exists**, extend it: add your install steps next
  to the existing ones. Never remove what is there — another task put it there
  for a reason.
- **If it does not exist**, create it, starting from lazy's default image:

```dockerfile
FROM lazy-runner

# <toolchain> for <what the project needs it for>
RUN <install steps>
```

`lazy-runner` is lazy's default task image. Each lazy release publishes it with
every supported agent CLI already installed (Claude Code, Codex, Cursor and Pi),
and lazy pulls it before your image when it is missing, building it locally only
if the pull fails. Starting from it keeps everything a task container must have. For reference, this is exactly what
it contains:

```dockerfile
{{defaultDockerfile}}
```

What the image must keep, whatever you write:

- **The agent CLI** on `PATH` for the `user` account. `FROM lazy-runner` already has
  every agent's CLI, so a Dockerfile built on it needs no install line for any
  agent. Only a `Dockerfile.lazy` on ANOTHER base image must install the agent its
  tasks run itself, after `USER user`, with that agent's line:

{{agentInstallLines}}

- **git**, and the tools listed above (`curl`, `sudo`, …) that lazy relies on.
- **The non-root `user` account**, with passwordless sudo, as the account the
  container runs as. Leave `USER user` as the last `USER` line, and keep
  `WORKDIR /work`.

How to write the install steps:

- Prefer the distribution's packages (`apt-get install -y --no-install-recommends`)
  or the toolchain's official installer. Pin a major version where it matters
  (e.g. Node from NodeSource `setup_22.x`).
- `lazy-runner` ends as `user`, so system packages need `sudo` — or switch with
  `USER root` for the step and back with `USER user` afterwards.
- Per-user installers (rustup, nvm, uv) must run AS `user`, and their bin
  directory must be on `PATH` via `ENV PATH=...` — a `source ~/.cargo/env` in a
  `RUN` line does not survive to the container. For Rust:

```dockerfile
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/home/user/.cargo/bin:${PATH}"
```

- Clean apt lists in the same `RUN` (`&& sudo rm -rf /var/lib/apt/lists/*`).
- Do not `COPY` project source into the image: the repository is mounted at
  `/work` at run time. The image is for tools, not for the code.

Check the file builds. If your lazy tools include `lazy_image_build`, call it: it
test-builds this task's own `Dockerfile.lazy` (your uncommitted edits to it
included) against your COMMITTED files — commit anything it `COPY`s first — and
returns the build output. Nothing it builds is kept or used to run anything.
Otherwise try `docker build -f Dockerfile.lazy .` — usually there is no docker
inside a task container, and that is fine: say so in your report.

## 3. Understand when it takes effect

The new image applies to the **next task started after this one is accepted** —
never to the task you are running now. That is deliberate: a task branch never
chooses the image its own container runs in. Once your `Dockerfile.lazy` lands
in the project's main line, lazy builds from it for the next task, with no
configuration change.

## 4. Install it here too, for this task's own work

You still need the tool now. If you have sudo in this container, install the same
toolchain the same way, so you can build and test what you are writing:

```sh
sudo apt-get update && sudo apt-get install -y <package>
```

Say in your report that you did, and that the installation in this container is
temporary — the image change is what makes it permanent.

## 5. Report it

Tell the human, plainly:

- which toolchain you added to `Dockerfile.lazy` (created or extended), and why
  the work needs it;
- that it takes effect for tasks started after it reaches the project's main
  branch (for a subtask, that is after its parent is accepted too);
- whether you installed it in this container for your own work, and whether you
  were able to test-build the image.
