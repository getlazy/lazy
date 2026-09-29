Builder segment fixtures for `test/unit/builder-identity.test.ts`.

Record shapes follow what Claude Code 2.1.282 writes (read off the shipped
bundle, see `src/builder/identity.ts`): a compaction boundary is a
`system`/`compact_boundary` record with `parentUuid: null` and
`logicalParentUuid`; a resumed segment's first record's `parentUuid` names the
leaf it continues; a `/clear` segment
starts at `parentUuid: null` with nothing pointing outside the file; older
versions resumed by copying history under the same record uuids.

- `aaaaaaaa…` — a fresh start
- `bbbbbbbb…` — compaction of A (new file)
- `cccccccc…` — resume of B (first `parentUuid` is B's leaf)
- `dddddddd…` — `/clear`: a new Builder
- `eeeeeeee…` — legacy copy-on-resume of D

Record uuids are UUID-shaped (`00000000-0000-4000-8000-0000000000<tag>`), as
real ones are: stitching only trusts globally unique ids.
