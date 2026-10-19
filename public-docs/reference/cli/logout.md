# lazy logout

This page is generated from `lazy logout --help`.

```text
Usage: lazy logout [<teams-url>]

  lazy logout <teams-url>   Log this machine out of that install: delete its
                            token and remove the git config entry lazy login added.
  lazy logout               Inside a clone: unbind the clone from its project.
                            Outside one: log this machine out of every install.

This stops THIS machine using the token; it does not retire the token. To end
access altogether, revoke it at Settings → API tokens on the install.
```
