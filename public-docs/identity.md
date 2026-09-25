# Who lazy says did it

Every row lazy stores carries the person who caused it — the task you created,
the feedback you gave, the accept you signed off. On your own machine lazy takes
that person from **git**:

```bash
git config --get user.email
git config --get user.name
```

Whatever `git commit` would stamp on a commit in this repository is what lazy
records on the work around it. Repository-local config wins over your global
config, exactly as it does for git, so a repo where you commit as
`you@work.example` is a repo where lazy attributes your actions to
`you@work.example` too.

There is no lazy-side setting for this, on purpose. If you want lazy to record a
different address, change your git config — one identity, one place.

## When lazy does not know who you are

If `user.email` is not set anywhere, lazy refuses anything that writes to its
store, in the same words git uses when it cannot sign a commit:

```
Actor identity unknown.

*** Please tell me who you are.

Run

  git config --global user.email "you@example.com"
  git config --global user.name "Your Name"

to set your account's default identity.
Omit --global to set the identity only in this repository.

lazy records who performed every action, and takes that identity from git.
```

**Reading always works.** `lazy list`, `lazy show`, `lazy diff`, `lazy search`,
`lazy doctor` and the dashboard keep working with no identity configured —
looking at your work is the most likely moment to discover the problem, and
lazy does not take that away from you.

**Setting the machine up also works.** Nothing lazy needs in order to *become*
usable is refused for want of an identity — daemon settings such as
`lazy daemon config`, handing lazy a model credential, and issuing access
for another client on this machine all work on a fresh install with no git
config at all. So does every `lazy doctor` repair.

**Writing is refused** until the identity is set: creating a task, starting or
unblocking one, commenting, accepting, rejecting, closing. What is refused is
what records who did it — plus anything that would start an agent turn, since
the work that turn records arrives long after you have walked away from it.

Every command that asks you to type something — an editor, a task prompt, an
accept reason — checks first, before the prompt opens, so a refusal never costs
you text you have already written.

## Fixing it

```bash
git config --global user.email "you@example.com"
git config --global user.name "Your Name"
```

Then run the command again. Nothing needs restarting: lazy re-asks git for the
identity within a minute, and a failure is never remembered at all — the very
next command after the fix is accepted.

Two things lazy will not accept:

- **A `user.email` that is not an email address.** lazy stores the address
  itself so that every row names somebody you can write to, so `user.email =
  ivan` is refused with the same remedy.
- **A different identity supplied by a client.** Identity comes from the
  environment lazy itself runs in, never from a request — nothing you can pass
  on a command line changes who an action is attributed to.

`lazy doctor` shows the resolved identity as its own check, and explains the
remedy in full when there is none.

## What the agent does is yours

An agent never has an identity of its own. Its work belongs to whoever asked for
the turn: if you unblocked the task, everything the agent writes for the length
of that turn — its answer, the notes it leaves, the tags it sets — carries your
name. If somebody else unblocks the next turn, that turn's work carries theirs.

Rows still say *how* the work arrived, so "you asked for this" stays readable
apart from "you typed this": an agent's write is shown as the agent acting, with
your address alongside.

Lazy remembers this for as long as the turn runs, so restarting the daemon
mid-turn does not lose track of whose work is in flight.

**Work nobody asked for is the automation's.** When lazy resumes a crashed turn
by itself, delivers an event to a waiting agent, or merges an upstream change
without being asked, no person asked for it — so rather than borrowing the name
of whoever last touched the task, lazy records the account the automation is
configured under. On your own machine that is your git identity; on a team it is
the account whose model credential the project's automatic turns already run on.

Such a turn is marked as the system's rather than as yours, which is what keeps
"I did this" readable apart from "my lazy did this" on a one-person install,
where both name the same person.

Only a turn lazy positively recorded as its own is attributed that way. Where no
account is configured, and in the cases where lazy simply could not record who
asked for a turn, the work names **nobody**.
Lazy never fills that gap in by guessing, because "we do not know who asked for
this" and "the automation account did it" are different claims, and only the
first one can be corrected later.

## On a team

In a hosted, multi-person deployment the rule is different: nothing about a
shared server identifies a person, so nobody is assumed. Each person's client
authenticates as them and every action goes out under that identity. Git config
on the server is not consulted, and there is nothing to configure per machine.

That credential carries who the person is, and lazy takes it from there and never
from the request. So a task the team can see says `ada@example.com` accepted it,
whether Ada pressed accept in a browser or from her terminal, and a client cannot
sign somebody else's name to anything even if it asks to.

The address is what identifies somebody and is always there. A display name rides
along where the client has one to offer — a terminal takes it from git config, so
the same person's terminal actions read `Ada Lovelace <ada@example.com>` — and
rows simply show the address where it does not.

An address identifies one person however it is typed: lazy matches it ignoring
surrounding spaces and upper/lower case, so `Ada@Example.com` and
`ada@example.com` are the same member, with one history and one set of
credentials rather than two half-populated ones.

**An action a person takes must be taken as that person.** The operator
credential a shared host runs on names the system, not anybody in particular, so
lazy refuses it for the things a person does — accepting, rejecting, closing,
stopping, starting, editing, creating, commenting, signing off, curating shared
memory — and says to use the acting person's credential instead. Reads are never
refused, and neither is the operator's own work: issuing and withdrawing
someone's access, handing lazy a model credential, configuring a project, and
the plumbing a turn runs on. The point is that the history never claims the
server made somebody's decision.

Changing what a task runs on is one of those actions, and it is recorded: a
model, effort, agent or goal change appears in the task's journal as
"Task edited: model → opus" with the person who made it, so "who put this task
on the expensive model?" has an answer.

None of this applies to your own machine. There is no operator credential
there — the one credential is yours, and per-person credentials are refused
outright rather than sitting unused.
