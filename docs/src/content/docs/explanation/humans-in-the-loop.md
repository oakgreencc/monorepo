---
title: Humans in the loop
description: When cambium asks a person, when it waits for a machine instead, and how a person's answer gets back into the loop.
sidebar:
  order: 6
---

The point of the stack is that people decide what matters and machines do the rest. That puts a premium on asking a person only when a person is actually needed, and on making their answer count when they give one.

## The human queue is a last resort

An issue lands in `q:human` for a reason, recorded as a `why:*` label:

- `why:budget` — attempts or reworks were used up.
- `why:triage` — triage judged it needs a person, or triage itself failed.
- `why:approve` — a PR waits on a merge only a person may make.
- `why:rescue` — cambium could not work out how to unstick it.

Every other outcome is something a machine can act on, and cambium is built to prefer those.

## Defer, not ask

Many questions that look like they need a person do not. "Has the deploy happened yet?" "Did last night's release include this fix?" "Has that other PR merged?" A machine can check all of these — just not yet.

So triage has a verdict for it: **defer**. A deferred issue stays in intake with a reason and a time to look again (six hours by default). When the time comes, triage runs again with the earlier reason in its prompt and is told to check now. A defer is not a failed attempt. Only after many defers (eight by default) does it go to a person, carrying the last reason.

The rule triage follows is blunt: asking a person to verify what a machine can is what the system exists to avoid.

## Blocked, not timed

Some work waits on other issues rather than on time. Triage's **blocked** verdict names them; cambium records each as a GitHub "blocked by" link and parks the issue. It is not polled on a timer. The tick after its last blocker closes, it is triaged again. The same holds for blocker links a person added by hand: cambium never triages an issue with an open blocker.

Blocked and deferred issues carry `wait:blocked` and `wait:deferred`, so canopy can show them apart from work actually awaiting triage.

## A reply wakes it

canopy's inbox is read-only; a person answers by commenting on the issue on GitHub. cambium treats a comment as a **human reply** when it came after the issue entered its current state and was written by neither cambium's App nor any other bot.

A decision made in a `decide` session is the one exception. graft posts it as the App, so it carries an answer marker naming the person who decided: `<!-- cambium:answer {"graph":"decide","decideAt":"…","answerer":"<login>"} -->`. That comment counts as a reply, and triage sees it as from the answerer. A decision that comes with acceptance checks normally becomes a task with those checks.

A `q:human` issue with a reply goes back to triage (except `why:approve`, which needs a merge, not an answer). A parked issue with a reply is triaged straight away, whatever its timer or blockers — the person may be saying it is not waiting on anything. Triage sees the replies quoted next to the question that prompted them, and usually turns the issue into a task.

There are no loops. cambium's own comments never count (except an answer comment), and a new verdict starts a new state, so a triage that asks again simply rests until the next reply.

## The human queue belongs to the human

Once an issue is in `q:human`, cambium stops acting on it. It will not rework or close its PR. The one exception is benign: if a worker's PR is green and clean, cambium may still merge it, because finishing finished work helps everyone.

## Looking again

Two mechanisms keep `q:human` from becoming a graveyard.

- **The stall fallback** watches for a queue that stops moving. A parked issue whose blockers have all closed, or whose recheck is long overdue, goes back to triage. Issues that block each other, or wait on a `q:human` issue, are reported once as a new `q:human` issue, closed when the loop breaks. A repo with nothing to do but parked work gets one warning. Only the `q:human` issues holding things up are re-triaged, and only if something on them changed: same text, labels, comments, blockers, linked PRs and rubric give the same answer, and each triage costs a model turn. It replaced a daily re-triage of the whole queue, which cost a model turn per issue per day and moved little.
- **Rescue** looks for items stuck in states that should not persist — two queue labels at once, a merged PR with an open issue, a task passed over for half a day. A read-only agent works out how it happened; cambium checks the plan, carries it out, files tickets for the root causes, and reports on the issue. An item rescued twice in a week goes to a person instead of a third diagnosis.

## Approval, once

For changes to protected files, the person's single act is approving the PR on GitHub. graft then lets the agent merge it. See [The boundary and the tripwires](/explanation/boundary-and-tripwires/).

The practical side is in [Answer the human queue](/how-to/answer-the-human-queue/).
