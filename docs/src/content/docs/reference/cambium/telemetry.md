---
title: Telemetry
description: cambium's OpenTelemetry spans, metrics, attributes, environment variables and collector files.
sidebar:
  order: 6
---

cambium's tracing is configured by the standard `OTEL_*` variables only, with `service.name=cambium`. Only graph runs are traced (`engine: "graph"`); the legacy stage tick is not.

## On and off

| Condition                                                                         | Tracing |
| --------------------------------------------------------------------------------- | ------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set         | on      |
| `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none`                           | off     |
| Neither endpoint set                                                              | off; nothing is imported |

Metrics follow the same rule with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_METRICS_EXPORTER`.

With an endpoint but no collector, shutdown can take about 8 s. `OTEL_EXPORTER_OTLP_TIMEOUT=2000` shortens it.

With tracing off there is no `TRACEPARENT` for workers and markers keep `traceparent: null`.

## Spans and metrics

| Name                     | When                                                                                     | Parent                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `cambium.issue`          | Once per issue, when the marker has no `traceparent`. Ended at once; its traceparent goes into the marker. | mycelium's intake span from the issue body, else none |
| `cambium.node`           | Each step-node run.                                                                      | Marker's `traceparent`                                         |
| `cambium.wait`           | When a wait ends; start time is the marker's `enteredAt`.                                | Marker's `traceparent`                                         |
| `cambium.wait.not_ready` | Counter, +1 per not-ready poll. Attributes: graph, node, repo.                           |                                                                |
| `claude.session`         | From the worker's stream-json log, once it exits.                                        | The start-worker `cambium.node` span                           |
| `claude.tool`            | Each `tool_use` → `tool_result`.                                                         | `claude.session`, or a subagent's Agent tool span              |
| `claude.turn`            | Each assistant message with thinking or text.                                            | `claude.session`, or a subagent's Agent tool span              |
| `claude.task`            | Each background task.                                                                    | The tool that started it                                       |

One trace covers an issue across ticks: intake, triage, each task attempt, CI and close-out. A release-prepare run is its own root; the promotion PR's release-promote turns continue it.

## Attributes

`cambium.node` and `cambium.wait`:

| Attribute               | Value                                              |
| ----------------------- | -------------------------------------------------- |
| `cambium.graph`         | Graph name.                                        |
| `cambium.graph.version` | Graph version.                                     |
| `cambium.node`          | Node name.                                         |
| `cambium.attempt`       | Attempt.                                           |
| `cambium.repo`          | `owner/name`.                                      |
| `cambium.issue.number`  | Issue number (the PR number for release graphs).   |
| `cambium.edge`          | Edge taken.                                        |
| `cambium.outcome`       | Output's `outcome` string, else `ok`; `error` on a throw. |

`claude.session`: `claude.session_id`, `claude.model`, `claude_code.version`, `claude.cost_usd`, `claude.tokens.{input,output,cache_read,cache_creation}`, `claude.turns`, `claude.duration_ms`, `claude.terminal_reason`, `claude.result`, `claude.permission_denials`. No `result` event, or an error result: status ERROR.

`claude.tool`: `claude.tool.name`, `claude.tool.outcome` (`ok` \| `error` \| `unfinished`), `claude.tool.command` (Bash, 200 characters). Unpaired: ends at the last timestamp, ERROR.

`claude.turn`: `claude.thinking`, `claude.text` (4000 characters each), `claude.turn.tools`.

`claude.task` events carry no timestamp; their times are those of the latest timestamped event.

## Worker environment

Workers receive `TRACEPARENT` set to their start node's span. Claude Code's own spans under it need these in `worker.env`:

```jsonc
"worker": {
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_LOGS_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
  }
}
```

Resulting spans: `claude_code.interaction` → `claude_code.llm_request`, `claude_code.tool` (→ `.execution`, `.blocked_on_user`). They carry per-request timing and tokens but no cost.

:::caution
Every `claude_code.*` span carries `user.email`, `user.account_uuid`, `user.account_id` and `organization.id`.
:::

Prompts and tool inputs are redacted unless `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` or `OTEL_LOG_TOOL_CONTENT` is set.

## Local collector

cambium's package ships `otel/`:

| File                            | Contents                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `otelcol.yaml`                  | otelcol-contrib config: OTLP/HTTP on `127.0.0.1:4318` → `~/.oakgreen/cambium/otel/{traces,metrics}.jsonl` and Jaeger. |
| `otelcol-aws.yaml`              | Same receiver; traces to X-Ray's OTLP endpoint, metrics to Amazon Managed Service for Prometheus (`sigv4auth`). |
| `com.oakgreencc.otelcol.plist`  | launchd agent `com.oakgreencc.otelcol`.                                                                    |

| Path                              | Contents                                       |
| --------------------------------- | ---------------------------------------------- |
| `~/.oakgreen/cambium/otel/traces.jsonl`    | Spans, OTLP/JSON lines; read by canopy.        |
| `~/.oakgreen/cambium/otel/metrics.jsonl`   | Metrics.                                       |
| `~/.oakgreen/cambium/logs/otelcol.log`     | Collector log.                                 |

Jaeger, when run, takes OTLP/gRPC on `14317` and serves its UI on `16686`.
