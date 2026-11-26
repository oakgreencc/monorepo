---
title: Troubleshoot the stack
description: Fixes for the failures people hit most often.
sidebar:
  order: 16
---

Start with `oakgreen doctor`. Each failing line names its fix.

## Setup and services

| Symptom | Fix |
| --- | --- |
| `oakgreen: <tool> not found` (exit 127) | `npm install -g oakgreen` brings every tool. |
| `graft doctor` fails on App credentials or installation | The App is not created or not installed on this repository. See [Set up graft on a repository](/how-to/set-up-graft-on-a-repository/). |
| `! labels on <repo>: …` from `oakgreen setup` | The App lacks Issues: write or is not installed there. Run `graft doctor`, then setup again. |
| `cambium status`: `skipped: no usable cambium config` | The config is missing or not valid JSON. Run `oakgreen setup`, or fix the file it names. |
| `cambium heartbeat`: `no heartbeat` right after start | The first tick has not finished. Wait 30 s. Still failing: read `~/.oakgreen/cambium/logs/cambium.launchd.err.log`. |
| `oakgreen start` skips cambium | No config at the default path. Run `cambium install --config <file>`, then `oakgreen start cambium`. |
| `oakgreen start` skips mycelium | No source configured, or `repo` missing from the `mycelium` section of `~/.oakgreen/forest.json`. |
| `Bootstrap failed: 5: Input/output error` | Use `oakgreen reload <service>` instead of raw `launchctl`; it waits for the old process to exit. |
| `oakgreen services` shows nothing useful on Linux or Windows | Services are macOS only. graft, canker and deadwood still work. |

## Workers

| Symptom | Fix |
| --- | --- |
| Workers fail with `claude: command not found` | The agent captured `PATH` before Claude Code was installed. Run `cambium install`, then `oakgreen reload cambium`. |
| Every task fails and none go to `q:human` | The base branch is red; cambium waits for it to go green. Look for the issue labelled `red-base`. |
| A repository's tasks never start | Its base reads red because no `ci` check runs on it. Set `"requiredCheck": null`, or the real check name, on its `repos[]` entry. |
| A task is requeued as `spawn-failed` | The worktree's install, hydrate or prepare step failed. The stderr tail is in the issue's state comment and the worker's `err.log`. |
| `q:intake` issues are never triaged | Triage needs `"engine": "graph"` and `phases.dispatch.cap` above 0. |
| `GraphQL budget spent; reads paused until …` in the heartbeat | The App installation's hourly GraphQL budget ran low, so cambium stops reading that repository until the reset. Workers keep running. Close canopy tabs you are not using; each open tab refetches queues every `--cache` seconds. |

## Tracing

| Symptom | Fix |
| --- | --- |
| `curl …:4318/v1/traces` is refused | otelcol is not running. Check `oakgreen services otelcol` and `~/.oakgreen/cambium/logs/otelcol.log`; often `otelcol-contrib` is not in `/opt/homebrew/bin` or `/usr/local/bin`. |
| No traces in canopy | cambium's agent lost `OTEL_EXPORTER_OTLP_ENDPOINT` (reinstalled?), or `engine` is `legacy`, which is not traced. See [Set up tracing](/how-to/set-up-tracing/). |

## graft refusals

Every refusal happens before anything reaches GitHub and ends with the next command to run. What each one means: [graft refusals](/reference/graft/refusals/).
