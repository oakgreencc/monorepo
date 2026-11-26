---
title: Rescue stuck work
description: Have cambium find mislabelled or stalled issues and PRs, unstick them and file root-cause tickets.
sidebar:
  order: 9
---

Rescue needs the graph engine.

1. Turn it on in the `cambium` section of `~/.oakgreen/forest.json`:

   ```json
   {
     "engine": "graph",
     "phases": { "rescue": { "cap": 1 } },
     "rescue": { "causeRepo": "owner/tooling" }
   }
   ```

   `causeRepo` is where root-cause tickets go; leave it `null` to file them in the stuck item's own repository.

2. Restart if you changed `engine`: `oakgreen restart cambium`.

Every hour (`rescue.everyMinutes`) cambium looks for stuck items, starts a read-only diagnosis worker for each, carries out its plan, files root-cause tickets labelled `q:intake` and `rescue`, and leaves a report comment on the item.

## See what is stuck, without changing anything

```sh
cambium run rescue --repo owner/name
```

## Rescue one item now

```sh
cambium run rescue --repo owner/name --issue 42
```

## Tune it

| Key under `rescue` | Default | Controls |
| --- | --- | --- |
| `staleHours` | 12 | how long an issue or PR may sit before it counts as stuck |
| `graceMinutes` | 30 | how long after a label change before it counts |
| `cooldownHours` | 24 | gap between rescues of one item |
| `maxRescues` | 2 | rescues in a week before it goes to `q:human` with `why:rescue` |

Symptoms and actions in full: [cambium graphs](/reference/cambium/graphs/).
