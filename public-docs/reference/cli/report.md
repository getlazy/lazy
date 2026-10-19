# lazy report

This page is generated from `lazy report --help`.

```text
Usage: lazy report [--start <spec>] [--end <spec>] [--pdf] [--out <path>]

Print an LLM-summarized markdown digest of recent activity to stdout.
Covers ALL main-branch activity in the window — both lazy-managed
tasks AND direct (non-lazy) commits by collaborators not using lazy.

Three layered sections in the final output:
  Brief                       Skimmable overview (paragraph + bullets)
  For the engineering manager Decisions, direction, releases
  For the engineering lead    Substance — clustered thematically, with
                              lazy vs non-lazy work called out

Implementation note: this runs a map-reduce of LLM calls — one per
lazy task with activity, one per non-lazy main-branch commit, then a
final reduce. Per-run cost scales with activity volume.

Options:
  --start <spec>   Window start. Default: -24h. Accepts relative offsets
                   (-7d, -12h, -30m) or ISO timestamps.
  --end <spec>     Window end. Default: now. Same format as --start.
  --pdf            Render the digest as a PDF. Auto-opens with the OS
                   default viewer UNLESS --out is also provided (treat
                   --out as the archival path; --pdf alone as read-now).
                   Requires a Chrome/Chromium/Brave/Edge binary on the
                   host (used in headless mode); none is bundled.
  --out <path>     Write the PDF to <path> instead of a temp file. Does
                   NOT auto-open. Only valid with --pdf.

Examples:
  lazy report                              # last 24h, markdown to stdout
  lazy report --start -3d                  # last 3 days
  lazy report --start 2026-05-01 --end 2026-05-08
  lazy report --pdf                        # PDF in tmpdir, auto-opened
  lazy report --pdf --out ~/report.pdf     # PDF saved here, NOT opened
```
