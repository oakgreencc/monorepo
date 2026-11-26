---
title: mycelium
description: mycelium's commands, sources, settings, issue format, fingerprints and notifier.
sidebar:
  order: 5
---

mycelium turns external reports into `q:intake` issues. Each event becomes an **envelope**, is fingerprinted, and either opens one intent issue or comments on the open intent with the same fingerprint.

Package: `@oakgreencc/mycelium`. Node ≥ 22. Dependencies: OpenTelemetry only. GitHub access through `graft api`; `graft` must be on `PATH` and set up for the target repository.

## Commands

| Command | Behaviour |
| --- | --- |
| `mycelium poll <discord\|asc\|testflight\|play\|vitals\|device-logs> [--dry-run]` | One pass over one source. Refused when the source's settings are missing. |
| `mycelium run [--dry-run]` | Every configured source, each on its own interval, then the notifier. Sources with missing settings are skipped. |
| `mycelium notify [--dry-run]` | One notifier pass. |
| `mycelium install [--dry-run]` | Writes the launchd agent `com.oakgreencc.mycelium` (`KeepAlive`, `mycelium run`). Refused with no configured source or no `MYCELIUM_REPO`. |

`--dry-run` prints one JSON line per envelope with the planned action (`create` with title, body and labels, or `comment` with the issue number). No GitHub writes, no cursor moves.

The agent's plist holds only `PATH` (captured at install), `HOME` and an explicit `OAKGREEN_FOREST_CONFIG_PATH`; never settings or credentials. Log: `~/.oakgreen/mycelium/logs/mycelium.log`.

## Sources

All source requests are GETs, plus Google's OAuth token exchange and the Cognito sign-in.

| Source | Reads | Settings | Default interval (s) |
| --- | --- | --- | --- |
| `discord` | Channel messages and forum threads | `MYCELIUM_DISCORD_*` | 60 |
| `asc` | App Store customer reviews | `MYCELIUM_ASC_*` | 900 |
| `testflight` | TestFlight screenshot feedback and crash submissions, with crash logs | `MYCELIUM_ASC_*` | 900 |
| `play` | Google Play reviews (production only; last week only) | `MYCELIUM_PLAY_*` | 1800 |
| `vitals` | Android vitals crash and ANR issues (Play Developer Reporting API) | `MYCELIUM_PLAY_*` | 3600 |
| `device-logs` | SeKtor Device Log API bug reports | `MYCELIUM_DEVICELOG_*` | 300 |

### Required access

| Source | Access |
| --- | --- |
| `discord` | Bot with View Channel and Read Message History. Send Messages (and Send Messages in Threads) with notify on. |
| `asc`, `testflight` | App Store Connect API key with read access to reviews and beta feedback. |
| `play` | Service account with Play Console access to reviews. |
| `vitals` | The same service account with **View app information (read-only)**; Google Play Developer Reporting API enabled on the Cloud project; scope `https://www.googleapis.com/auth/playdeveloperreporting`. |
| `device-logs` | A read-only Cognito user with TOTP MFA. |

### Vitals behaviour

| Event | Result |
| --- | --- |
| New issue | One intent with cause, location, 24-hour counts, app versions and one sample stack trace. |
| 24-hour report count above the highest seen, or app version range changed | A comment. |
| Anything else | Nothing. |
| No reports for 30 days | Dropped from the cursor; a return counts as new. |

## Settings

Read from three places, highest first:

1. The environment.
2. `~/.oakgreen/env`: credentials (marked †), `KEY=value` lines, `#` comments, values bare or quoted. Mode 600.
3. The `mycelium` section of `~/.oakgreen/forest.json`: every other setting, in camelCase without the prefix (`repo` for `MYCELIUM_REPO`, `discordChannels` for `MYCELIUM_DISCORD_CHANNELS`). A list joins with commas.

A credential or an unknown key in `forest.json` is refused. No `mycelium` section while `~/.mycelium` is still there: mycelium exits 1 and names `oakgreen config migrate`.

| Variable | Meaning |
| --- | --- |
| `MYCELIUM_REPO` | `owner/name` that receives intents (or `--repo`). |
| `MYCELIUM_STATE` | Cursor file (or `--state`). |
| `MYCELIUM_STATUS` | Status file, default `~/.oakgreen/mycelium/status.json`. |
| `MYCELIUM_BACKFILL_HOURS` | First-run window. Default 24. |
| `MYCELIUM_<SOURCE>_INTERVAL_S` | `run` interval per source (`DISCORD`, `ASC`, `TESTFLIGHT`, `PLAY`, `VITALS`, `DEVICELOG`). |
| `MYCELIUM_NOTIFY_INTERVAL_S` | Notifier interval in `run`. Default 60. |
| `MYCELIUM_DISCORD_TOKEN` † | Bot token. |
| `MYCELIUM_DISCORD_CHANNELS` | Comma list of channel ids; `forum:<id>` for a forum channel. |
| `MYCELIUM_DISCORD_GUILD` | Guild id. Required for forum channels. |
| `MYCELIUM_DISCORD_NOTIFY` | `true` answers Discord reporters. |
| `MYCELIUM_ASC_KEY_ID`, `MYCELIUM_ASC_ISSUER_ID` † | App Store Connect API key, shared by `asc` and `testflight`. |
| `MYCELIUM_ASC_KEY_P8` † | The `.p8` PEM, or its base64. |
| `MYCELIUM_ASC_APP_ID` | The app's numeric App Store Connect id. |
| `MYCELIUM_PLAY_PACKAGE` | Android package name (`play` and `vitals`). |
| `MYCELIUM_PLAY_KEY_JSON` † / `MYCELIUM_PLAY_KEY_PATH` | Service-account key, inline or as a path. |
| `MYCELIUM_DEVICELOG_API` | Device Log API base; `/v3` is added unless present. |
| `MYCELIUM_DEVICELOG_POOL_ID`, `MYCELIUM_DEVICELOG_CLIENT_ID` | Cognito user pool and app client. |
| `MYCELIUM_DEVICELOG_USER`, `MYCELIUM_DEVICELOG_PASSWORD` † | Log reader sign-in. |
| `MYCELIUM_DEVICELOG_TOTP_SECRET` † | Log reader's base32 TOTP secret. |
| `MYCELIUM_DEVICELOG_STAGE` | Stage in the identity. Default `prod`. |
| `MYCELIUM_DEVICELOG_CRASHES` | `true` also files `kind: crash` logs, grouped by signature. |

Tracing uses the standard `OTEL_*` variables; see [telemetry](/reference/cambium/telemetry/).

## Envelope

```js
{ source, externalId, receivedAt, author, title, body, url, meta }
```

## Fingerprint

First 24 hex characters of `sha256("<source>:<identity>")`. Only the identity counts; text, author and time do not.

| Source | Identity |
| --- | --- |
| `discord` | `<channelId>/<rootId>`: the forum thread, the message a reply answers, or the message itself |
| `asc` | `<appId>/<reviewId>` |
| `play` | `<packageName>/<reviewId>`; an edited review keeps its id |
| `testflight` | Feedback: `<appId>/<submissionId>`. Crash: `<appId>/crash/<signature>` |
| `vitals` | `<packageName>/<issueId>` (Google's grouping) |
| `device-logs` | `<stage>/<logId>`; crash: `<stage>/<signature>` |

A crash signature is a hash of the exception type, reason and top three frames, with addresses, offsets, source locations and numbers stripped.

## Intent issue format

| Part | Content |
| --- | --- |
| First line | `<!-- mycelium:fingerprint=<fp> -->`, with `traceparent=…` when tracing is on. Read only from the first line. |
| `## Intake` | Table: source, fingerprint, external id, author, received, url, `meta.*`. |
| `## Report` | The reporter's text in a code fence. |
| Label | `q:intake` |

Deduplication reads every open `q:intake` issue once per pass, not the search index.

## Notifier

Answers reporters where they reported, for sources with a channel turned on. Only `discord` has one (`MYCELIUM_DISCORD_NOTIFY=true`).

| When | Message |
| --- | --- |
| Intent open | `Filed as #N <url>. You'll get one more message here when it closes.` |
| Closed `completed` | **Fixed.** |
| Closed `duplicate`, or `not_planned` with a `duplicate` label | **Closed as a duplicate.** |
| Any other close, or an `invalid` label | **Closed without a fix.** |

An intent closed before acknowledgement gets only the outcome. What was posted is recorded per issue before the cursor moves.

## State

One cursor per source in `$MYCELIUM_STATE`, else `~/.oakgreen/mycelium/state.json`. The cursor moves after each envelope is filed. With no cursor, a source starts `MYCELIUM_BACKFILL_HOURS` back.

## Status file

`mycelium run` writes `$MYCELIUM_STATUS`, else `~/.oakgreen/mycelium/status.json`, at start, after every pass and at a clean stop. canopy's Intake tab reads it. It holds no credentials. `--dry-run` writes none.

| Field | Shape |
| --- | --- |
| `version` | `1` |
| `pid`, `host`, `repo` | The process, its host and `MYCELIUM_REPO`. |
| `startedAt`, `updatedAt`, `stoppedAt` | ISO times; `stoppedAt` is `null` while running. |
| `sources[]` | Every source, configured or not: `{ name, configured, needs, target, intervalMs, last, nextAt }`. `needs`: what an unconfigured source lacks. `target`: what it reads (channel count, app id, package, stage); never a credential. |
| `sources[].last` | `{ at, ms, ok, created, commented, skipped }`, or `{ at, ms, ok: false, error }`; `null` before the first pass. |
| `notify` | `{ channels, intervalMs, last, nextAt }`, or `null` when no channel is on. |
