---
title: Let cambium merge green PRs
description: Have the scheduler merge agent PRs itself once CI passes, instead of waiting for a person or merge queue.
sidebar:
  order: 5
---

By default cambium never merges a task PR. A merge queue, auto-merge or a person does, and a PR still unmerged after `mergeQueueMinutes` goes to `q:human`.

1. Make sure graft lets agents merge into the base. `graft doctor` prints `agents may merge into: <base>`. If the base is missing, add it to `mergeableBases` in `.graft.json` (a protected change).
2. Make sure the base branch requires the CI check (`graft setup project --required-check <job>`).
3. In the `cambium` section of `~/.oakgreen/forest.json`, switch to the graph engine and turn merging on:

   ```json
   { "engine": "graph", "merge": "green" }
   ```

   To do this for one repository only, put `"merge": "green"` on its `repos[]` entry instead.

4. `engine` is read only at start, so restart:

   ```sh
   oakgreen restart cambium
   ```

## What to expect

- A green, conflict-free PR is merged through `graft pr merge --auto`, so graft's merge policy still decides.
- A PR behind its base is updated first and merged once its new head is green.
- A red, conflicting or changes-requested PR is sent back for rework, up to `phases.task.maxReworks` times, then to `q:human`.
- A PR that touches protected paths waits in `q:human` with `why:approve` until a code owner approves it. See [Approve protected changes](/how-to/approve-protected-changes/).

Why this replaces a merge queue: [Merging and the red base](/explanation/merging-and-red-base/). Node by node: [cambium graphs](/reference/cambium/graphs/).
