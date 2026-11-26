---
title: Install the stack
description: Put oakgreen on a Mac and get every chosen component to a passing doctor check.
sidebar:
  order: 1
---

You need macOS (the services are launchd agents), Node 22.13 or newer, and admin rights on the GitHub repository agents will work in.

## With the setup wizard

The `oakgreen` plugin asks which components you want, runs each step after you agree, and stops when `oakgreen doctor` passes for them.

1. In Claude Code:

   ```sh
   claude plugin marketplace add oakgreencc/monorepo
   claude plugin install oakgreen@oakgreencc
   ```

2. From a clone of your repository, ask for "set up oakgreen for my repo", or run `/oakgreen:oakgreen-setup`.
3. Do the steps it hands you (creating the GitHub App, writing secrets). It checks each one before moving on.

In Kiro: **Powers** → **Add Custom Power** → **Import power from a repository URL** → `https://github.com/oakgreencc/monorepo/tree/main/packages/plugin`.

## By hand

1. Install the CLI. It brings every tool with it:

   ```sh
   npm install -g oakgreen
   ```

   Install globally, not through `npx`: the launchd agents point at the installed paths.

2. Install Claude Code and sign in once (`claude`), if cambium will run workers.
3. Set up graft on the repository: [Set up graft on a repository](/how-to/set-up-graft-on-a-repository/). Note the App slug `graft doctor` prints.
4. From the clone, preview, then run the bootstrap:

   ```sh
   oakgreen setup --dry-run --repo owner/name
   oakgreen setup --repo owner/name
   ```

   It writes a `cambium` section into `~/.oakgreen/forest.json` if there is none, creates an empty `~/.oakgreen/env` (mode 600) for secrets, creates the queue labels, and writes the label guide `docs/agents/triage-labels.md` plus a pointer in `CLAUDE.md` or `AGENTS.md`. Commit those two files yourself.

5. In the `cambium` section of `~/.oakgreen/forest.json`, set `graft.app` to the App slug, `graft.botLogin` to `<slug>[bot]` and `worker.graftApp` to the slug workers act as (often the same).
6. Make sure the repository's `.gitignore` contains `.claude/worktrees`.
7. Start the services:

   ```sh
   oakgreen start
   ```

8. Check:

   ```sh
   oakgreen doctor
   ```

   Every failing line names its fix. Right after a start, `cambium heartbeat` fails until the first tick finishes (30 s by default).

## Next

- [Add a repository to cambium](/how-to/add-a-repository-to-cambium/) for more repositories or non-default settings.
- [Connect intake sources](/how-to/connect-intake-sources/) and [Set up tracing](/how-to/set-up-tracing/) are optional.
- [oakgreen CLI reference](/reference/oakgreen-cli/) lists every doctor check.
