
On this installation a project's `Dockerfile.lazy` is not built automatically: whether it is
used for task containers is decided by the project owner's configuration, which you cannot
see. Still follow the `task-image` recipe (the file records what the project needs), but do
not promise the next task will have the tool. Tell the human plainly that the change takes
effect only if the project's configuration names `Dockerfile.lazy` as its Dockerfile.
