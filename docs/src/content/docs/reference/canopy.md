---
title: canopy
description: canopy's flags, tabs, HTTP endpoints and what it reads from cambium and mycelium.
sidebar:
  order: 6
---

canopy is a local, read-only page over cambium's heartbeat, the GitHub queues, cambium's traces and mycelium's intake sources. It holds no credentials and writes nothing.

Package: `@oakgreencc/canopy`. Node ≥ 22, no runtime dependencies. GitHub is read through `graft graphql`; `graft` must be on `PATH`. While cambium runs, the queues come from its [queue view](#queue-view) instead.

## Commands

| Command | Behaviour |
| --- | --- |
| `canopy [flags]` | Serves the page in the foreground. |
| `canopy install [flags] [--dry-run]` | Writes `~/Library/LaunchAgents/com.oakgreencc.canopy.plist`, serving with the given flags. `--dry-run` prints it. Log: `~/.canopy/logs/canopy.log`. |

## Flags

| Flag | Default |
| --- | --- |
| `--port <n>` | `4317` |
| `--host <addr>` | `127.0.0.1` |
| `--state <file>` | cambium config's `paths.heartbeat` (or `<paths.home>/state.json`), else `~/.cambium/state.json` |
| `--queues <file>` | cambium config's `paths.queues` (or `<paths.home>/queues.json`), else `~/.cambium/queues.json` |
| `--traces <file>` | `<paths.home>/otel/traces.jsonl` from the cambium config, else `~/.cambium/otel/traces.jsonl` |
| `--intake <file>` | `$MYCELIUM_STATUS`, else `~/.mycelium/status.json` |
| `--config <file>` | `$CAMBIUM_CONFIG`, else `~/.cambium/config.json` |
| `--repo <owner/name>` | Repeatable. Else the config's `repos[].slug`, else the heartbeat's repos. |
| `--cache <seconds>` | `60`; minimum `15`. Applies to GitHub reads only. |
| `--graft <cmd>` | `graft` |

## Tabs

The header always shows mode and last tick. The tab is kept in the URL hash.

| Tab | Hash | Shows |
| --- | --- | --- |
| Inbox | `#inbox`, `#inbox/<owner>/<name>/<n>` | `q:human` items, stranded issues and session candidates, grouped, in a list beside a reading pane. |
| Queue | `#queue` | Triage, Running and Pull requests; the `q:intake`, `q:task` and `q:promote` lanes; a band of every issue by stage; cost per day by phase. |
| Graphs | `#graphs`, `#graphs/<name>` | Each cambium graph drawn, with the last 24 hours of moves replayed. |
| Traces | `#traces`, `#traces/<trace id>` | One row per traced run; a span waterfall per run. |
| Intake | `#intake` | mycelium's sources: which are configured, each one's state, last pass and filings; what the rest lack; recent filings. |
| Health | `#health` | Last tick, workers, events. |

### Inbox groups

Each item sits in the first group it matches. Empty groups are hidden; the sort applies within each group.

| Group | Labels |
| --- | --- |
| Needs a session | `why:budget`, `ask:decide` with `ask:session`, or a session candidate (see [Cost](#cost)) |
| Answer in a comment | any other `ask:decide` |
| Offline chores | `ask:verify`, `ask:chore` |
| Approvals | `why:approve`, `ask:approve` |
| Other | no `ask:*` label to go by |
| PR closed | stranded issues |

Approvals are matched before the other groups.

### Inbox keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrow keys | Move |
| `Enter` | Read |
| `o` | Open on GitHub |
| `Escape` | Back to the list (narrow screens) |

### Interactive session

A `q:human` item cambium wrote a session brief for (`<home>/briefs/<owner>__<name>/issue-<n>.md`, currently `why:budget` only) shows **Interactive session** in the reading pane: the command `cd <repo path> && claude "$(cat <brief>)"` and a **Copy** button. The repo path comes from `repos[].path` in the cambium config; without one the command has no `cd`. Items without a brief show nothing.

### Queue placement

| Labels on an open issue | Column |
| --- | --- |
| `running` with `q:intake` | Triage |
| `running` with `q:task` | Running |
| `q:intake` with `wait:deferred` or `wait:blocked` | Deferred / Blocked (waiting) |
| `q:intake` | Intake |
| `q:task` | Task |
| `q:promote` (open, or closed and not yet promoted) | Promote |
| `q:human` | Inbox |

A **stranded** issue is open, carries no queue label, and its `agent/*` PR closed unmerged with no open agent PR closing it. Read from the 50 most recently updated closed PRs per repository.

### Intake

Read from mycelium's [status file](/reference/mycelium/#status-file); filings are counted from its `mycelium.intake` spans. The tab badge counts configured sources and turns amber when one is failing or overdue, or mycelium is not running.

| State | Meaning |
| --- | --- |
| polling | The last pass succeeded and the next is on time. |
| first pass due | Configured; no pass yet. |
| failing | The last pass failed. Its error is shown under the row. |
| overdue | The next pass is more than 2 minutes, or one interval, late. When every source is overdue, mycelium is reported as possibly stopped. |
| stopped | mycelium stopped cleanly. |

### Cost

From the heartbeat's [`repos[].cost`](/reference/cambium/heartbeat/#reposcost).

| Where | Shows |
| --- | --- |
| Inbox rows, reading pane, lane and Triage/Running cards | What the issue has cost so far; per phase on hover. Red when flagged. |
| Queue figures | The last 7 UTC days, each a column stacked by phase (triage, task, rescue), summed over repositories. |
| Inbox | A flagged issue (task spend over cambium's `costFlagUsd`, no merged PR) is a **session candidate**: tagged `flag:cost` (filter "Flag", "over budget"), and listed with kind "session candidate" if it is not already in `q:human` or stranded, and grouped under "Needs a session" (unless it awaits an approval). Its reading pane says so. |

## HTTP endpoints

Only `GET` and `HEAD` are answered, and only for a loopback `Host` (or the `--host` given).

| Endpoint | Returns |
| --- | --- |
| `GET /` | One self-contained HTML page; polls `/api/state` every 5 s. |
| `GET /api/state` | `{ now, pollMs, cacheMs, notes, heartbeat, github, traces, intake, cost }` |
| `GET /api/traces` | Trace file fields plus `traces`: the newest 200 runs. |
| `GET /api/traces/<trace id>` | `{ summary, spans }`, spans in tree order with `depth`. 404 for an unknown id. |
| `GET /api/issue/<owner>/<name>/<n>` | `{ issue, fetchedAt, error }` for an issue in a watched repository. 404 otherwise. |

### `/api/state` fields

| Field | Shape |
| --- | --- |
| `heartbeat` | `{ status, path, message, stale, ageMs, staleAfterMs, data }`. `status`: `ok`, `missing`, `unreadable`, `unknown-version`. `stale` after 3 × `tickSeconds`. |
| `github` | `{ repos, columns: { intake, waiting, task, running, human, promote }, prs, stranded, flagged, fetchedAt, cached, source, fallback }`. `source`: `cambium`, `github` or `mixed`. `fallback`: why canopy read GitHub itself, or `null`. A `human` item with a session brief carries `brief: { path, command }`. Each column and stranded item has `cost`: `{ usd, triage, task, rescue, runs, flagged }`, or `null`. `flagged`: session candidates not in `q:human` or stranded. |
| `traces` | `{ status, path, message, files, malformed, total, errored, byIssue, progress, recent, flow }`. `status`: `ok`, `missing`, `unreadable`. |
| `intake` | `{ status, path, message, running, data, activity }`. `status`: `ok`, `missing`, `unreadable`, `unknown-version`. `data.sources[]` adds `state` to the status file's entry. `activity`: `{ bySource: { <source>: { day, week, lastAt } }, recent }`, or `null` without traces. |
| `cost` | `{ days, flagUsd }`. `days`: the last 7 UTC days, oldest first, each `{ day, triage, task, rescue, total }` in US dollars. `flagUsd`: the heartbeat's `costFlagUsd`, or `null`. |

## Inputs

| Input | Source |
| --- | --- |
| Heartbeat | cambium's `state.json`, schema [`version: 1`](/reference/cambium/heartbeat/). Any other version is reported, not parsed. |
| Traces | The local collector's OTLP/JSON file and rotated backups (`traces-<time>.jsonl`), newest first, up to 64 MB. Re-parsed only when size or mtime changes. |
| Intake | mycelium's status file, schema `version: 1`. Any other version is reported, not parsed. |
| Session briefs | `<paths.home>/briefs/` from the cambium config, else `~/.cambium/briefs/`. Checked for each `q:human` item on every `/api/state`. |
| Queues | cambium's [queue view](#queue-view). Else GitHub labels, through `graft graphql`, each repository's answer cached for `--cache` seconds; a failed refresh keeps the last good answer. |
| Issue pane | GitHub, through `graft graphql`, cached per issue for `--cache` seconds. |

## Queue view

cambium writes its board to [`queues.json`](/reference/cambium/heartbeat/#queue-view-queuesjson) every tick. canopy re-reads it on each `/api/state` and makes no GitHub call for the queues while it is fresh.

canopy queries GitHub for a repository when the file:

- is missing, unreadable or another `version`;
- is more than 3 × its `tickSeconds` old (90 s at the default 30 s tick), i.e. cambium is down;
- does not list that repository.

The page then shows a **Queues read from GitHub** banner saying which, and the header shows "GitHub read" instead of "queues read by cambium".
