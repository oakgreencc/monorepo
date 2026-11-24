---
title: cambium CLI
description: Every cambium command, its flags and exit behaviour.
sidebar:
  order: 1
---

`cambium` is published as `@oakgreencc/cambium`. It needs Node ≥ 22.13 (`node:sqlite`) and `graft` on `PATH`.

Every command takes `--config <file>`. Default: `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`.

## Daemon and mode

| Command                   | Behaviour                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cambium start [--once]`  | Foreground daemon, one tick every `tickSeconds`. `--once` runs a single tick. SIGTERM/SIGINT stop it after the current tick; workers keep running and are re-adopted on restart. One daemon per database. |
| `cambium status [--json]` | Mode, last tick, queue counts, workers, failed steps. Exit 1 when there is no heartbeat or it is older than 3 ticks. `--json` returns `{ "mode", "heartbeat" }`, also while the daemon is down. |
| `cambium pause`           | Read and heartbeat only: no transitions, no starts. Running workers are left alone.                                                                          |
| `cambium drain`           | Reconcile, watch and sweep as usual; start nothing new.                                                                                                      |
| `cambium resume`          | Back to `running`.                                                                                                                                          |

The mode is stored in the SQLite database (`paths.db`, table `control`).

## Foreground runs

| Command                                                      | Engine  | Behaviour                                                                                                                                                                  |
| ------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cambium run task --issue <n> [--repo <o/n>]`                | legacy  | Claim one open `q:task` issue, run its worker in the foreground, then make the transition the daemon would.                                                                |
| `cambium run task --issue <n> [--repo <o/n>] [--follow]`     | graph   | Advance one issue through the [task graph](/reference/cambium/graphs/#task). A `q:task` issue without a lease starts with a foreground worker; anything else resumes where its marker rests. |
| `cambium run pr --issue <n> [--repo <o/n>] [--follow]`       | graph   | One turn of the [PR graph](/reference/cambium/graphs/#pr) for the issue's PR.                                                                                              |
| `cambium run dispatch --issue <n> [--repo <o/n>] [--follow]` | graph   | Triage one `q:intake` issue with a foreground triage worker (the dispatch cap does not apply), then end the [dispatch graph](/reference/cambium/graphs/#dispatch). A tracked triage worker resumes at `triaging`. |
| `cambium run release-prepare [--repo <o/n>]`                 | graph   | Run [release-prepare](/reference/cambium/graphs/#release-prepare) now, whatever `release.time`: cut a release branch and open its PR. Counts as the day's run.                                                 |
| `cambium run release-promote [--repo <o/n>] [--issue <pr>]`  | graph   | A [release-promote](/reference/cambium/graphs/#release-promote) turn for each `q:promote` promotion PR, or only `<pr>`. PRs not ready are reported.                       |
| `cambium run rescue [--repo <o/n>] [--issue <n>]`            | graph   | Without `--issue`: list items the [rescue](/reference/cambium/graphs/#rescue) sweep would find stuck now, with symptoms; changes nothing. With it: rescue that item with a foreground worker and carry out its verdict. |

`run task`, `run pr` and `run dispatch` stop at the first wait that is not ready. `--follow` re-reads and polls every `tickSeconds` until the graph ends (for `run pr`, until the issue is closed). Beside a live daemon (heartbeat less than 3 ticks old), `--follow` reads the daemon's [snapshots file](/reference/cambium/heartbeat/#snapshots-snapshotsjson) instead of GitHub, waiting for each tick's new snapshot. With no daemon, a stale heartbeat, or a missing or unreadable file, it reads GitHub itself every `tickSeconds`. It also reads GitHub when the daemon has not read the repo for 3 ticks. Without `--follow`, `run` always reads GitHub.

## Decisions

| Command | Behaviour |
| --- | --- |
| `cambium decide show <o/n#n> [--json] [--lens <l>]` | Where the issue's decision stands, from its `cambium:decide` marker (or the start, seeded from its ask), and what the next step needs. `--json` prints the state. |
| `cambium decide advance <o/n#n> --output <file\|-> [--as <login>] [--lens <l>]` | Check one step's output (JSON, `-` reads stdin) against the current step's schema. A bad output is refused with every problem listed, exit 1, and nothing changes. A good one runs the step, writes the marker and prints the next step. |

`--as` names the person deciding (default `$GITHUB_USER`, then `$USER`); the answer comment credits them. `--lens` (`product` or `technical`) is needed only when the issue's ask has none. The `/oakgreen:decide` command in the oakgreen plugin runs these for you: see [Answer the human queue](/how-to/answer-the-human-queue/#decide-in-a-session).

## Maintenance

| Command                                    | Behaviour                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cambium gc [--dry-run] [--repo <o/n>]`    | Collect worktrees now. `--dry-run` only reports. See [worktree GC](/reference/cambium/configuration/#gc).                                                                        |
| `cambium install [--dry-run]`              | Write the launchd agent `~/Library/LaunchAgents/com.oakgreencc.cambium.plist` (`KeepAlive`, `RunAtLoad`) for `start --config <this config>`. `--dry-run` prints it. Does not call `launchctl`; prints the command. |
| `cambium update [--check] [--version <v>]` | Install the latest version (or `<v>`, older included) from npm into this global install, then SIGTERM the launchd agent so KeepAlive starts the new version. `--check` only reports. No config file needed. |

## Self-update

`cambium update` and `update.auto` act only on a global npm install (`<prefix>/lib/node_modules/@oakgreencc/cambium`), into the same prefix. A source checkout, `npm link` or a copy inside another package's `node_modules` is left alone. npm is the one next to the running Node, else `npm` on `PATH`. The version is the registry's `latest` dist-tag.

- When the agent is not loaded, `cambium update` only installs.
- `update.auto` applies only when the process is the launchd agent (`XPC_SERVICE_NAME=com.oakgreencc.cambium`). A failed check or install is a warning, retried at the next check. The last check time is `update.lastCheck` in the `control` table.
- The plist is never rewritten by an update.

## Files

| Path                                    | Contents                       |
| --------------------------------------- | ------------------------------ |
| `<paths.logs>/cambium.log`              | Daemon log; one `.1` kept      |
| `<paths.logs>/cambium.launchd.err.log`  | launchd's stderr               |
| `paths.heartbeat`                       | [Heartbeat](/reference/cambium/heartbeat/) |
| `paths.db`                              | SQLite: tracked workers, mode, clocks |
