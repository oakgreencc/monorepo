---
title: Answer the human queue
description: Clear what cambium has handed to you in q:human.
sidebar:
  order: 7
---

1. Open canopy (`http://127.0.0.1:4317/`) on the **Inbox** tab. It lists `q:human` issues and issues stranded when their PR closed unmerged, grouped by what answering takes. `j`/`k` move, `Enter` reads, `o` opens the issue on GitHub.
2. Pick a group to suit where you are:
   - **Needs a session**: open the code and work it through.
   - **Answer in a comment**: the state comment lists the options and a recommendation; reply with your choice.
   - **Offline chores**: checks and chores away from the keyboard; comment when each is done.
   - **Approvals**: review and merge.
3. Read the reason: the `why:*` label, the ask, and the last failure in cambium's state comment.
4. Act on it:

   | Label | Meaning | What to do |
   | --- | --- | --- |
   | `why:triage` | triage could not decide, or needs an answer | reply on the issue |
   | `why:budget` | attempts or reworks ran out | fix the cause, then reply or requeue |
   | `why:approve` | the PR needs a merge only a person may make | review and approve or merge the PR |
   | `why:rescue` | the rescue graph could not unstick it | read rescue's report comment, fix by hand |
   | **PR closed** | the agent PR closed unmerged; no queue holds the issue | requeue it, or close it |

## Work it in an interactive session

For a `why:budget` item, cambium writes a session brief: the issue, what each attempt tried and why it failed, the last failure, its PRs, and the repository's verify and publish commands. canopy shows it in the reading pane under **Interactive session**.

1. Select **Copy**. The command looks like `cd ~/src/repo && claude "$(cat ~/.cambium/briefs/owner__repo/issue-42.md)"`.
2. Paste it into a terminal. claude starts in the repository with the brief as its first message.
3. Once the fix is published, move the issue out of `q:human`. The brief is deleted on the next tick.

Other `q:human` items get no brief and no command.

## Decide on GitHub

When the repository has hosted decisions on (`decide.channel: "github"`), cambium walks a decision labelled `ask:decide` and `ask:session` through on the issue itself.

1. cambium comments a round of numbered questions, each with a recommendation.
2. Reply in one comment: `1 yes`, `2 the second option, because…`. `yes` alone accepts every recommendation; `stop` abandons.
3. Further rounds follow until nothing is open. Then cambium comments a draft: the choice, scope, acceptance checks and follow-up issues.
4. Reply `yes` to commit it, say what to change, or `abandon`.

On `yes`, cambium files the follow-ups and posts the decision; the issue goes back to triage. Only logins listed in `decide.answerers.github` can answer; other replies are ignored. A day without a reply pauses the decision; the next reply resumes it.

## Reply to send it back

With the graph engine and triage on, comment on the issue. A comment from a person (not a bot, not the App) wakes it: cambium moves it back to `q:intake`, and triage reads your reply with the original question. This works for every `why:*` except `why:approve`.

The same applies to issues parked as deferred or blocked: a reply gets them triaged now.

## Requeue by hand

Move the issue's label from `q:human` to `q:task` (straight to work) or `q:intake` (triage again), and remove its `why:*` and `ask:*` labels.

## Send an issue back to triage

Comment on it. A human reply returns a `q:human` issue to triage on the next tick.

cambium no longer re-triages the whole queue daily. Its [stall fallback](/reference/cambium/graphs/#stall) re-triages only `q:human` issues that hold up parked work, and only once something on them changed.

Label meanings in full: [Labels and state](/reference/cambium/labels-and-state/).
