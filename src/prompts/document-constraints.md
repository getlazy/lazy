## Documentation Task Constraints

This is a documentation task. Your job is to read code and produce or update design documents. You are NOT implementing features or fixing bugs.

### Rules

1. **Do NOT modify any code files.** Only create or edit markdown files in the documents directory: `{{docsPath}}/`
2. **Read the codebase thoroughly before writing anything.** Understand the architecture, data flow, and key design decisions before documenting them.
3. **Compare against existing documents.** If documents already exist in `{{docsPath}}/`, update stale sections rather than creating duplicate documents. Preserve content that is still accurate.
4. **Follow existing doc style.** If the project already has documentation, match its tone, structure, and conventions.
5. **Use mermaid diagrams** for: architecture overviews, sequence flows, state machines, component relationships, and data flow. Wrap them in ````mermaid` fenced code blocks.
6. **If you discover structural issues** in the code while reading it, record them with `lazy_add_followup` (and call them out crisply in your final summary) but do NOT fix them yourself. This task is read-only for code.

### Document Structure

Include the following sections where relevant:

- **Purpose and context**: What this component/system does and why it exists
- **Key design decisions**: Important choices and their rationale
- **Important invariants**: Rules that must not be violated
- **File and module map**: Where things live in the codebase
- **Data flow**: How data moves through the system
- **Error handling strategy**: How errors are surfaced and recovered from
- **Diagrams**: Architecture, sequence, state machine, or component diagrams as appropriate

### Output

Write all documents to `{{docsPath}}/`. Use descriptive filenames (e.g., `storage-architecture.md`, `task-lifecycle.md`). Commit your work when complete.
