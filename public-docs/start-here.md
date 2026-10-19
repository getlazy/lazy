# Start here

lazy runs coding agents on your repository as **tasks**. Each task works on its own branch, in its own container, and stops for you to review the result, send feedback, and accept it into your branch. Your checkout is never touched while an agent works.

## Install

You need git (with `user.name` and `user.email` set), [Bun](https://bun.sh) and Docker, plus a model credential such as a Claude subscription or an Anthropic API key.

```bash
git clone https://github.com/getlazy/lazy.git
cd lazy
bun run install:local
```

This builds lazy and installs it into `~/.lazy/bin`; add that directory to your `PATH` if `lazy` is not found. Then set it up in a repository that has at least one commit:

```bash
cd your-project/
lazy init
```

[Getting started](getting-started.md) covers these steps in detail, and [Credentials](credentials.md) explains the model credential.

## Where to go next

1. **The dashboard.** Open it with `lazy dashboard` and work from your browser: [Dashboard tutorial](tutorials/dashboard.md).
2. **The builder in your terminal.** Run `lazy builder`. The command line's strongest tool is a conversation with a builder that creates, runs and reviews tasks for you: [Use a builder](how-to/use-a-builder.md), and [the builder](explanation/the-builder.md) for how it works.
3. **Lazy Teams (private alpha).** The same workflow on a shared team server: [Lazy Teams tutorial](tutorials/lazy-teams.md).

Prefer the command line end to end? [Getting started](getting-started.md) takes one task from creation to merge.
