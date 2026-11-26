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

1. Select **Copy**. The command looks like `cd ~/src/repo && claude "$(cat ~/.oakgreen/cambium/briefs/owner__repo/issue-42.md)"`.
2. Paste it into a terminal. claude starts in the repository with the brief as its first message.
3. Once the fix is published, move the issue out of `q:human`. The brief is deleted on the next tick.

A decision worth a session (labels `ask:decide` and `ask:session`) gets a brief too, which starts with `/oakgreen:decide`. Other `q:human` items get no brief.

## Decide in a session

For an `ask:decide` + `ask:session` item. You need the oakgreen plugin in Claude Code (`claude plugin install oakgreen@oakgreencc`).

1. In canopy's reading pane, under **Decision**, select **Copy** and paste the command into a terminal: `cd ~/src/repo && claude "/oakgreen:decide owner/repo#42"`. Or start claude with the brief (above), or run `/oakgreen:decide owner/repo#42` in any session there. **Decision** also says how far it has got: not started, live (the step, the round of questions and who holds it), paused, or committed with a link to the answer.
2. Claude gathers the facts first, each with its source. For a visual choice it also draws a static HTML mock of each option; the round links them, so open them in a browser.
3. Answer the round: up to five numbered questions, each with a recommendation. Reply `yes` to take every recommendation, or answer by number (`2: later`). Reply `stop` to abandon.
4. More rounds follow until nothing is open. Claude then shows a draft: the choice, what is in and out of scope, acceptance checks and follow-up issues.
5. Reply `yes` to commit it, or say what to change. A draft with unanswered questions cannot be committed.

On commit, cambium files the follow-ups to `q:intake` and posts the decision on the issue in your name; triage then picks the issue up again. The decisions are yours: Claude finds facts and recommends; it does not choose.

You can stop at any point and come back later, on this machine or another. Progress is kept in a `Decision in progress` comment on the issue, and `/oakgreen:decide` resumes from it without asking anything already answered. While that comment says in progress, comments on the issue do not send it back to triage. Mocks are saved under `~/.oakgreen/cambium/decide/<owner>__<repo>/issue-<n>/mocks/`.

Without the plugin, `cambium decide show` and `cambium decide advance` do the same steps by hand: [CLI reference](/reference/cambium/cli/#decisions).

## Decide on GitHub

When the repository has hosted decisions on (`decide.channel: "github"`), cambium walks a decision labelled `ask:decide` and `ask:session` through on the issue itself.

1. cambium comments a round of numbered questions, each with a recommendation.
2. Reply in one comment: `1 yes`, `2 the second option, because…`. `yes` alone accepts every recommendation; `stop` abandons.
3. Further rounds follow until nothing is open. Then cambium comments a draft: the choice, scope, acceptance checks and follow-up issues.
4. Reply `yes` to commit it, say what to change, or `abandon`.

On `yes`, cambium files the follow-ups and posts the decision; the issue goes back to triage. Only logins listed in `decide.answerers.github` can answer; other replies are ignored. A day without a reply pauses the decision; the next reply resumes it.

## Decide on Discord

When the repository has `decide.channel: "discord"`, the same rounds and draft go to a thread named `<owner>/<repo>#<n>` in mycelium's decisions channel instead. Reply in that thread, in the same way as on GitHub. The decision is still recorded on the issue.

This needs mycelium's broker: `MYCELIUM_DECISIONS_CHANNEL` set to the decisions channel, which must not also be an intake channel. Only people listed in `decide.answerers.discord` (by username or user ID) can answer; other replies are ignored.

## Reply to send it back

With the graph engine and triage on, comment on the issue. A comment from a person (not a bot, not the App) wakes it: cambium moves it back to `q:intake`, and triage reads your reply with the original question. This works for every `why:*` except `why:approve`.

The same applies to issues parked as deferred or blocked: a reply gets them triaged now.

## Requeue by hand

Move the issue's label from `q:human` to `q:task` (straight to work) or `q:intake` (triage again), and remove its `why:*` and `ask:*` labels.

## Send an issue back to triage

Comment on it. A human reply returns a `q:human` issue to triage on the next tick.

cambium no longer re-triages the whole queue daily. Its [stall fallback](/reference/cambium/graphs/#stall) re-triages only `q:human` issues that hold up parked work, and only once something on them changed.

Label meanings in full: [Labels and state](/reference/cambium/labels-and-state/).
