# lazy system source-id

This page is generated from `lazy system source-id --help`.

```text
Usage: lazy system source-id [options]

Print the identity of a lazy source tree — a content fingerprint of the code
that decides what a daemon actually runs. Two trees with the same id are the
same lazy; different ids mean different code, whether or not the version string
moved.

Options:
  --checkout <path>  Fingerprint this checkout instead of the running one
  --write            Also write the id to .source-fingerprint in that checkout
  --json             Print id, kind and checkout path as JSON

The 'kind' says where the answer came from: 'baked' (a .source-fingerprint
written by a build), 'computed' (the tree was hashed just now), 'embedded'
(a compiled binary carrying the fingerprint of the tree it was built from), or
'build' (a compiled binary with nothing embedded). Only checkout kinds compare with a checkout.

Examples:
  lazy system source-id                       # What is this lazy?
  lazy system source-id --json                # …with kind and path
  lazy system source-id --checkout /opt/lazy --write
                                              # Bake the fingerprint at image build
```
