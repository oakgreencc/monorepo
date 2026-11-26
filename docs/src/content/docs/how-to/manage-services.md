---
title: Manage services
description: Start, stop, restart, reload and update the stack's background services.
sidebar:
  order: 12
---

The services are launchd user agents (macOS): `otelcol`, `cambium`, `mycelium` and `canopy`. Each command takes service names; with none, it acts on all of them.

| To | Run |
| --- | --- |
| see what runs | `oakgreen services` |
| start (installing the agent the first time) | `oakgreen start [service…]` |
| stop, and keep it stopped across logins | `oakgreen stop [service…]` |
| get a new process on the same definition | `oakgreen restart [service…]` |
| pick up a changed plist (env, Node path) | `oakgreen reload [service…]` |
| update every tool and restart what runs | `oakgreen update` |
| only check for an update | `oakgreen update --check` |

Restarting cambium is safe mid-work: it finishes its current tick, and running workers are adopted by the new process.

## After editing the cambium config

Most keys apply on the next tick. `host`, `engine`, `paths`, `logs` and `graft` need `oakgreen restart cambium`; the log says `restart cambium to apply` until you do.

## Pause scheduling

```sh
cambium drain     # finish what runs, start nothing new
cambium pause     # read and heartbeat only; no label moves, no starts
cambium resume
```

## Serve canopy on another port

1. In `~/.oakgreen/forest.json`, set the port in the `canopy` section:

   ```json
   { "canopy": { "port": 4400 } }
   ```

2. `oakgreen restart canopy`.

Any other canopy flag goes in the same section.

## Use a forest.json outside the default path

Set `OAKGREEN_FOREST_CONFIG_PATH` before the agents are written, so they carry it:

```sh
export OAKGREEN_FOREST_CONFIG_PATH=~/path/forest.json
cambium install --config "$OAKGREEN_FOREST_CONFIG_PATH"
oakgreen start
```

## Find the logs

| Service | Log |
| --- | --- |
| cambium | `~/.oakgreen/cambium/logs/cambium.log`, launchd errors in `~/.oakgreen/cambium/logs/cambium.launchd.err.log` |
| cambium workers | `~/.oakgreen/cambium/logs/<owner>__<name>/issue-<n>/` |
| mycelium | `~/.oakgreen/mycelium/logs/mycelium.log` |
| canopy | `~/.oakgreen/canopy/logs/canopy.log` |
| otelcol | `~/.oakgreen/cambium/logs/otelcol.log` |
| proxy | `~/.oakgreen/proxy/logs/proxy.log` |

Every command and flag: [oakgreen CLI](/reference/oakgreen-cli/).
