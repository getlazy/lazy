# How to use a builder

You need this when you want to talk to an agent about your project as a whole, rather than about one task: plan work, create tasks, review what is in flight. A builder is a conversation with an agent that has lazy's orchestration tools.

What a builder is, and how it differs from a task agent, is explained in [The builder](../explanation/the-builder.md).

### CLI

Start a builder session in your project:

```bash
lazy builder
```

It starts autonomously (no permission prompts) and, in an interactive terminal, asks you to type `yes` after showing the posture it runs under. Pass `--yes` to skip that, which is required without a terminal, or `--no-autonomous` to keep Claude Code's normal permission prompts. `--model <id>` and `--effort <level>` set the builder's own model and effort.

When a session exits, its ID is printed. Resume a session, and list the captured ones:

```bash
lazy builder --resume <id>
lazy builder list
```

If `lazy upgrade` stops your builder to rebuild the image, it is relaunched in place afterwards with its conversation intact.

In a clone logged in to Lazy Teams, `lazy builder` starts another builder on the server and attaches your terminal to it, as it starts another one on your own machine. Press ctrl-] to detach and leave it running; `lazy builder attach [<id>]` reattaches (relaunching a stopped one). `lazy builder stop [<id>]` stops one and keeps the conversation; `lazy builder end [<id>]` ends the run, and its conversation stays listed and can be resumed. With more than one builder, name the session id; lazy lists them when you leave it out.

### Dashboard

The dashboard's **Builders** pages list and search past builder conversations and show their transcripts. You cannot start a builder from the dashboard; use `lazy builder`.

Open a conversation to read its messages (#1, #2, … with who said each and when). **Promote part of this conversation into a task** turns an exchange into a backlog task (**Create backlog task**); **Start here** and **End here** on a message mark where that exchange begins and ends.

![A builder's transcript in the dashboard: title, start and end times, message counts, the Promote part of this conversation into a task section and four numbered messages](../images/how-to/dashboard-builder-transcript.png)

### Lazy Teams

Open **Builders** in your project.

![The Lazy Teams Builders page: a Start a new builder button, your two running builders each with Open and Stop, a transcript search box and a list of builders with Running and Stopped badges](../images/teams/teams-builders.png)

1. Choose **Start a new builder**. Each press starts another one, so you can run several at once; every builder of yours is listed under **Your builders** with **Open** and **Stop**.
2. Work in the terminal on the page. A builder runs on the account of the person using it, so you can only open your own.
3. **Stop** keeps the transcript and **Resume** starts that builder again; your other builders keep running. **End** finishes the run; the transcript is kept, and the builder can still be resumed from the list.
4. Each of your own builders in the list, stopped or ended, has a **Resume** button that continues it in an additional builder of yours. See [Resuming a builder](../reference/teams/builders.md#resuming-a-builder).
5. Every builder in the list, a teammate's included, has **Continue**, which starts an additional builder of yours from a summary of it. See [Continuing from a summary](../reference/teams/builders.md#continuing-from-a-summary).

Below, each past builder has a transcript. Tick **Select message** beside messages and choose **Create task** to start a new task from them. See [Builders in Lazy Teams](../lazy-teams-builders.md).

## Related

- [The builder](../explanation/the-builder.md)
- [Builders in Lazy Teams](../lazy-teams-builders.md)
- [The builder scratch directory](../builder-scratch-dir.md)
