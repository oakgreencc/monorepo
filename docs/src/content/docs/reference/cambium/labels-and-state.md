---
title: Labels and state
description: The GitHub labels cambium uses as its queue, the state comment it owns on each issue, and the worker contract.
sidebar:
  order: 3
---

GitHub holds cambium's state. Only cambium moves these labels; workers have `graft issue label` and `graft issue edit` denied.

## Labels

| Label                                         | Meaning                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `q:intake`                                    | Awaiting triage, or parked by it.                                                               |
| `q:task`                                      | Ready for a Task worker.                                                                        |
| `q:human`                                     | Needs a person; the `why:*` label says why.                                                     |
| `q:promote`                                   | Open: a promotion PR. Closed issue: merged into `release.from`, not yet in `release.to`.        |
| `running`                                     | A worker holds the lease (with `q:task` or `q:intake`).                                         |
| `why:budget`                                  | Attempts or reworks spent.                                                                      |
| `why:triage`                                  | Sent to `q:human` by triage.                                                                    |
| `why:approve`                                 | A merge only a human may make.                                                                  |
| `why:reject`                                  | Rejected.                                                                                       |
| `why:rescue`                                  | The rescue graph could not unstick it.                                                          |
| `ask:decide`                                  | With `q:human`: a choice only a person can make; the state comment lists the options.           |
| `ask:verify`                                  | With `q:human`: a check only a person can make, such as on a physical device.                   |
| `ask:chore`                                   | With `q:human`: offline work, such as a store listing or paperwork.                             |
| `ask:approve`                                 | With `q:human`: a yes or no on something already written.                                       |
| `ask:session`                                 | With an `ask:*` kind: a live session with the code would help answer it.                        |
| `wait:deferred`                               | Parked by a `defer` verdict until `deferUntil`.                                                 |
| `wait:blocked`                                | Parked until its GitHub "blocked by" issues close.                                              |
| `red-base`                                    | A repair issue cambium opened for a red base branch.                                            |
| `rescue`                                      | A root-cause ticket filed by the rescue graph.                                                  |
| `stall`                                       | With `q:human`: a report of issues that block each other, or wait on a `q:human` issue.         |
| `priority:critical` … `priority:low`          | Scheduling order (configurable via `priorityLabels`).                                           |
| _no `q:` label_, open `agent/*` PR            | Submitted: the PR is in review or the merge queue.                                              |

An open issue carries at most one `q:*` label. `why:*` and `ask:*` labels leave with `q:human`; a new hand-off into `q:human` replaces the `ask:*` labels. Rescue reports `why:*` or `ask:*` without `q:human` as `why-outside-human`. `oakgreen setup` creates every label except the priorities. In a repo without the `ask:*` labels, a hand-off to `q:human` adds `why:*` alone and logs a warning; the ask is still in the state comment.

## State comment

Each issue cambium touches gets one comment it owns and edits in place. The first line is a hidden marker; the rest renders it for people.

```html
<!-- cambium:state {"v":1,"phase":"task","stage":"queued","attempt":2,"pr":120,"branch":"agent/12-fix-the-tick","host":null,"start":null,"submittedAt":"…","queued":false,"failedSha":"deadbeef…","lastFailure":"CI red on PR #120 …","history":[{"at":"…","attempt":1,"outcome":"ci-red","reason":"…","pr":120}]} -->
```

### Marker v1 (legacy engine)

| Field          | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `v`            | `1`.                                                                                                        |
| `phase`        | `task`, `dispatch`, …                                                                                       |
| `stage`        | `queued` \| `running` \| `submitted` \| `human` \| `done`.                                                  |
| `attempt`      | Attempt the next or current worker runs as, from 1.                                                         |
| `pr`, `branch` | The agent PR and its branch.                                                                                |
| `host`, `start`| Set while `running`.                                                                                        |
| `submittedAt`  | When the PR was submitted.                                                                                  |
| `failedSha`    | PR head CI was red on. The same commit is never requeued twice; a worker that does not move past it has failed. |
| `lastFailure`  | Reason for the last failure.                                                                                |
| `history`      | Last 20 outcomes. `log` names the worker's stdout log on the host.                                          |

`--` inside the JSON is escaped so the comment cannot end early.

### Marker v2 (graph engine)

The graph engine writes v2 without `stage`. `node` is where the issue rests; `graph` names the graph. Further fields:

| Field                       | Meaning                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `enteredAt`                 | When the issue entered its current node.                             |
| `reworks`                   | Reworks of the current PR.                                           |
| `mergeRefusal`              | Last merge refusal and the head it applied to.                       |
| `triage`                    | Title and acceptance checks from an `actionable` verdict.            |
| `deferUntil`, `deferReason` | Set at `deferred`.                                                   |
| `blockedBy`                 | Open blocking issues, set at `blocked`.                              |
| `reply`                     | Human replies quoted to the next triage, until it lands a verdict.   |
| `ask`                       | At `to-human`: what the person is asked (`kind`, `question`, `options`, `recommendation`, `interactive`). |
| `traceparent`               | W3C traceparent of the issue's trace; `null` with tracing off.       |

At `to-human`, the comment renders the `ask` under the status line: the question, the numbered options with their tradeoffs, the recommendation, and how to answer.

A marker at a node the current graph version no longer has restarts at the entry node with a `graph-changed` history entry.

### Cost

Both engines add `cost` once an issue's first worker has exited with a `result` event. It accumulates for the life of the issue; every marker write keeps it.

```json
"cost": {
  "total":  { "usd": 6.1, "input": 210, "output": 64000, "cacheRead": 9100000, "cacheCreation": 240000, "runs": 3 },
  "triage": { "usd": 0.6, "…": "…", "runs": 1 },
  "task":   { "usd": 5.5, "…": "…", "runs": 2 },
  "rescue": { "usd": 0, "…": "…", "runs": 0 },
  "lastLog": "/Users/me/.cambium/logs/o__r/issue-12/a2-….out.log"
}
```

| Field                        | Meaning                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `total`                      | Sum over every phase.                                                                         |
| `triage`, `task`, `rescue`   | Per phase. Triage is the `dispatch` worker.                                                   |
| `usd`                        | The `result` event's `total_cost_usd`, summed.                                                |
| `input`, `output`            | `usage.input_tokens`, `usage.output_tokens`, summed.                                          |
| `cacheRead`, `cacheCreation` | `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, summed.                 |
| `runs`                       | Worker runs counted.                                                                          |
| `lastLog`                    | Stdout log of the last run counted. The same run is never counted twice.                      |

A worker with no `result` event (killed, or its log truncated) adds nothing. A marker without `cost` counts from zero. The rendered comment shows `cost $<total>`.

### History outcomes

`submitted`, `failed`, `killed`, `lost`, `spawn-failed`, `ci-red`, `dequeued`, `stalled`, `merged`, `budget`. The graph engine also records `branch-updated`, `merge-armed`, `merge-refused`, `pr-closed`, `base-red`, `human-reply`, `rescued`, `graph-changed`.

### Trust

With `graft.botLogin` set, only markers written by that login are trusted.

## Decision comment

An interactive decision on an `ask:decide` + `ask:session` issue keeps its own comment, edited in place: a readable line, then a hidden `<!-- cambium:decide {…} -->` marker holding the whole decision. Any session can resume from it alone.

| Field     | Meaning                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `node`    | Where the decision rests in the `decide` graph.                                                   |
| `status`  | `leased` (in progress), `paused` (idle; a reply resumes it) or `done`.                            |
| `outcome` | Once `done`: `answered` or `abandoned`.                                                           |
| `input`   | The decision so far: facts, question rounds and answers, the draft, and the lease.                |
| `error`   | The error the last turn stopped on, if any.                                                       |

While the decision is `leased` or `paused`, a reply on the issue does not send it back to triage. A decision with no reply for its idle timeout (default 24 hours) pauses. See the [cambium README](https://github.com/oakgreencc/monorepo/tree/main/packages/cambium#the-decide-graph).

## Requeue

A requeue sets `q:task` with `attempt + 1`. Once `maxAttempts` are spent: `q:human` + `why:budget`. During a [red base](/explanation/merging-and-red-base/) a failure requeues at the same attempt (`base-red`).

## Worker

```sh
claude -p --output-format stream-json --verbose --thinking-display summarized \
  --max-turns <maxTurns> --allowedTools Read,Edit,Write,Glob,Grep,Bash \
  --disallowedTools "Bash(graft issue label:*),Bash(graft issue edit:*),Bash(gh:*)" <worker.args>
```

| Property    | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Directory   | Its own worktree, per the [target repository convention](/reference/cambium/configuration/#target-repository-cambium-key).         |
| Process     | Detached, leading its own process group; stdin from the prompt file.                                                               |
| Environment | `CAMBIUM_REPO`, `CAMBIUM_ISSUE`, `CAMBIUM_PHASE`, `CAMBIUM_BRANCH`; `GRAFT_APP=<worker.graftApp>` when set; `worker.env`; `TRACEPARENT` with tracing on. |
| Prompt      | Task issue, `pnpm verify`, `graft publish <branch> … --closes <n>`, `graft ci wait`; attempt, existing PR, last failure, history, issue body, the worktree's `AGENTS.md`. |
| Kill        | Past `wallClockMinutes`: descendants SIGKILLed, `claude` SIGTERMed; still alive 30 s later, the whole group killed.                 |

Triage and rescue workers run in a disposable, detached, read-only checkout with tools `Read,Glob,Grep,Bash` and every write verb denied.
