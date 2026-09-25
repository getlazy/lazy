# Lazy Teams first-run setup

When you deploy Lazy Teams on a fresh server with an empty database, the app
guides you through setup before anyone reaches the normal product. The goal is
simple: hoist a server, create your administrator account, and invite your team
— without opening a console.

## What you see

On first visit, any page redirects into a four-step wizard:

1. **Your account** — Create the first sign-in. That account is a **site
   administrator** automatically: it can manage the installation, create teams,
   and invite people. There is no separate signup page after this. Passwords
   must be at least **12 characters** (length only — no special-character rules).

2. **Name** — Give the installation a short label (for example your company
   name). Teammates see it in the page header so they know which Lazy Teams
   instance they are on.

3. **Readiness** — The checks run one at a time so you can see progress:
   - **Project data folder** — where Lazy Teams stores project data on disk.
     It must exist and be writable by the app process.
   - **Lazy** — a checkout of the lazy CLI on the host, used when projects are
     provisioned.
   - **Existing projects** — every project already on the install was set up
     on the backend the install now runs (see `LAZY_FLEET_BACKEND` in
     [Self-hosting Lazy Teams](self-hosting-lazy-teams.md#environment-reference)).
   - **Email** — outgoing mail is configured, or you choose to continue without
     it and share set-password links yourself.
   - On the default microVM backend, three more: **MicroVM host**, **MicroVM
     runtime** and **Project image** — see
     [Task turns](self-hosting-lazy-teams.md#task-turns).

4. **Your team** — Create your first team and optionally invite someone. With
   email on, they receive an invitation. With email off, you copy a set-password
   link from the finish screen.

When you complete step 4, setup is finished and the wizard stops redirecting
every request.

## Picking up where you left off

Progress is saved as you go:

- Stop after creating your account → next visit resumes at **Name**.
- Stop after naming → resumes at **Readiness**.
- Stop after checks → resumes at **Your team**.

Sign-in works normally once the first account exists. Only an incomplete setup
pulls a signed-in administrator back into the wizard.

## After setup

The same readiness checklist stays available under **God mode → Installation**
if you later change where project data lives, which lazy checkout is used, or how
mail is sent.

Email itself is configured separately under **God mode → Email**. That page
lists which settings are present, how to set them on your host, and lets you
send yourself a test message.

## What to configure on the host

| Setting | Purpose |
|---------|---------|
| `LAZY_FLEET_ROOT` | Directory where project data is stored (optional; a default exists for your OS) |
| `LAZY_CHECKOUT` | Path to a lazy checkout on the host (optional; the parent of this app is used by default) |
| `SMTP_ADDRESS`, `MAILER_FROM`, `APP_HOST` | Outgoing email (optional at first run; required for automatic invitations and password resets) |

Set these in the environment where the Rails app runs, then restart the app.
The readiness step tells you which items still need attention.

## Projects run the version of Lazy the app does

On the `local` backend, Lazy Teams and every project it runs use the **same**
Lazy, from the checkout above. There is no second version to keep in step.

On the default microVM backend, each project runs the image named by
`LAZY_DAEMON_IMAGE`, and an upgrade does not move existing projects to the
new version — see
[What an upgrade does](self-hosting-lazy-teams.md#what-an-upgrade-does). The
rest of this section describes the `local` backend.

That is kept true automatically. When you upgrade Lazy Teams and restart it, each
project restarts on the new version within a minute or so. You do not have to ask
for it, and you do not have to wait for anything to finish first: work that was
running is picked up again where it left off, with its conversation and its
uncommitted changes intact.

The readiness check names the version it found, and the Installation page in god
mode shows it alongside any project not yet on it. There is a **Restart all
project daemons** button there for the rare case where you want it now; if a
routine restart happens to be in progress it waits its turn rather than being
dropped.

A project that repeatedly fails to come back is retried a few times, then left
alone rather than restarted every minute. The Installation page lists those
separately, so "still catching up" and "stuck, and nothing more is coming" are
never confused for one another.

## Continuing without email

If you have not configured SMTP yet, choose **Continue without email** on the
readiness step. You can still create accounts and add people to teams; when you
invite someone, Lazy Teams shows you a set-password link to copy and send
yourself (by chat, ticket, or any channel you already use). The link is valid
for three days, and team administrators can mint a fresh one from the team's
members page while email remains off.

Configure email later from **God mode → Email** when you are ready for automatic
invitations and password resets.

## Passwords

Every account password — the first administrator, invitations, and password
resets — must be at least **12 characters**. Lazy Teams checks length only; it
does not require symbols, numbers, or mixed case. Existing sessions stay signed
in when a password is changed elsewhere.
