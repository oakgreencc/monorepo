---
title: Graphs
description: Nodes, edges and verdicts of cambium's task, pr, dispatch, release and rescue graphs.
sidebar:
  order: 4
---

All graphs run with `"engine": "graph"`. Steps act once; waits hold until polled ready. Each node declares the queue label an issue resting there carries and whether it holds `running`. Edges are listed `from → to [condition]`; an edge without a condition is the fallback.

## The tick

| Step       | Graph engine                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Read       | One GraphQL query per repo: queued issues, agent PRs with checks, merge state, review decision, newest 20 comments per issue; with `intake.adopt`, the oldest 20 open issues in no queue. |
| Reconcile  | Polls `worker-running` / `triaging` / `diagnosing` for each tracked worker; kills workers over their cap; tears down worktrees. A worker whose finished run cannot be written to GitHub is kept and retried after 1 minute, doubling to at most 1 hour. |
| Watch      | One [PR graph](#pr) turn per eligible PR; then awaiting-promotion tracking.                           |
| Sweep      | A `running` lease with this host (or none) and no tracked worker goes to its node's recovery.         |
| Adopt      | An open issue in no queue that cambium has never handled, and no agent PR names, gains `q:intake`. |
| Schedule   | Starts Task workers by priority then age up to `phases.task.cap`; wakes replied-to issues; starts triage up to `phases.dispatch.cap`. |
| Release    | [Release graphs](#release-prepare) per repo.                                                          |
| Stalls     | Warns once about each [stalled](#stalled-merges) PR that is not an agent's.                           |
| Upkeep     | Reaper, [stall](#stall) fallback, then the [rescue](#rescue) sweep.                                   |
| Heartbeat  | Writes the [state file](/reference/cambium/heartbeat/).                                               |

## task

Turns a `q:task` issue into a published PR and ends at `submit`. Entry: `q:task` → `start-worker`.

| Node             | Kind | Queue     | `running` |
| ---------------- | ---- | --------- | --------- |
| `start-worker`   | step | `q:task`  | no        |
| `worker-running` | wait | `q:task`  | yes       |
| `submit`         | step | none      | no        |
| `requeue`        | step | `q:task`  | no        |
| `to-human`       | step | `q:human` | no        |

```text
start-worker   → worker-running [started] | to-human [budgetSpent] | requeue
worker-running → end [issueGone] | submit [submitted] | requeue
submit         → end
requeue        → start-worker [attemptsLeft] | to-human
to-human       → end
```

- `submit`: history `submitted`, `submittedAt`, the PR on the marker, the issue out of every queue, `Closes #n` added to a PR found only by its branch.
- A worker exiting without a PR, or killed at `wallClockMinutes`, goes to `requeue`. Spent attempts: `q:human` + `why:budget`.
- Turns stop at a wait that is not ready, on entering a wait, on returning to `start-worker`, or at the end.

## pr

One turn per tick for each agent PR (head `agent/*`) closing a cambium-owned issue, when the PR is merged and the issue open, or the PR is open, CI has settled and the issue has no Task queued or running. No waits.

| Node        | Action                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `assess`    | Picks the next node (order below).                                                                                                             |
| `merge`     | Behind base: `graft pr update` (`branch-updated`). Else `graft pr merge --auto` (`merge-armed`). A refusal is recorded (`merge-refused`) and retried on a new head or after 10 min; a human-only refusal goes to `to-human` (`why:approve`). |
| `rework`    | Back to the task graph at `start-worker` in `q:task`: attempt 1 of a fresh `maxAttempts`, `reworks + 1`, reason as `lastFailure`, head as `failedSha`. Past `maxReworks`: `to-human` (`why:budget`). |
| `close-pr`  | Closes the PR with the reason and `Closed by cambium.`                                                                                         |
| `close-out` | Marker done, out of every queue, issue closed (`Merged in #n. Closed by cambium.`), branch deleted.                                            |
| `to-human`  | `q:human` with the `why:` label and the reason.                                                                                                |

`assess` order:

1. Merged → `close-out`.
2. Issue closed → `close-pr`.
3. A newer open agent PR closes the same issue → `close-pr` (superseded).
4. Red CI, `mergeable: CONFLICTING` or `CHANGES_REQUESTED` → `rework`.
5. Green, clean, repo `merge` is `"green"`, nothing armed, no refusal on this head within 10 min → `merge`.
6. Auto-merge armed, green, and GitHub reports `BLOCKED` `mergeStallMinutes` after arming → `to-human` (`why:approve`, outcome `merge-blocked`). The reason names the [blocker](#stalled-merges) where it can be read.
7. Not merged `mergeQueueMinutes` after submission → `to-human` (`why:approve`).
8. Otherwise nothing this tick.

```text
assess → close-out [merged] | merge [toMerge] | rework [toRework] | close-pr [toClose] | to-human [toHumanInbox] | end
merge  → to-human [needsApproval] | end
rework → to-human [reworksSpent] | end
```

For an issue in `q:human`, the PR graph only merges a green, clean PR (not on a head a human-only refusal sent there). It never reworks or closes one.

### Stalled merges

A PR is stalled when auto-merge is armed, its checks are green and GitHub reports it `BLOCKED` `mergeStallMinutes` after arming.

| PR                        | Result                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Agent PR                  | `to-human`, as step 6 above.                                                                            |
| Any other open PR         | One `warn` event and an entry in the heartbeat's `repos[].stalls`. No labels, comments or queue moves. The warning is not repeated while the PR stays stalled; re-arming auto-merge starts it again. |

The reason names what holds the PR, where GitHub exposes it:

- a required check missing from the head's status rollup;
- a code-owner review still requested;
- required approving reviews against approvals given;
- the rulesets that apply to the base (`/rules/branches/<base>`).

The base's rulesets and branch protection are read only once a PR is past the threshold. When nothing can be read, the reason says a rule cambium cannot see holds the PR. `mergeStallMinutes: 0` turns off both checks.

## dispatch

Triages a `q:intake` issue. Requires `phases.dispatch.cap > 0`. Entry: `q:intake` → `start-triage`.

| Node              | Kind | Queue      | `running` |
| ----------------- | ---- | ---------- | --------- |
| `start-triage`    | step | `q:intake` | no        |
| `triaging`        | wait | `q:intake` | yes       |
| `retry-triage`    | step | `q:intake` | no        |
| `to-task`         | step | `q:task`   | no        |
| `to-human`        | step | `q:human`  | no        |
| `close-duplicate` | step | none       | no        |
| `deferred`        | step | `q:intake` | no        |
| `blocked`         | step | `q:intake` | no        |
| `close-obsolete`  | step | none       | no        |

```text
start-triage → triaging [started] | to-human [budgetSpent] | retry-triage
triaging     → end [issueGone] | retry-triage [leaseLost] | to-task [actionable]
               | close-duplicate [duplicate] | deferred [defer] | blocked [blocked]
               | close-obsolete [obsolete] | to-human [needsHuman] | to-human
retry-triage → start-triage [attemptsLeft] | to-human
deferred     → to-human [budgetSpent] | end
blocked      → deferred [noneOpen] | end
others       → end
```

### Triage verdict

The worker's final message ends with a JSON block (the last fenced block of the last `result` event, else bare JSON):

```ts
{
  verdict: 'actionable' | 'needs-human' | 'duplicate' | 'obsolete' | 'defer' | 'blocked',
  duplicateOf?: number,   // required for duplicate; not the issue itself
  blockedBy?: number[],   // required for blocked
  recheckHours?: number,
  reason: string,
  title?: string,
  acceptance?: string[],
  ask?: {                 // for needs-human
    kind: 'decide' | 'verify' | 'chore' | 'approve',
    question: string,
    options?: { label: string, detail: string }[],   // two or more; required for decide
    recommendation?: string,
    interactive: boolean, // a live session with the code would help
    lens?: 'product' | 'technical'  // required for an interactive decide
  }
}
```

| Verdict       | Outcome                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `actionable`  | Comment with reason, title and acceptance checks; `q:task` at `start-worker`, attempt 1. The issue body is never rewritten.   |
| `needs-human` | `q:human` + `why:triage`. With an `ask`: its [`ask:*` labels](/reference/cambium/labels-and-state/#labels) too, and the ask rendered in the state comment. An invalid `ask` is dropped (the reason says why); the issue still lands in `q:human`. |
| `duplicate`   | Closed as `duplicate` with `Duplicate of #n (<link>). <reason>`.                                                              |
| `obsolete`    | Closed as `not_planned` with `Obsolete: <reason>`.                                                                            |
| `defer`       | Stays in `q:intake` at `deferred` with `wait:deferred`, until `deferUntil` (`recheckHours`, else `deferHours`). After `maxDefers`: `q:human` + `why:triage`. |
| `blocked`     | Adds missing GitHub "blocked by" links; stays in `q:intake` at `blocked` with `wait:blocked` until every blocker closes. None open: treated as `defer`. |
| invalid/none  | `q:human` + `why:triage` with the error. Also a worker killed at `wallClockMinutes`.                                          |

- A deferred issue whose blockers all closed (one after deferral) is triaged at the next tick.
- A blocked wait does not count toward `maxDefers`.
- A human reply wakes a parked issue, and a `q:human` issue with any `why:*` except `why:approve`, back to `start-triage` at attempt 1. The newest 5 replies (2000 characters each) are quoted to triage.
- A human reply: a comment after the issue entered its state, whose author is not `graft.botLogin`, not the state comment's author, and not a `Bot` account. A comment with a state marker never counts.
- An answer comment counts as a human reply whoever wrote it, the App included: one carrying `<!-- cambium:answer {"graph":"decide","decideAt":"…","answerer":"<login>"} -->`. Triage sees `answerer` as the reply's author. A malformed payload, or one without `answerer`, is ignored. Triage treats an answer with a decision and acceptance checks as normally `actionable`.
- Closed or relabelled during triage: verdict dropped.
- `lens` says which kind of decision an interactive `decide` is: `product` for what users get (scope, behaviour, wording, defaults, priority), `technical` for how it is built (architecture, interfaces, dependencies, data model). An unknown `lens` counts as none: it is dropped where it is optional and makes the `ask` invalid where it is required.
- `ask` is read only on `needs-human`. An issue waiting on another open issue that is itself a human chore or check is `blocked` by it, not `needs-human`.

## release-prepare

Subject: the promotion PR (`release/<date>-N` → `release.to`). Clock entry: daily at `release.time`, or `cambium run release-prepare`.

```text
start → cleanup → prepare → end
```

| Node      | Action                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `cleanup` | Closes, with a comment, open promotion PRs older than 24 h; removes `q:promote`.                                        |
| `prepare` | `from` ahead of `to`: cuts `release/<date>-N` at the newest `from` commit with a green `release.check`, opens its PR listing the PRs it carries, labels it `q:promote`, writes the marker, then closes the older open promotion with "Superseded by". Same cut already open: refreshes it. No green commit, or `to` holds content the cut lacks: a log line, nothing opened. |

## release-promote

Entry: `q:promote` → `merge`, once the promotion PR is approved.

| Node        | Kind | Action                                                                                         |
| ----------- | ---- | ---------------------------------------------------------------------------------------------- |
| `merge`     | step | `graft pr merge <n> --auto`. A refusal is recorded and not retried on the same head.           |
| `merging`   | wait | Holds while the PR is open.                                                                    |
| `promoted`  | step | Merged: marker done, `q:promote` off.                                                          |
| `abandoned` | step | Closed unmerged: marker done, `q:promote` off.                                                 |

```text
merge   → merging [armed] | end
merging → promoted [merged] | abandoned
```

Neither release graph has a timeout.

### Awaiting promotion

For repos where `release.from` ≠ `release.to` (enabled or not):

- A merged agent PR not yet in `to` puts `q:promote` on each closed, cambium-owned issue it closes.
- A closed `q:promote` issue whose PR is no longer ahead of `to` loses the label. Skipped while `to` is missing or `from` is more than 100 commits ahead.

## rescue

Requires `phases.rescue.cap > 0`. Sweep every `rescue.everyMinutes`.

| Node           | Kind | Action                                         |
| -------------- | ---- | ---------------------------------------------- |
| `start-rescue` | step | Starts a read-only rescue worker.              |
| `diagnosing`   | wait | Holds while the worker runs.                   |
| `unstick`      | step | Carries out the verdict's actions.             |
| `file-causes`  | step | Files or updates root-cause tickets.           |
| `report`       | step | Comments on the item.                          |
| `to-human`     | step | `q:human` + `why:rescue`.                      |

```text
start-rescue → diagnosing [started] | to-human [budgetSpent] | end
diagnosing   → end [resolved] | unstick [diagnosed] | to-human
unstick → file-causes → report → end
```

### Stuck symptoms

| Symptom               | Condition                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `many-queues`         | More than one `q:*` label.                                                                       |
| `running-unqueued`    | `running` outside `q:task` / `q:intake` (not another host's lease).                              |
| `why-outside-human`   | A `why:*` label without `q:human`.                                                               |
| `wait-outside-intake` | A `wait:*` label without `q:intake`.                                                             |
| `closed-labelled`     | Closed issue still carrying cambium labels (`q:promote` aside).                                  |
| `merged-open`         | Agent PR merged, issue open in no queue.                                                         |
| `stranded`            | Open in no queue, no open agent PR; its PR closed unmerged.                                      |
| `stale-task`          | In `q:task` without a lease for `rescue.staleHours` while a slot was free and the base not red.  |
| `stale-intake`        | Same in `q:intake`, triage slot free, not parked.                                                |
| `pr-stale`            | Open agent PR not updated for `rescue.staleHours`, its issue open in no queue.                   |

- A label change counts after `rescue.graceMinutes`.
- Items held by a live worker or moved this tick are skipped.
- Rescued within `cooldownHours`: skipped. Rescued `maxRescues` times in a week: straight to `q:human` + `why:rescue`.

### Rescue verdict

```json
{
  "stuck": true,
  "how": "the sequence of events, with times and evidence",
  "actions": [{ "do": "clear-labels", "labels": ["why:budget"] }, { "do": "requeue", "queue": "task", "reason": "…" }],
  "rootCauses": [{ "title": "…", "body": "…", "fingerprint": "kebab-case-cause", "repo": "owner/name" }]
}
```

| Action         | Effect                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| `clear-labels` | Removes cambium labels.                                                           |
| `close-pr`     | Closes an open agent PR.                                                          |
| `requeue`      | To `q:task` or `q:intake` at the graph's entry, attempt 1, outcome `rescued`.     |
| `adopt-pr`     | The task graph's `submit`.                                                        |
| `close-issue`  | `completed` or `not_planned`.                                                     |
| `to-human`     | `q:human` + `why:rescue`. An optional `ask` (same shape as triage's) adds its `ask:*` labels and is rendered in the state comment. |

`clear-labels` and `close-pr` run first; at most one move (`requeue`, `adopt-pr`, `close-issue`, `to-human`) runs last. `"stuck": false` takes no actions. An invalid verdict or a killed worker sends the item to `q:human` + `why:rescue`. If no starting symptom still holds when the worker exits, the verdict is dropped.

Root-cause tickets are labelled `q:intake` and `rescue`, filed in `repo` or `rescue.causeRepo`, and carry `<!-- cambium:rescue-cause <fingerprint> -->`. An open ticket with the same fingerprint gets a comment instead.

## Upkeep

### Reaper

Every `reaper.everyMinutes`, for each open untracked `agent/*` PR idle `reaper.staleMinutes`. Its issue is the one it closes, else the one its branch names.

| Found                                                     | Action                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Issue open, no live worker, marker's `pr` is not this PR  | Adopt: `Closes #n` added if missing, the task graph's `submit`, a comment.      |
| Issue closed                                              | Close the PR with a comment.                                                    |
| No issue                                                  | Close after `reaper.orphanDays` untouched. The branch stays.                    |
| Live worker on the issue, or the issue tracks this PR     | Leave it.                                                                       |

### Stall

Every `stall.everyMinutes`, per repo, in order. No agent decides.

| Condition            | Detected when                                                                                                   | Action                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Orphan blocker       | `wait:blocked`, every "blocked by" issue closed, still parked `stall.graceMinutes` after the last one closed.    | Unpark: marker to `start-triage` (history `unpark`), `wait:*` removed.                          |
| Overdue defer        | `wait:deferred`, still parked `stall.overdueMinutes` past `deferUntil`.                                         | Unpark.                                                                                        |
| Cycle                | Open issues whose open "blocked by" links form a cycle.                                                         | One `q:human` + `stall` issue naming it, and a `warn`. Closed once the cycle is gone.          |
| Chain into `q:human` | `wait:blocked`, parked `stall.graceMinutes`, its open blockers leading to a `q:human` issue.                     | One `q:human` + `stall` issue per `q:human` issue at the end. Closed once nothing waits on it. |
| Starved              | No `q:task`, nothing `running`, `q:intake` only `wait:*` issues, no merge for `stall.starvedHours`.             | One `warn` when it starts, one `info` when it ends. The heartbeat's `repos[].stall` shows it.  |

Then the `q:human` issues involved (a cycle's members, a chain's end, what starved issues wait on) go back to `q:intake` without their `why:*`, if their triage inputs changed. Never `why:approve`, an issue holding `running`, or the rest of `q:human`.

When triage answers needs-human, the marker keeps a fingerprint of what triage saw:

- title and body
- labels, except `q:*`, `why:*`, `wait:*` and `running`
- human comments (not `graft.botLogin`, not a bot)
- GitHub "blocked by" issues and their states
- agent PRs naming the issue and their states
- the triage rubric version

| Fingerprint                                                        | Re-triage |
| ------------------------------------------------------------------ | --------- |
| Matches                                                            | No.       |
| Differs (an input changed, or a new rubric)                        | Yes.      |
| None (another route to `q:human`, or written before fingerprints)  | No.       |

The stall fallback replaced a daily re-triage of every `q:human` issue (`retriage.*`, removed).

## Red base

Per repo with a `requiredCheck`. The newest of the base's last 20 commits with a verdict decides:

| State     | Effect                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `green`   | None.                                                                                                                             |
| `red`     | No Task workers start except the repair. Failures requeue at the same attempt (`base-red`). A repair issue is opened (`red-base`, `q:task`, first priority label). |
| `unknown` | No completed run in the window. Gates nothing.                                                                                    |

Green again: a repair issue with no open PR and no worker is closed.
