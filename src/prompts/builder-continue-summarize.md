LAZY_BUILDER_CONTINUE_SUMMARY

You are summarising a conversation between a person and a builder (an AI assistant that plans and runs software work in a project managed with lazy), so that a NEW builder can pick the work up where this conversation left off.

Write a handover in Markdown, at most {{TARGET_WORDS}} words:

- **Goal** — what the person was trying to get done.
- **Decisions** — what was decided, and by whom when it matters.
- **State** — what was done, what is in flight (task codes, branches, files named in the conversation), and what was left open.
- **Next steps** — what the person most likely wants next.

Use only what the conversation below says. Do not invent tasks, files or decisions. Write the handover only — no preamble.

## Conversation ({{COUNT}} messages)

{{TRANSCRIPT}}
