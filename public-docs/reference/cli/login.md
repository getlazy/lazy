# lazy login

This page is generated from `lazy login --help`.

```text
Usage: lazy login [<teams-url>] [--project <team/project>] [--device] [--device-name <name>]

Log this machine in to a Lazy Teams install. Inside a clone, also bind that
clone to one project.

After it, git over HTTPS to that install works in any directory, like GitHub
after `gh auth login`:

  git clone https://teams.example.com/git/acme/api-server.git

lazy adds ONE include.path entry to your user-level git config (it says which
file) pointing at a 0600 file of its own. That file sends the token to that
exact address only — never another host, never across a redirect — and no
repository's .git/config ever holds it.

Run it with no arguments to print which installs this machine is logged in to,
and where this clone points.

If the install sits behind an authenticating proxy (it says so itself), lazy opens
your browser: you pass the proxy's sign-in, approve the machine, and the browser
hands the token to a listener on 127.0.0.1 here. Otherwise lazy prints a short code
and a URL to approve in a browser that is already signed in. Nothing secret is
typed, pasted or shown.

Options:
  --project, -p <team/project>
                     Inside a clone: which project it is, e.g. acme/api-server.
                     Without it you are asked; with no terminal to ask, it is
                     REQUIRED. The git remote is never consulted.
  --device           Use the code-and-URL flow even when the install asks for the browser one.
  --device-name <name>
                     What the approval page calls this machine. The token is
                     named after it at Settings → API tokens.

One clone, one project: logging in again replaces the binding.

Tokens live in lazy's credential store: the OS keychain (or libsecret, or a 0600
file).

Examples:
  lazy login                                       # where am I logged in?
  lazy login https://teams.example.com             # this machine (outside a clone)
  lazy login teams.example.com -p acme/api-server  # inside a clone: bind it, no prompt
  lazy clone https://teams.example.com/git/acme/api-server.git  # clone and bind in one step
  lazy logout teams.example.com                    # log this machine out of an install

Human/CLI-only — an agent must never log a machine in, so there is no MCP tool.
```
