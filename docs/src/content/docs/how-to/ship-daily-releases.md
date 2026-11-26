---
title: Ship daily releases
description: Cut a release branch from an integration branch every day, open its PR into the release branch, and merge it once approved.
sidebar:
  order: 8
---

This fits a repository where agents merge into one branch (say `develop`) and releases come from another (`main`). It needs the graph engine.

1. On the repository's `repos[]` entry in the `cambium` section of `~/.oakgreen/forest.json`:

   ```json
   {
     "slug": "owner/app",
     "path": "~/src/app",
     "baseBranch": "develop",
     "release": { "enabled": true, "time": "06:00", "from": "develop", "to": "main", "check": "cd" }
   }
   ```

   `from` defaults to `baseBranch`, `to` to `main`, `check` to the repository's `requiredCheck`. `time` is local `HH:MM`. Top-level `"engine": "graph"` must be set.

2. Restart if you changed `engine`: `oakgreen restart cambium`.
3. Each day at `time`, cambium closes promotion PRs older than 24 hours. It then creates `release/YYYY-MM-DD-N` at the newest `from` commit where `check` passed, and opens a PR from it into `to` listing the PRs it carries. The PR carries `q:promote` and replaces any older open promotion PR.
4. The release branch never changes. Fix a problem on `from`, then run release-prepare again to cut a new one.
5. Review and approve the promotion PR. cambium merges it through `graft pr merge --auto`, if graft's merge policy allows merges into `to`. Otherwise merge it on GitHub.

## Run it now

```sh
cambium run release-prepare --repo owner/app      # cut a release branch and open its PR; counts as today's run
cambium run release-promote --repo owner/app      # merge approved promotion PRs
```

## See what awaits release

canopy's **Promote** lane lists closed issues whose work is merged into `from` but not yet in `to`. This tracking runs whenever `from` and `to` differ, even with `release.enabled` off.

## Count work as released only once it deploys

By default an issue leaves the Promote lane once its PR is in `to`. To keep it there until the production deploy succeeds, name the deploy workflow:

```json
"release": { "enabled": true, "from": "develop", "to": "main", "signal": { "workflow": "cd.yml" } }
```

The issue then leaves the lane once the newest completed `cd.yml` run on `to` is green on a commit that contains its PR. While the newest run is red, it stays. Details: [`repos[].release`](/reference/cambium/configuration/#repos).

Node details: [cambium graphs](/reference/cambium/graphs/).
