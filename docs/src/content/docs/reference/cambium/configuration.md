---
title: cambium configuration
description: The cambium config file, every key and default, and the target repository's "cambium" key.
sidebar:
  order: 2
---

One JSON file: `--config`, else `$CAMBIUM_CONFIG`, else `~/.cambium/config.json`. Only `repos` is required.

## Defaults

```json
{
  "host": "<os.hostname()>",
  "engine": "legacy",
  "tickSeconds": 30,
  "stepTimeoutSeconds": 20,
  "repos": [{ "slug": "oakgreencc/monorepo", "path": "~/OGCC/monorepo", "baseBranch": "main" }],
  "phases": {
    "task": { "cap": 2, "wallClockMinutes": 60, "maxTurns": 200, "maxAttempts": 3, "maxReworks": 3 },
    "dispatch": {
      "cap": 0,
      "wallClockMinutes": 15,
      "maxTurns": 50,
      "maxAttempts": 3,
      "maxRounds": 3,
      "deferHours": 6,
      "maxDefers": 8
    },
    "rescue": { "cap": 0, "wallClockMinutes": 20, "maxTurns": 80, "maxAttempts": 1 }
  },
  "mergeQueueMinutes": 120,
  "mergeStallMinutes": 20,
  "watchEveryMinutes": 5,
  "merge": "none",
  "priorityLabels": ["priority:critical", "priority:high", "priority:medium", "priority:low"],
  "release": { "enabled": false, "time": "06:00" },
  "reaper": { "everyMinutes": 60, "staleMinutes": 30, "orphanDays": 3 },
  "stall": { "everyMinutes": 15, "starvedHours": 6, "graceMinutes": 60, "overdueMinutes": 60 },
  "intake": { "adopt": true, "ignoreLabels": [] },
  "rescue": {
    "everyMinutes": 60,
    "staleHours": 12,
    "graceMinutes": 30,
    "cooldownHours": 24,
    "maxRescues": 2,
    "causeRepo": null
  },
  "paths": {
    "home": "~/.cambium",
    "db": "~/.cambium/cambium.db",
    "heartbeat": "~/.cambium/state.json",
    "queues": "~/.cambium/queues.json",
    "logs": "~/.cambium/logs"
  },
  "logs": { "keepPerIssue": 20, "daemonMaxBytes": 10485760 },
  "graft": { "command": "graft", "app": null, "botLogin": null },
  "worker": { "command": "claude", "args": [], "graftApp": null, "fetch": true, "env": {} },
  "update": { "auto": false, "checkMinutes": 360 },
  "gc": { "everyMinutes": 60, "graceMinutes": 60, "staleDays": 14 },
  "costFlagUsd": 10
}
```

## Reloading

The daemon re-reads the file before every tick. Changes to caps, limits, `tickSeconds`, `repos`, `priorityLabels`, `release` and `worker` apply without a restart (logged as `config reloaded: <keys>`).

`host`, `engine`, `paths`, `logs` and `graft` are fixed at start. A change logs `restart cambium to apply` once.

A file that does not load, or has no `repos`, keeps the running config and logs one warning until fixed.

## Top level

| Key                  | Default    | Meaning                                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `host`               | hostname   | Written into `running` leases; Sweep only recovers leases with this host or none.                        |
| `engine`             | `"legacy"` | `"legacy"` (stage tick) or `"graph"`. Dispatch, release graphs, rescue, upkeep, red base and tracing need `"graph"`. |
| `tickSeconds`        | `30`       | Interval between ticks.                                                                                   |
| `stepTimeoutSeconds` | `20`       | Bound on each tick step; a step over it is logged and the tick moves on.                                  |
| `mergeQueueMinutes`  | `120`      | A submitted PR not merged after this long goes to `q:human` (`why:approve`).                              |
| `mergeStallMinutes`  | `20`       | An agent PR with auto-merge armed and green checks that GitHub still reports `BLOCKED` this long after arming goes to `q:human` (`why:approve`), with GitHub's state in the reason. A rule cambium cannot read holds it: a ruleset review, an approval for unattributed changes, or a required check that never reported. `0` turns it off. |
| `watchEveryMinutes`  | `5`        | How often each repo's [`watch`](#reposwatch) workflows are read. `0` turns watching off. |
| `merge`              | `"none"`   | Who merges a Task PR: `"none"` (merge queue, auto-merge or a human) or `"green"` (cambium, once CI is green; graph engine). Overridable per repo. |
| `priorityLabels`     | four `priority:*` | Scheduling order, first is highest. Unlabelled issues sort after all of them.                     |
| `costFlagUsd`        | `10`       | US dollars. An issue whose task-phase [cost](/reference/cambium/labels-and-state/#cost) is over this, with no merged PR, is flagged in the heartbeat and in canopy's Inbox as a session candidate. `0` turns the flag off. |

## `intake`

| Key                   | Default | Meaning                                                                                                   |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `intake.adopt`        | `true`  | An open issue in no queue gains `q:intake`, so it is triaged without anyone adding the label. Skipped: issues cambium has handled (they have a state comment), issues an agent PR names, and issues labelled `watch`, `red-base`, `rescue` or `stall`. |
| `intake.ignoreLabels` | `[]`    | Issues with any of these labels are never adopted, such as tracking or parent issues.                     |

## `repos[]`

| Key             | Default            | Meaning                                                                                       |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `slug`          | required           | `owner/name`.                                                                                 |
| `path`          | required           | Local clone. Worktrees are added from it; `graft` runs in it.                                 |
| `baseBranch`    |                    | Branch Task PRs land on.                                                                      |
| `requiredCheck` | `"ci"`             | Check whose runs on `baseBranch` decide [red base](/explanation/merging-and-red-base/). `null` turns the gate and repair off. |
| `merge`         | top-level `merge`  | Per-repo override.                                                                            |
| `release`       | see below          | Per-repo release settings (graph engine).                                                     |
| `phases`        | `{}`               | Per-repo overrides of `wallClockMinutes` and `maxTurns`, by phase: `{ "task": { "wallClockMinutes": 120 } }`. Other keys are refused. |
| `watch`         | `[]`               | Workflows whose latest run must be green. See [`repos[].watch`](#reposwatch). |

`repos[].release`: `{ "enabled", "time", "from", "to", "check" }`. `enabled` and `time` default to the top-level `release`; `from` to `baseBranch`; `to` to `"main"`; `check` to the repo's `requiredCheck`. A release is cut at the newest `from` commit where `check` is green; `null` cuts at the tip. A repo whose `from` equals `to` has no promotion PR.

### `repos[].watch`

Each entry is a workflow file name (`"cd.yml"`), or `{ "workflow", "branch", "issue" }`. `branch` defaults to the repo's `baseBranch`; `issue` defaults to `true`.

Every `watchEveryMinutes`, cambium reads the newest completed push or schedule run of each workflow on its branch. Cancelled and skipped runs are passed over.

- A failed, timed-out or startup-failed run logs a `warn` event. With `issue: true` it also opens one `q:human` issue labelled `watch` (only `q:human` if the repo lacks that label). A later failing run comments on that issue.
- The next green run logs an `info` event and closes the issue.
- A read that fails keeps the last verdict.

Verdicts are kept in the store across restarts, and each repo's are in the heartbeat as `repos[].watch`.

```json
"watch": ["release.yml", { "workflow": "e2e.yml", "branch": "develop", "issue": false }]
```

## `phases`

| Key                         | Default | Meaning                                                              |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `task.cap`                  | `2`     | Live Task workers, counted from tracked processes.                   |
| `task.wallClockMinutes`     | `60`    | Worker killed past this. A repo may override it (`repos[].phases`). |
| `task.maxTurns`             | `200`   | Passed as `--max-turns`.                                             |
| `task.maxAttempts`          | `3`     | Attempts before `q:human` + `why:budget`.                            |
| `task.maxReworks`           | `3`     | Reworks of one PR before `q:human` + `why:budget`.                   |
| `dispatch.cap`              | `0`     | Triage workers; `0` turns triage off.                                |
| `dispatch.wallClockMinutes` | `15`    |                                                                      |
| `dispatch.maxTurns`         | `50`    |                                                                      |
| `dispatch.maxAttempts`      | `3`     | Failed triage starts before `q:human`.                               |
| `dispatch.maxRounds`        | `3`     |                                                                      |
| `dispatch.deferHours`       | `6`     | Recheck delay when a `defer` verdict gives no `recheckHours`.        |
| `dispatch.maxDefers`        | `8`     | Defers before `q:human` + `why:triage`.                              |
| `rescue.cap`                | `0`     | Rescue workers; `0` turns rescue off.                                |
| `rescue.wallClockMinutes`   | `20`    |                                                                      |
| `rescue.maxTurns`           | `80`    |                                                                      |
| `rescue.maxAttempts`        | `1`     |                                                                      |

## Clocks

| Key                      | Default   | Meaning                                                                         |
| ------------------------ | --------- | ------------------------------------------------------------------------------- |
| `release.enabled`        | `false`   | Run the release step daily.                                                     |
| `release.time`           | `"06:00"` | Host-local `HH:MM`.                                                             |
| `reaper.everyMinutes`    | `60`      | Reaper interval; `0` turns it off.                                              |
| `reaper.staleMinutes`    | `30`      | An untracked agent PR idle this long is examined.                               |
| `reaper.orphanDays`      | `3`       | A PR naming no issue is closed after this long untouched.                       |
| `stall.everyMinutes`     | `15`      | [Stall fallback](/reference/cambium/graphs/#stall) interval; `0` turns it off.  |
| `stall.graceMinutes`     | `60`      | A `wait:blocked` issue is unparked this long after its last blocker closed; a chain into `q:human` is reported once parked this long. |
| `stall.overdueMinutes`   | `60`      | A `wait:deferred` issue is unparked this long past its `deferUntil`.            |
| `stall.starvedHours`     | `6`       | Starved: no merge for this long while only parked issues are queued.            |
| `rescue.everyMinutes`    | `60`      | Stuck-item sweep interval.                                                      |
| `rescue.staleHours`      | `12`      | Age for `stale-task`, `stale-intake` and `pr-stale`.                            |
| `rescue.graceMinutes`    | `30`      | A label change counts only after this long since the marker last moved.         |
| `rescue.cooldownHours`   | `24`      | An item rescued within this is skipped.                                         |
| `rescue.maxRescues`      | `2`       | Rescues per item per week before it goes straight to `q:human` + `why:rescue`.  |
| `rescue.causeRepo`       | `null`    | Repository for root-cause tickets; `null` files them in the item's own repo.    |
| `update.auto`            | `false`   | Self-update between ticks.                                                      |
| `update.checkMinutes`    | `360`     | Check interval; minimum 5.                                                      |

`retriage` is removed: the stall fallback replaced the daily re-triage. A `retriage` key in an old file is ignored.

### `gc`

| Key                | Default | Meaning                                                                           |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `gc.everyMinutes`  | `60`    | Worktree GC interval; `0` turns it off (`cambium gc` still works).               |
| `gc.graceMinutes`  | `60`    | A worktree touched within this (directory, HEAD, reflog, dirty path) is skipped. |
| `gc.staleDays`     | `14`    | Idle worktrees holding work GitHub lacks are archived after this.                |

GC skips the checkout itself, worker worktrees and locked worktrees (a Claude Code session lock counts only while its pid is alive). Verdicts:

| Verdict    | Condition                               | Action                                                                                         |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| complete   | `graft status`: GitHub holds all of it  | Removed with its local branch.                                                                 |
| stale      | Idle `staleDays`, work GitHub lacks     | Archived to `<home>/gc/<owner>__<name>/<dir>-<stamp>/` (`commits.bundle`, `changes.patch`, `untracked/`, `worktree.json`), then removed. |
| kept       | Anything else                           | Left; `cambium gc --dry-run` gives the reason.                                                 |

## `paths`, `logs`

| Key                    | Default                  | Meaning                                                 |
| ---------------------- | ------------------------ | ------------------------------------------------------- |
| `paths.home`           | `~/.cambium`             | Setting it moves every default path under it.           |
| `paths.db`             | `<home>/cambium.db`      | SQLite store: workers, mode, the daily cost ledger.     |
| `paths.heartbeat`      | `<home>/state.json`      | [Heartbeat](/reference/cambium/heartbeat/) file.        |
| `paths.queues`         | `<home>/queues.json`     | [Queue view](/reference/cambium/heartbeat/#queue-view-queuesjson) canopy reads. |
| `paths.logs`           | `<home>/logs`            | Daemon and worker logs.                                 |
| `logs.keepPerIssue`    | `20`                     | Worker runs kept per issue.                             |
| `logs.daemonMaxBytes`  | `10485760`               | Daemon log rotation size.                               |

Worker logs: `<paths.logs>/<owner>__<name>/issue-<n>/a<attempt>-<stamp>.{prompt.md,out.log,err.log}`.

Session briefs: `<paths.home>/briefs/<owner>__<name>/issue-<n>.md`, one per open `q:human` issue labelled `why:budget`. Each tick rewrites a brief whose content changed and deletes it once the issue leaves `q:human` or closes. A brief holds the issue's title, link, body (first 4,000 characters) and acceptance checks; its attempts, reworks, last failure, failed SHA and history; its agent PRs; the reasons earlier attempts failed; the repository path; and the verify and publish commands. Token-shaped text is replaced with `[redacted]`. Files are mode `0600`.

## `graft`, `worker`

| Key               | Default    | Meaning                                                                                           |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `graft.command`   | `"graft"`  | graft executable.                                                                                 |
| `graft.app`       | `null`     | App cambium acts as (`GRAFT_APP` for its own `graft` calls).                                      |
| `graft.botLogin`  | `null`     | That App's login. When set, only state markers written by it are trusted.                         |
| `worker.command`  | `"claude"` | Worker executable.                                                                                |
| `worker.args`     | `[]`       | Extra arguments appended to the worker command.                                                   |
| `worker.graftApp` | `null`     | App workers act as (`GRAFT_APP` in the worker's environment). Never shared with `graft.app`.     |
| `worker.fetch`    | `true`     |                                                                                                   |
| `worker.env`      | `{}`       | Extra environment for every worker; string values only.                                           |

## Target repository: `"cambium"` key

Read from the root `package.json` of the central checkout (`repos[].path`) at each worker start. Every field is optional.

```json
"cambium": {
  "worktree": { "root": ".claude/worktrees", "branch": "agent/{issue}-{slug}" },
  "install": "pnpm install --frozen-lockfile",
  "hydrate": { "dirs": [], "files": [] },
  "prepare": []
}
```

| Key               | Default                           | Meaning                                                                                                     |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `worktree.root`   | `.claude/worktrees`               | Worktree directory, relative to the clone.                                                                  |
| `worktree.branch` | `agent/{issue}-{slug}`            | `{issue}` required. `{slug}`: issue title in kebab case, at most 40 characters, cut at a word.              |
| `install`         | `pnpm install --frozen-lockfile`  | Run (`sh -c`) when `node_modules/.pnpm/lock.yaml` differs from `pnpm-lock.yaml`. `false` skips.             |
| `hydrate.dirs`    | `[]`                              | Git-ignored directories copied from the checkout (copy-on-write clone, else byte copy; never a link).       |
| `hydrate.files`   | `[]`                              | Git-ignored files copied likewise. `"hydrate": false` disables.                                             |
| `prepare`         | `[]`                              | Commands run with `sh -c` in the worktree, in order.                                                        |

- Worktree path: `<repos[].path>/<root>/<topic>`, topic being the branch less its first segment (`agent/12-fix-the-tick` → `12-fix-the-tick`).
- Created with `git fetch origin <baseBranch>` then `git worktree add --no-track -B <branch> <dir> origin/<baseBranch>`.
- A retry keeps the branch of its first attempt; an existing PR's branch wins over both.
- Prepare order: install-fresh, hydrate, prepare. A failure exits with `cambium: prepare failed: …` and is requeued as `spawn-failed`.
- Unknown keys, wrong types, paths outside the repository or an unparseable `package.json` fail the start (`spawn-failed`).
- Teardown requires `graft status <branch> -C <dir>` to end with `nothing local that GitHub does not have`; otherwise the worktree is kept and the reason logged.
