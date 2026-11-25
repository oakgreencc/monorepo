---
title: Recover work from a worktree
description: Find out what a worktree holds that GitHub lacks, and restore work cambium archived.
sidebar:
  order: 13
---

## Check a worktree before deleting it

From inside the worktree:

```sh
graft status agent/my-branch
```

It lists uncommitted paths and local commits no branch on GitHub contains, checked through the API. `nothing local that GitHub does not have` means it is safe to remove.

If the work is merged, `graft worktree done agent/my-branch` rewinds the branch so worktree tools stop counting published commits as lost. It exits 1, changing nothing, if anything is local only. `graft pr merge` runs it for you when run inside the PR's own worktree. If the PR merged some other way, run it yourself before ExitWorktree `remove`: ExitWorktree counts commits before any hook runs, so a hook cannot do it in time.

## Find why cambium kept a worktree

cambium removes a worker's worktree only when GitHub holds everything in it. Otherwise it keeps it and logs a warning with the reason in `~/.cambium/logs/cambium.log`.

To see what the periodic sweep would do with every worktree:

```sh
cambium gc --dry-run --repo owner/name
```

## Restore an archived worktree

A worktree idle for `gc.staleDays` (14 by default) with unpublished work is archived, then removed:

```text
~/.cambium/gc/<owner>__<name>/<dir>-<stamp>/
  commits.bundle    local commits not on origin/<base>
  changes.patch     uncommitted changes
  untracked/        untracked files
  worktree.json     where it was and which branch
```

1. Restore the commits into your clone:

   ```sh
   git fetch ~/.cambium/gc/owner__name/<dir>-<stamp>/commits.bundle HEAD:recovered
   ```

2. Check out `recovered`, then apply the rest:

   ```sh
   git apply ~/.cambium/gc/owner__name/<dir>-<stamp>/changes.patch
   cp -R ~/.cambium/gc/owner__name/<dir>-<stamp>/untracked/. .
   ```

To change when the sweep runs or archives, set `gc.everyMinutes`, `gc.graceMinutes` and `gc.staleDays`: [cambium configuration](/reference/cambium/configuration/).
