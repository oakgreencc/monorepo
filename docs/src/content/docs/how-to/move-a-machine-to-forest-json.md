---
title: Move a machine to forest.json
description: Fold the old per-service config files and state into ~/.oakgreen with oakgreen config migrate.
sidebar:
  order: 3
---

Do this once on a machine set up before `~/.oakgreen/forest.json` existed: one with `~/.cambium`, `~/.mycelium`, `~/.canopy`, `~/.config/graft` or `~/.oakgreen/proxy.json`. Until then, each service that finds only its old files exits with a message naming `oakgreen config migrate`.

1. Update the stack:

   ```sh
   oakgreen update
   ```

2. Preview the move. It changes nothing:

   ```sh
   oakgreen config migrate --dry-run
   ```

   Each line is a section folded into `forest.json`, the secrets going to `~/.oakgreen/env`, or a file moving under `~/.oakgreen`.

3. Stop the services whose files move. The dry run names any that are running:

   ```sh
   oakgreen stop
   ```

4. Run it:

   ```sh
   oakgreen config migrate
   ```

5. Start the services again. Agents that named an old path were removed, so this writes them afresh:

   ```sh
   oakgreen start
   ```

6. Check: `oakgreen doctor` passes `forest.json`, `env file` and `old paths`.

## If it stops with a conflict

It changes nothing when `forest.json` already has a section it would fold in, or a file already sits where one would move. Compare the two, keep one, remove the other, and run it again.

## If a directory is left behind

A file it does not know stays put, and its old directory with it. `oakgreen config migrate` lists it. Look inside, move what you need, remove the rest.

Layout and every moved path: [oakgreen CLI, Machine layout](/reference/oakgreen-cli/#machine-layout).
