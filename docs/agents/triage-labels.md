# Issue labels

Written by `oakgreen setup`. cambium runs this repo's issues as a queue of labels, and only cambium moves them.

## Filing an issue

- Add `q:intake` and no other label from the queue table. cambium's triage reads the issue, then moves it to `q:task` or `q:human`, parks it, or closes it.
- Put "blocked by #n" in a GitHub blocked-by link, not a label. cambium holds the issue until its blockers close.
- A tracking parent (an epic with sub-issues) gets no `q:` label.
- Priority, at most one: `priority:critical`, `priority:high`, `priority:medium`, `priority:low`.
- Topic labels the repo already has (area, type, platform) are fine. Create no new process labels.

## Queue labels (cambium's; never add or remove them by hand)

| Label | Meaning |
| ----- | ------- |
| `q:intake` | Queue: intake, waiting for dispatch |
| `q:task` | Queue: ready for a task worker |
| `q:human` | Queue: needs a human |
| `q:promote` | Queue: waiting for promotion |
| `running` | A worker holds the lease |
| `why:budget` | In q:human: attempts spent |
| `why:reject` | In q:human: rejected |
| `why:approve` | In q:human: waiting for approval |
| `why:triage` | In q:human: triage needs a human |
| `why:rescue` | In q:human: the rescue graph could not unstick it |
| `ask:decide` | In q:human: choose between options |
| `ask:verify` | In q:human: check something only a person can |
| `ask:chore` | In q:human: do a manual step |
| `ask:approve` | In q:human: approve or reject |
| `ask:session` | In q:human: best answered in a live session |
| `wait:deferred` | In q:intake: triage deferred it; rechecked later |
| `wait:blocked` | In q:intake: waits on its open blocked-by issues |
| `red-base` | Repair issue for a red base branch |
| `rescue` | Root-cause ticket filed by the rescue graph |
| `watch` | A watched workflow is failing (cambium watch) |

## Skills with their own triage roles

Skills that speak in triage roles (`needs-triage`, `ready-for-agent`, …) map to this repo as follows. cambium triages, so no agent applies a role label.

| Role | Here |
| ---- | ---- |
| `needs-triage` | `q:intake` |
| `needs-info` | `q:intake`; triage moves it to `q:human` + `why:triage` |
| `ready-for-agent` | `q:intake`; triage decides, never `q:task` by hand |
| `ready-for-human` | `q:intake` with the reason in the body; triage moves it to `q:human` |
| `wontfix` | close the issue as not planned, no label |
