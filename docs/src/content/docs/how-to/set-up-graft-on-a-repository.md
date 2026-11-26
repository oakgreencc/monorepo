---
title: Set up graft on a repository
description: Create the GitHub App, bootstrap a repository and confirm agents write as the App.
sidebar:
  order: 2
---

Setup opens a browser and stores a private key on this machine, so a person runs it. In Claude Code, prefix each command with `!` to run it as yourself in the session.

1. Install the CLI (once per machine). It must be on `PATH`; hooks and the git credential helper call it by name.

   ```sh
   npm install -g @oakgreencc/graft
   ```

2. From inside the repository's clone, run:

   ```sh
   graft setup
   ```

   If the repository's owner has no App yet, this creates one through GitHub's manifest page (named `<owner>-agents` by default; `--name` picks another), then bootstraps the repository. To run the two halves separately, use `graft setup app`, then `graft setup project`.

   If you already have an App, register it with `graft setup app --manual`.

3. In the browser, confirm the App, then install it on **only the repositories agents should work in**.
4. Review the diff `graft setup project` shows. It writes `.graft.json`, seeds CODEOWNERS and merges into `.claude/settings.json`. Commit those files yourself.
5. If `gh` is not logged in as a repository admin, import the ruleset it saved under `~/.oakgreen/graft/rulesets/` at **Settings** → **Rules** → **New ruleset** → **Import a ruleset**.
6. Restart every Claude Code session already open in the repository. The git environment and hooks load at session start.
7. Check:

   ```sh
   graft doctor
   ```

   `✗` lines are broken and name their fix. `!` lines work but protect less than they appear to.

## Options worth deciding up front

| Flag on `graft setup project` | Decides |
| --- | --- |
| `--required-check <job>` | The CI check that must pass before merging. Add it once CI exists. |
| `--mergeable <a,b \| none>` | Which base branches agents may merge into. |
| `--app-branches <prefix \| none>` | Confine the App to creating branches under one prefix (`agent/`). |
| `--auto-merge` / `--no-auto-merge` | Turn on **Allow auto-merge**, needed by `graft pr merge --auto`. |
| `--config-in package.json` | Keep the policy under a `"graft"` key instead of `.graft.json`. |

Full lists: [graft CLI](/reference/graft/cli/), [graft configuration](/reference/graft/configuration/), [GitHub App and rulesets](/reference/graft/github-app/).

## A second App for workers

If cambium's workers should act as a different identity, repeat step 2 with `graft setup app --name <name>`, then check with `GRAFT_APP=<name> graft doctor`.
