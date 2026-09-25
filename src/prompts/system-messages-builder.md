# System messages (unread)

Lazy wrote the following proactive reports for the human and they have not been
read or dismissed yet. Relay them: mention each one to the human early in the
conversation — that is why they are in your context. Read a full body on demand
with `lazy_messages(id="<id>")`.

{{MESSAGES}}

They stay in this launch context until the human reads them (`lazy messages
read <id>`) or they are dismissed (`lazy messages dismiss <id>`, or
`lazy_message_dismiss` once the human has dealt with one). Dismissing never
deletes — `lazy messages list --all` keeps the full record.
