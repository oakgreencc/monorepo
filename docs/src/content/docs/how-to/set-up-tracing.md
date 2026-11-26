---
title: Set up tracing
description: Record cambium's workflow runs with a local OpenTelemetry collector, so canopy's Traces and Graphs tabs fill in.
sidebar:
  order: 11
---

Only graph runs are traced, so set `"engine": "graph"` in the cambium config. The doctor does not check tracing; the checks below are the proof.

## Run the local collector

1. Put `otelcol-contrib` in `/opt/homebrew/bin` or `/usr/local/bin` (the agent's `PATH` searches only those and `/usr/bin:/bin`). Download `otelcol-contrib_<version>_darwin_arm64.tar.gz` (or `darwin_amd64`) from the [collector releases](https://github.com/open-telemetry/opentelemetry-collector-releases/releases).
2. Find the config shipped with cambium:

   ```sh
   OTEL_DIR="$(npm root -g)/oakgreen/node_modules/@oakgreencc/cambium/otel"
   [ -d "$OTEL_DIR" ] || OTEL_DIR="$(npm root -g)/@oakgreencc/cambium/otel"
   ```

3. Install the config and the agent, then start it:

   ```sh
   mkdir -p ~/.oakgreen/cambium/otel ~/.oakgreen/cambium/logs
   cp "$OTEL_DIR/otelcol.yaml" ~/.oakgreen/cambium/otel/otelcol.yaml
   otelcol-contrib validate --config ~/.oakgreen/cambium/otel/otelcol.yaml
   cp "$OTEL_DIR/com.oakgreencc.otelcol.plist" ~/Library/LaunchAgents/
   oakgreen start otelcol
   ```

4. Check that it accepts spans (prints `200`):

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
     -d '{"resourceSpans":[]}' http://127.0.0.1:4318/v1/traces
   ```

## Point cambium at it

cambium reads tracing settings from its environment only, so they go in its launchd agent:

```sh
P=~/Library/LaunchAgents/com.oakgreencc.cambium.plist
plutil -replace EnvironmentVariables.OTEL_EXPORTER_OTLP_ENDPOINT -string http://127.0.0.1:4318 "$P"
plutil -replace EnvironmentVariables.OTEL_EXPORTER_OTLP_TIMEOUT -string 2000 "$P"
oakgreen reload cambium
```

`cambium install` rewrites the plist without these. Repeat this step after any reinstall. `cambium update` leaves the plist alone.

Check: `~/.oakgreen/cambium/otel/traces.jsonl` grows after the next graph run, and canopy's **Traces** tab lists it.

## Point mycelium at it

Add `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` to `~/.oakgreen/env`, then `oakgreen restart mycelium`. Issues it files then start their trace.

## Add Jaeger

```sh
docker run -d --name jaeger -p 16686:16686 -p 14317:4317 jaegertracing/jaeger:latest
```

The UI is on `http://127.0.0.1:16686`. Without Jaeger, the collector still writes its files.

## Send to AWS instead

1. Copy `otelcol-aws.yaml` from `$OTEL_DIR` to `~/.oakgreen/cambium/otel/otelcol.yaml` and set the region and workspace in it.
2. Enable X-Ray Transaction Search in the region, and give the collector's process AWS credentials through the default chain (for example a profile in `~/.aws`).
3. `oakgreen restart otelcol`, then check `~/.oakgreen/cambium/logs/otelcol.log` for export errors.

cambium's environment stays the same.

## Add Claude Code's own spans

Add to `worker.env` in the cambium config:

```json
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

:::caution
These spans carry your account's email and ids. Strip them in the collector before exporting anywhere but the local file.
:::

Span names and attributes: [cambium telemetry](/reference/cambium/telemetry/).
