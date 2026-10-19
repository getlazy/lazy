# lazy system build

This page is generated from `lazy system build --help`.

```text
Usage: lazy system build <name> [--no-cache] [--timeout <seconds>]

Prebuild a lazy system image, bypassing the current project's lazy.toml.

Use this to build the base 'lazy-runner' image on a fresh machine — for
example, when a project's custom Dockerfile does `FROM lazy-runner` and
the base image doesn't exist yet.

Images are tagged with lazy's major.minor version (lazy-runner:<major.minor>). The
base image also gets a `:latest` alias pointing at that same build, which is
what `FROM lazy-runner` resolves to.

The image carries the configured agent's CLI and the Dockerfile's own packages, not lazy
itself — lazy-agent is mounted into the container at launch. It is rebuilt by
`lazy upgrade`, when the Dockerfile changes, and automatically once it is more
than 14 days old.

Valid names:
  lazy-runner              The base Docker image used by agent containers

Options:
  --no-cache               Force a clean rebuild; do not reuse Docker layers
  --timeout <seconds>      Kill the image build after N seconds (default: no timeout)

Builds run with NO time limit by default: a build killed on a timer wastes the
whole wall-clock it ran for and produces nothing. Use --timeout only if you
genuinely want a bound; `--timeout 0` spells out the default.

Examples:
  lazy system build lazy-runner
  lazy system build lazy-runner --no-cache
  lazy system build lazy-runner --timeout 1800
```
