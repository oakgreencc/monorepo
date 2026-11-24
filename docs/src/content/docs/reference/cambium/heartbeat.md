---
title: Heartbeat
description: The shape of cambium's state.json, written at the end of every tick.
sidebar:
  order: 5
---

Written at the end of every tick to `paths.heartbeat` (default `~/.cambium/state.json`), whole and renamed into place. canopy and `oakgreen doctor` read it.

- `version` changes only on an incompatible change. Current: `1`.
- Times are ISO 8601 UTC strings. Durations are milliseconds.
- `engine`, `graphs`, `costFlagUsd`, `repos[].cost`, `repos[].watch`, `repos[].stalls` and `repos[].rateLimit` were added within version 1; older heartbeats lack them.

## Top level

| Field     | Type   | Meaning                                                                 |
| --------- | ------ | ----------------------------------------------------------------------- |
| `version` | number | `1`.                                                                    |
| `host`    | string | `config.host`.                                                          |
| `pid`     | number | Daemon pid.                                                             |
| `mode`    | string | `running` \| `paused` \| `draining`.                                    |
| `daemon`  | object | `{ startedAt, tickSeconds }`; `startedAt` is `null` outside the daemon. |
| `tick`    | object | `{ n, startedAt, finishedAt, durationMs, nextAt }`. `n` counts ticks since start; `nextAt` = `finishedAt` + `tickSeconds`. |
| `steps`   | array  | `{ name, ok, ms, error }` in order: read, reconcile, watch, sweep, schedule, release. Paused: read only. Draining: no schedule. |
| `counts`  | object | Summed over repos read this tick (below).                               |
| `caps`    | object | `{ task, dispatch }`.                                                   |
| `repos`   | array  | Per repo: `{ slug, ok, error, counts, base, watch, stalls, rateLimit, cost }`; `counts` is `null` when the read failed or was paused; `rateLimit` is `{ cost, remaining, resetAt }`, the GraphQL budget after the read (reads pause until `resetAt` once fewer than five reads' worth is left); `base` is red-base state; `watch` is one `{ workflow, branch, state, run, issue, checkedAt, error }` per [watched workflow](/reference/cambium/configuration/#reposwatch), `state` being `green`, `red` or `unknown`; `stalls` is one `{ number, url, title, branch, base, armedAt, since, minutes, reason }` per [stalled](/reference/cambium/graphs/#stalled-merges) PR that is not an agent's; `cost` is below. |
| `workers` | array  | Tracked workers (below).                                                |
| `events`  | array  | Last 100 log lines, oldest first: `{ at, level, msg, repo?, issue? }`; `level` is `info` \| `warn` \| `error`. |
| `engine`  | string | `legacy` \| `graph`.                                                    |
| `graphs`  | array  | Every graph cambium defines, as `describeGraph()` returns it.           |
| `costFlagUsd` | number | `config.costFlagUsd`.                                               |

## `counts`

| Field      | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `intake`   | Open issues labelled `q:intake`.                                  |
| `task`     | Open issues labelled `q:task`.                                    |
| `human`    | Open issues labelled `q:human`.                                   |
| `promote`  | Open `q:promote`, plus closed issues awaiting promotion.          |
| `running`  | Open issues labelled `running`.                                   |
| `review`   | Open `agent/*` PRs.                                               |
| `workers`  | Tracked worker processes on this host (top level only).           |

## `repos[].cost`

`{ issues, days }`. Both are empty when nothing has cost anything.

`issues`: open issues in `q:intake`, `q:task` or `q:human`, or labelled `running`, whose marker has a [cost](/reference/cambium/labels-and-state/#cost). Most expensive first.

| Field                   | Meaning                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `number`, `title`, `url`| The issue.                                                                      |
| `labels`                | Its labels.                                                                     |
| `cost`                  | The marker's `cost`: `total`, `triage`, `task`, `rescue`, `lastLog`.            |
| `flagged`               | Task-phase `usd` over `costFlagUsd` and no merged PR closes it: a session candidate. |

`days`: the repo's spend per UTC day over the last 14 days, oldest first; days with no spend are left out. Each is `{ day, triage, task, rescue, total }` in US dollars. It comes from the SQLite ledger, so a lost database starts it again.

## `workers[]`

| Field          | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `repo`         | `owner/name`.                                                  |
| `issue`        | Issue number.                                                  |
| `phase`        | `task`, `dispatch`, `rescue`.                                  |
| `pid`, `alive` | Process and whether it is alive.                               |
| `attempt`      | Attempt number.                                                |
| `branch`       | Agent branch.                                                  |
| `worktree`     | Absolute worktree path.                                        |
| `startedAt`    | Start time.                                                    |
| `elapsedMs`    | Time since start.                                              |
| `wallClockMs`  | Wall-clock cap.                                                |
| `killedReason` | Set once killed, until the transition is written.              |
| `logs`         | `{ stdout, stderr }` paths.                                    |

## `graphs[]`

```jsonc
{
  "name": "task",
  "version": 2,
  "about": "Turns a q:task issue into a published PR; …",
  "entry": { "queue": "q:task", "node": "start-worker" },
  "nodes": [{ "name": "worker-running", "kind": "wait", "queue": "q:task", "running": true, "about": "…" }],
  "edges": [{ "from": "start-worker", "to": "worker-running", "when": "started" }]
}
```

`to: null` ends the graph. `when` is the condition's function name, `null` for the fallback edge.

## Queue view (`queues.json`)

Written every tick, after the other steps and before the heartbeat, to `paths.queues` (default `~/.cambium/queues.json`), whole and renamed into place. It is canopy's board, built from the snapshot cambium read that tick, so canopy need not query GitHub for it. Its write is the `queues` step.

| Field         | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `version`     | `1`. canopy reads no other.                                                        |
| `writtenAt`   | When it was written.                                                               |
| `tickSeconds` | `config.tickSeconds`.                                                              |
| `repos`       | Per repo: `{ slug, ok, error, fetchedAt, columns, prs, stranded }`.                |

- `columns`: `{ intake, waiting, task, running, human, promote }`, placed as in [canopy](/reference/canopy/#queue-placement). Each item is `{ repo, number, title, url, createdAt, updatedAt, labels, why, priority }`; a `waiting` item adds `wait: { kind, reason, until, blockers }`. `promote` includes closed issues awaiting promotion.
- `prs`: open `agent/*` PRs: `{ repo, number, title, url, branch, draft, checks, tally, inMergeQueue, autoMerge, queue, mergeState, additions, deletions, files, closes, createdAt, updatedAt }`.
- `stranded`: open issues in no queue whose `agent/*` PR, among the 50 most recently closed unmerged, has no open replacement. Each adds `pr: { number, title, url, branch, closedAt }`.
- A repo not read this tick (a failed or paused read) keeps its last board, with `ok: false`, the `error`, and the `fetchedAt` of that board.

canopy treats the file as stale once `writtenAt` is more than 3 × `tickSeconds` old, and then reads GitHub itself.

## `cambium status --json`

Returns `{ "mode", "heartbeat" }`. The mode comes from the SQLite database, so it is available while the daemon is down. Exit 1 when the heartbeat is missing or older than 3 ticks.
