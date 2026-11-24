---
title: Queues and labels
description: Why cambium's queues are GitHub labels, why it owns one comment per issue, and what that design learned from its predecessor.
sidebar:
  order: 4
---

cambium has no queue of its own. The queue is a set of GitHub labels — `q:intake`, `q:task`, `q:human`, `q:promote` — and an issue is in a queue because it carries that label. This page explains the choice and what follows from it.

## Labels are the queue

At most one `q:` label sits on an open issue. Alongside it:

- `running` means a worker holds the lease.
- `why:*` says why an issue is in `q:human`.
- `wait:*` marks an intake issue triage has parked.
- `priority:*` orders the queue.
- An issue with no `q:` label and an open `agent/*` PR is submitted: its fate is the PR's.

Anyone can read this. A person browsing GitHub, canopy, a script — all see the same queue without an API in between. A person can move an issue by relabelling it and cambium follows on its next tick.

## No issue goes unseen

An issue filed without a `q:` label would sit outside every queue, and nothing would ever look at it. So cambium adopts it: an open issue in no queue that cambium has never handled gains `q:intake`, and triage decides what it is. Forgetting the label costs one tick.

Adoption skips what is already accounted for: an issue with cambium's state comment, one an agent PR names, one cambium filed itself, and labels listed in `intake.ignoreLabels`. Turning it off (`intake.adopt: false`) brings back the old rule, where the label is the only way in.

## Only cambium moves labels

Readable by all, writable by one. Workers have `graft issue label` and `graft issue edit` denied: an agent finishing its task cannot declare itself done, skip review, or move a sibling issue. Every queue transition is a decision cambium makes from what it observes — a PR exists, CI is green, the worker exited — not a claim the worker makes about itself.

This keeps workers simple. A worker's contract is four points: the task issue, the project's verify command, `graft publish`, `graft ci wait`. What happens next is cambium's business.

## One comment per issue

Labels say where an issue is, not how it got there. For that, cambium owns one comment on each issue it touches and edits it in place. Its first line is a hidden JSON marker; the rest is the same information rendered for people.

The marker holds the attempt number, the PR, the branch, the host and start time of a running worker, the commit CI last failed on, the last failure, and a short history of outcomes. It is what makes retries informed: the next worker's prompt carries the last failure and the history, and a commit CI already rejected is never resubmitted as if it were new.

When `graft.botLogin` is set, cambium trusts only markers its own App wrote, so a person or another bot cannot forge state by pasting a comment.

## Losing local state costs one requeue

cambium's SQLite file records which worker processes it started. If it vanishes, nothing on GitHub changes. The next tick's sweep finds issues labelled `running` for this host with no tracked worker and requeues them. That is the entire recovery procedure, and it is automatic.

The same sweep handles a crashed machine, a killed daemon or a worker that died silently. Because the lease is on GitHub and names its host, there is no lock to clean up by hand.

## Capacity is counted, not queued

cambium starts workers up to a cap, counting live worker processes, not rows in a local table. Nothing is ever queued locally ahead of GitHub, so cambium cannot feed work in faster than it drains, and a dead process cannot hold a slot: every tick probes each worker's pid and wall-clock limit.

## What the old scheduler taught

cambium replaced an earlier scheduler, the Clock. Several of its failures shaped the current design directly:

| The Clock                                         | cambium                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Merged one PR per tick, so a backlog never drained | Does not merge by default; a merge queue, auto-merge or person does  |
| Fed work in faster than it drained                 | Counts capacity from live workers; nothing queued locally            |
| Let dead instances hold their slot forever        | Probes every pid and wall-clock cap each tick                        |
| Depended on a terminal multiplexer for identity   | Runs workers as plain detached child processes                       |
| Kept a local queue that grew until checks failed  | Has no local queue; labels are the queue                             |
| Resumed parked work without waking anything       | Decides and starts work in the same loop, in the same tick           |

Each of these has a regression test named after it.

## Trade-offs

Labels are coarse: one queue per issue, and the rich state lives in a comment that must be parsed. Reads are bounded by GitHub's page size — today, more than 100 queued issues per repository is beyond one read. And every tick spends rate limit. In exchange, the state survives anything that happens to the machine, and people can see and steer it with tools they already use.

The full label set and marker fields are in [Labels and state](/reference/cambium/labels-and-state/).
