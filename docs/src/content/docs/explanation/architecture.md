---
title: How the stack fits together
description: The pieces of oakgreen, how work moves through them, and why GitHub holds all the state.
sidebar:
  order: 1
---

oakgreen runs coding agents against a GitHub repository. It is a handful of small tools, each with one job, joined by a single shared record: the repository on GitHub.

## The pieces

| Piece    | Job                                                                                      |
| -------- | ---------------------------------------------------------------------------------------- |
| graft    | The only way an agent writes to GitHub: Verified commits, PRs, merges, issue comments.   |
| cambium  | The scheduler. Reads the queues, starts agent workers, moves issues between queues.      |
| mycelium | Intake. Turns Discord posts, store reviews and crash reports into issues.                |
| canopy   | A local, read-only page over cambium and the queues.                                     |
| canker   | A quality gate: fails functions that are both complex and untested.                      |
| deadwood | A prose gate: keeps stray Markdown and comment-heavy code out of the repository.         |
| oakgreen | The umbrella CLI: checks a machine, sets up what is missing, runs the services.          |

The tools do not call each other's code. They meet on GitHub (labels, issues, PRs, comments) and in a few local files (cambium's heartbeat, the collector's trace file). Any one can be replaced or switched off without the others noticing more than a missing feature.

## How work flows

A piece of work passes through a fixed sequence of queues, each a GitHub label:

```
outside world ──mycelium──▶ q:intake ──triage──▶ q:task ──worker──▶ agent PR ──merge──▶ base branch
                                │                    │                  │                    │
                                └──▶ q:human ◀───────┴──────────────────┘          q:promote ──▶ release branch
```

- **Intake.** mycelium files an issue labelled `q:intake` for each new report, or comments on the open issue that already describes it. People file `q:intake` issues too.
- **Triage.** cambium starts a short, read-only agent that judges each intake issue: a task, a duplicate, obsolete, waiting on something, or a question for a person.
- **Task.** For a `q:task` issue, cambium starts a worker in its own worktree. The worker changes code, runs the project's checks and publishes a PR through graft.
- **Review and merge.** cambium watches the PR through CI. Red sends it back for rework; green is merged by a merge queue, a person, or cambium itself, depending on configuration.
- **Release.** Where a repository promotes an integration branch to a release branch, a daily promotion PR carries merged work across.
- **Human queue.** Anything that needs a decision lands in `q:human`, with a `why:*` label saying why.

canopy draws all of this; tracing records it as one trace per issue, from intake to close.

## GitHub is the truth

Every piece of state that matters lives on GitHub: which queue an issue is in, how many attempts it has had, which PR belongs to it, what went wrong last time. cambium keeps a small SQLite file, but only to remember which processes it started on this machine. Lose it and the cost is one requeue: the next tick sees an issue marked `running` with no live worker and puts it back in the queue.

This choice shapes everything else:

- **Nothing is queued locally,** so a crashed or restarted daemon never forgets work and never holds work hostage.
- **People and agents see the same thing.** The queue is the label list on GitHub; a person can move an issue by hand and cambium will follow.
- **Several tools can read the state** without an API between them. canopy reads labels and PRs through graft; it never imports cambium.

The cost is speed and rate limits: every tick reads GitHub. cambium keeps that to one GraphQL query per repository per tick, and most ticks skip even that.

Each tick first sends a probe per repository, costing about one point of the hourly GraphQL budget: the newest update time of any issue and of any pull request, and the head commit of the base branch. When all of these match the last full read, nothing that read covers has changed, and cambium reuses it. The full read costs about ten points.

Check results do not change a pull request's update time, so the probe cannot see CI finishing. cambium therefore still reads in full every tick while an open agent PR's checks are pending, it is in the merge queue, or GitHub is still working out whether it conflicts. It also reads in full every `fullReadEvery` ticks (four by default), which catches anything else the probe misses, such as a base branch going red. The heartbeat records, per repository, whether each tick probed or read in full. A tick that reuses the last read does not run the release step: like a kept release comparison, it waits for the next full read.

## One tick

cambium works in ticks, every 30 seconds by default. Each tick reads GitHub, checks its workers, acts on settled PRs, recovers lost leases, starts new work up to a cap, runs the release and upkeep clocks, and writes its heartbeat. Each step has a time limit; a step that fails is logged and the tick moves on. Nothing in a tick waits for an agent: workers are detached processes, and the next tick simply looks again.

That is the whole control loop. The details of each step are in [the cambium reference](/reference/cambium/cli/); why queues are labels is in [Queues and labels](/explanation/queues-and-labels/).

## Why agents write only through graft

An agent with a shell could run `git push` or `gh`. graft exists so it does not have to, and so the repository's protections hold whatever the agent does: every write is a commit GitHub itself creates and signs as a GitHub App, with the repository's hooks run first. See [The boundary and the tripwires](/explanation/boundary-and-tripwires/).

## Where it runs

The long-running parts (cambium, mycelium, canopy, the OpenTelemetry collector) are launchd user agents on a Mac. graft, canker and deadwood are plain CLIs and work anywhere Node 22 runs. Spreading workers over several hosts, or running under systemd or in a container, is not yet supported.
