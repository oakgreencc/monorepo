---
title: Triage incoming issues
description: Have cambium sort q:intake issues into tasks, human questions, duplicates and deferrals.
sidebar:
  order: 6
---

Triage needs the graph engine. Without it, `q:intake` issues wait untouched.

1. In the `cambium` section of `~/.oakgreen/forest.json`:

   ```json
   {
     "engine": "graph",
     "phases": { "dispatch": { "cap": 1 } }
   }
   ```

   `cap` is how many triage workers may run at once. `0` turns triage off.

2. Restart, since `engine` is read only at start:

   ```sh
   oakgreen restart cambium
   ```

3. File issues as usual. An open issue in no queue gains `q:intake` on the next tick. To keep tracking or parent issues out of triage, list their label in `intake.ignoreLabels`:

   ```json
   { "intake": { "ignoreLabels": ["release-area"] } }
   ```

## Triage one issue now

```sh
cambium run dispatch --issue 42 --repo owner/name
```

Runs a triage worker in the foreground, whatever the cap, and applies its verdict.

## Teach agents the labels

`oakgreen setup`, run from a clone, writes `docs/agents/triage-labels.md` and a pointer to it in `CLAUDE.md` or `AGENTS.md`. Agent skills that file issues read it and use `q:intake` directly, skipping the one-tick wait. If the guide exists but does not name `q:intake`, `oakgreen doctor` says so; replace it.

## Tune deferral

| Key under `phases.dispatch` | Default | Controls |
| --- | --- | --- |
| `deferHours` | 6 | wait before re-checking a deferred issue |
| `maxDefers` | 8 | deferrals before it goes to `q:human` |
| `maxAttempts` | 3 | failed triage attempts before `q:human` |
| `wallClockMinutes` | 15 | time limit per triage worker |

Verdicts and where each one sends an issue: [cambium graphs](/reference/cambium/graphs/). Why triage defers instead of asking a person: [Humans in the loop](/explanation/humans-in-the-loop/).
