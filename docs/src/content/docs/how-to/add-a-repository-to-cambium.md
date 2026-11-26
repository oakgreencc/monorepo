---
title: Add a repository to cambium
description: Point the scheduler at another repository and control how its worktrees are prepared.
sidebar:
  order: 4
---

The repository needs graft set up and the App installed on it: see [Set up graft on a repository](/how-to/set-up-graft-on-a-repository/).

1. Create the queue labels on it:

   ```sh
   oakgreen setup --repo owner/name
   ```

   Run it from a clone of that repository to also get the label guide `docs/agents/triage-labels.md`. Commit it.

2. Add an entry to `repos` in the `cambium` section of `~/.oakgreen/forest.json`:

   ```json
   { "slug": "owner/name", "path": "~/src/name", "baseBranch": "main" }
   ```

   `path` is a local clone; worktrees are added from it.

   If the repository has no CI check named `ci` yet, add `"requiredCheck": null`. Otherwise its base never reads green and the red-base gate never clears. If the check has another name, give that name.

3. Add `.claude/worktrees` to the repository's `.gitignore`.
4. Save the file. The daemon re-reads it before every tick; `repos` changes need no restart.
5. Check on the next tick:

   ```sh
   cambium status
   oakgreen doctor --repo owner/name
   ```

## Change how worktrees are prepared

Workers get a fresh worktree per issue. What runs in it comes from a `"cambium"` key in the target repository's root `package.json`:

```json
"cambium": {
  "install": "pnpm install --frozen-lockfile",
  "hydrate": { "dirs": [".env.d"], "files": [".env"] },
  "prepare": ["pnpm build:deps"]
}
```

- `install` runs when the lockfile changed since the last install. Set `"install": false` to skip it.
- `hydrate` copies git-ignored files and directories from the clone into the worktree.
- `prepare` commands run in order, after both.

This key decides which commands run on your machine. Protect `package.json` in CODEOWNERS.

## Change capacity

| To | Set |
| --- | --- |
| run more workers at once | `phases.task.cap` |
| give a worker longer | `phases.task.wallClockMinutes` |
| allow more attempts before `q:human` | `phases.task.maxAttempts` |
| change scheduling order | `priorityLabels` |

All keys and defaults: [cambium configuration](/reference/cambium/configuration/).
