# lazy system export-dockerfile

This page is generated from `lazy system export-dockerfile --help`.

```text
Usage: lazy system export-dockerfile [options]

Write the embedded default Dockerfile (used to build agent containers) to disk
so you can customize it. Output defaults to Dockerfile.lazy in the project root.

This does NOT modify lazy.toml. A Dockerfile.lazy at the project root is used
automatically when [docker].dockerfile is unset and the file is COMMITTED on the
project root's checked-out branch; for any other path, point
[docker].dockerfile at the file yourself.

Options:
  -o, --output <path>   Write to <path> instead of Dockerfile.lazy
      --stdout          Print to stdout instead of writing a file (also: -o -)
  -f, --force           Overwrite the target file if it already exists

Examples:
  lazy system export-dockerfile                 # Write Dockerfile.lazy
  lazy system export-dockerfile --force         # Overwrite an existing file
  lazy system export-dockerfile --stdout        # Inspect without writing
  lazy system export-dockerfile -o custom.Dockerfile
```
