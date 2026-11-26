# mycelium

Intake connectors, and the stack's [Discord broker](#broker). An external event (a Discord post, an App Store review, a TestFlight tester's feedback or crash, a Google Play review, an Android vitals crash or ANR, an in-app Report a Bug) is normalized into an **envelope**, fingerprinted, and either opens one `q:intake` intent issue or, when an open intent already has that fingerprint, becomes a comment on it.

Node ≥ 22; the only dependencies are OpenTelemetry's (see [Tracing](#tracing)). GitHub access goes through [`graft api`](../graft), so `graft` must be on `PATH` and set up for the target repository.

## Usage

```sh
mycelium poll <discord|asc|testflight|play|vitals|device-logs> [--dry-run]   # one pass over one source
mycelium run [--dry-run]                       # every configured source, each on its own interval, then the notifier and the broker
mycelium notify [--dry-run]                    # one notifier pass (see Notify)
mycelium broker                                # one broker pass (see Broker)
mycelium install [--dry-run]                   # write the launchd agent for `run`
```

As a service: write the settings to `~/.oakgreen/forest.json` and the credentials to `~/.oakgreen/env` (see [Configuration](#configuration)), check them with `mycelium poll <source> --dry-run`, then `oakgreen start mycelium`. That writes the agent on first use (`com.oakgreencc.mycelium`, `KeepAlive`, `mycelium run`) and starts it; `oakgreen stop|restart mycelium` and `oakgreen services` manage it from there. `mycelium install` refuses when no source is configured or `MYCELIUM_REPO` is missing, since launchd would restart a process that exits at once. The plist holds only `PATH` (captured at install; `graft` must be on it), `HOME` and an explicit `OAKGREEN_FOREST_CONFIG_PATH`, never settings or credentials. Its log is `~/.oakgreen/mycelium/logs/mycelium.log`: a `mycelium up:` line at start (repository, sources, notify channels), then one timestamped tally line per pass and one JSON line per issue filed or reporter answered.

`--dry-run` prints one JSON line per envelope with the planned action (`create` with title/body/labels, or `comment` with the issue number) and writes nothing: no GitHub writes, no cursor moves. Without a repository it plans against no open intents.

## Envelope and fingerprint

```js
{
  source, externalId, receivedAt, author, title, body, url, meta
}
```

The fingerprint is the first 24 hex chars of `sha256("<source>:<identity>")`, lowercased and trimmed. Only the identity counts; text, author and time do not.

| source      | identity                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| discord     | `<channelId>/<rootId>`: the forum thread, the message a reply answers, or the message itself                                   |
| asc         | `<appId>/<reviewId>`                                                                                                           |
| play        | `<packageName>/<reviewId>`; an edited review keeps its id, so the edit lands as a comment                                      |
| testflight  | feedback: `<appId>/<submissionId>`; crash: `<appId>/crash/<signature>`, so repeats of one crash land as comments on one intent |
| vitals      | `<packageName>/<issueId>`: Google's own crash/ANR grouping, so a recurrence lands as a comment                                 |
| device-logs | `<stage>/<logId>`; an opt-in crash is `<stage>/<signature>`, so repeats of one crash land as comments                          |

## Sources

| source      | reads (GET only)                                                                                                                                                                                     | credentials            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| discord     | channel messages and forum threads                                                                                                                                                                   | `MYCELIUM_DISCORD_*`   |
| asc         | `/v1/apps/{appId}/customerReviews`                                                                                                                                                                   | `MYCELIUM_ASC_*`       |
| testflight  | `/v1/apps/{appId}/betaFeedbackScreenshotSubmissions` and `/v1/apps/{appId}/betaFeedbackCrashSubmissions` (`include=build`), plus `/v1/betaFeedbackCrashSubmissions/{id}/crashLog` for each new crash | `MYCELIUM_ASC_*`       |
| play        | Play Developer API reviews                                                                                                                                                                           | `MYCELIUM_PLAY_*`      |
| vitals      | Play Developer Reporting API crash and ANR issues ([Vitals](#vitals))                                                                                                                                | `MYCELIUM_PLAY_*`      |
| device-logs | SeKtor Device Log API bug reports ([Device logs](#device-logs))                                                                                                                                      | `MYCELIUM_DEVICELOG_*` |

**testflight** files tester comments with screenshots, and the crashes testers chose to send. Both feeds page through `links.next` and keep their own time cursor (`{ feedback, crash }` in the state file). The `## Intake` table carries `meta.build` (build version), `meta.deviceModel`, `meta.osVersion`, `meta.devicePlatform` and `meta.locale`; the tester's email is never read. Screenshot links are Apple's signed URLs: they expire (the body says when), after which the screenshots are only in App Store Connect. A crash body has the tester's comment, the top frames, and the `logText` clipped to 8,000 characters, fenced like all report text.

The crash **signature** is 16 hex chars of sha256 over the exception type, the exception reason (else the termination reason) and the top 3 frames of the last exception backtrace (else the crashed thread), each lowercased with addresses, `+ offset`s, source locations and numbers stripped. A log with none of these is keyed on its submission id instead.

## Issues

A new intent's body is a fixed template: the marker `<!-- mycelium:fingerprint=<fp> -->` on the **first line** (the only place it is read), an `## Intake` table (source, fingerprint, external id, author, received, url, `meta.*`), and `## Report` holding the reporter's text in a fence, so it cannot mention anyone or inject markup. Label: `q:intake`.

Dedupe reads every open `q:intake` issue once per pass (`GET /repos/<repo>/issues?state=open&labels=q:intake`, paginated), so it never depends on the search index.

## Tracing

Each filed envelope records one short `mycelium.intake` span (`service.name=mycelium`), the root of its own trace, with attributes `mycelium.source`, `mycelium.external_id`, `mycelium.fingerprint`, `mycelium.action` (`create` or `comment`) and `mycelium.issue.number`.

- **Create:** the span starts before the issue is written, and its W3C traceparent goes into the first-line marker: `<!-- mycelium:fingerprint=<fp> traceparent=00-<trace-id>-<span-id>-<flags> -->`. The issue number is set on the span once GitHub returns it. Bodies without a traceparent (filed before tracing, or with tracing off) still parse.
- **Comment** (a duplicate): a new trace whose span has a **link** (not a parent) to the issue's traceparent, when it has one.

`parseTraceparent(body)` (exported from `@oakgreencc/mycelium`) returns that span context, `{ traceId, spanId, traceFlags, isRemote, traceparent }`, or null; like the fingerprint, only the first line counts.

Configuration is the standard `OTEL_*` environment only. Spans export over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set (headers, timeout etc. from `OTEL_EXPORTER_OTLP_*`; `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` override the resource). With no endpoint, or `OTEL_SDK_DISABLED=true`, or `OTEL_TRACES_EXPORTER=none`, tracing is a no-op: the SDK is not loaded and no traceparent is written. Spans are batched and flushed before the CLI exits; `--dry-run` never records or exports.

## Notify

The notifier answers reporters where they reported: one acknowledgement while the intent is open (`Filed as #N <url>. You'll get one more message here when it closes.`), and one outcome note when it closes, keyed on `state_reason` (`completed` → **Fixed.**, `duplicate` (or `not_planned` + `duplicate` label) → **Closed as a duplicate.**, anything else or an `invalid` label → **Closed without a fix.**). An intent closed before it was acknowledged gets only the outcome note.

Each pass reads `GET /repos/<repo>/issues?state=all&since=<cursor>` (any label: triage moves intents off `q:intake`), keeps bodies with the first-line marker, reads the source and url from the `## Intake` table, and hands each to that source's channel. What was posted is recorded per issue under `notify` in the state file before the cursor moves, so a restart never posts twice; a failed post is reported in the tally line and holds the cursor, so it is retried next pass. The first pass reads back `MYCELIUM_BACKFILL_HOURS`. `run` runs it after the sources every `MYCELIUM_NOTIFY_INTERVAL_S` (default 60).

Channels are opt-in per source:

| source  | setting                        | posts                                                                                                                                                           |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| discord | `MYCELIUM_DISCORD_NOTIFY=true` | in the forum post's thread, or as a reply to the channel message; mentions never parsed. The bot needs Send Messages (and Send Messages in Threads for forums). |

asc, testflight and play have no channel: their reviews and feedback are answered (or not) in the store consoles. vitals has no reporter to answer, and device-logs has none either: the app shows no replies.

## Device logs

In-app reports (SeKtor You > Settings > Report a Bug) are filed by the app as Device Logs (`POST /v3/me/logs`, `X-Log-Kind: bug-report`) with the note under a `=== USER BUG REPORT ===` header and screenshots as attachments, from iOS and Android. Each pass:

- signs in to the Cognito user pool with `USER_SRP_AUTH` and answers the `SOFTWARE_TOKEN_MFA` challenge with a TOTP code (node:crypto only; the id token is reused until it expires). A refused sign-in fails the pass with Cognito's reason (`device-logs: sign-in refused: NotAuthorizedException: …`), never an empty list;
- lists `GET /v3/admin/device-logs?kind=bug-report&from=<cursor>` through every `nextCursor`, plus the unfiltered list for logs with `kind: null` (clients too old to send `X-Log-Kind`), which are kept only when the body's first line is the report header;
- reads each new log with `GET /v3/admin/device-logs/<logId>` and its body from the presigned `downloadUrl`.

The envelope's table holds `stage`, `kind`, `platform`, `deviceModel`, `appVersion`, `sessionLocalId`, `userId` (the opaque id; never an email) and the screenshot count. The body is the note, the route and trail, and the last 40 lines of the log, with emails, tokens and presigned URLs redacted. Presigned URLs expire, so none is copied: the body names the `GET /v3/admin/device-logs/<logId>` call that returns fresh ones for the log and its screenshots.

With `MYCELIUM_DEVICELOG_CRASHES=true`, `kind: crash` uploads are filed too, keyed by a crash signature (origin, normalized message and top three frames; line numbers and addresses stripped), so every copy of one crash lands on one intent.

Prod uses the read-only `log-reader` principal (SeKtor's `SEKTOR_LOG_READER_USER` / `_PASSWORD` / `_TOTP_SECRET`); the pool and client ids and the API base are `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID` and `VITE_API_BASE_URL` in SeKtor's `apps/admin/.env.prod`.

## State

One cursor per source in `$MYCELIUM_STATE`, else `~/.oakgreen/mycelium/state.json`. The cursor moves after each envelope is filed, so a crash re-reads at most the one in flight. With no cursor, a source starts `MYCELIUM_BACKFILL_HOURS` (default 24) back.

## Status file

`run` writes what it is doing to `$MYCELIUM_STATUS`, else `~/.oakgreen/mycelium/status.json`, atomically: at start, after every pass and at a clean stop. canopy's Intake tab reads it; it holds no credentials. `--dry-run`, `poll` and `notify` write none.

```js
{
  version: 1, pid, host, repo, startedAt, updatedAt, stoppedAt,  // stoppedAt null while running
  sources: [{ name, configured, needs, target, intervalMs, last, nextAt }],  // every source, configured or not
  notify: { channels, intervalMs, last, nextAt } | null,
}
```

`needs` is what an unconfigured source lacks (`not configured; set …`). `target` is what a configured one reads: `2 channels, 1 forum`, `app <id>`, the Play package, or `<stage> · bug reports[ and crashes] · <api host>`; never a token, key or password. `last` is `{ at, ms, ok, created, commented, skipped }` after a good pass, `{ at, ms, ok: false, error }` after a failed one (`message` instead of the tally for `notify`), `null` before the first. `nextAt` is when the next pass is due, `null` once stopped. A status file that cannot be written never stops intake.

## Broker

mycelium is the stack's one Discord client. Local services queue messages for Discord and read the replies through a store mycelium owns: `$MYCELIUM_BROKER_DB`, else `~/.oakgreen/mycelium/broker.db` (SQLite, WAL, so several processes can write at once).

```js
import { inbox, outbox } from '@oakgreencc/mycelium'

outbox.put({ service: 'cambium', topic: 'issue:owner/repo#12', key: 'ask-12-1', body: 'A or B?', traceparent })
// → { queued: true }; the same service and key again is a no-op → { queued: false }
inbox.after('cambium', 'issue:owner/repo#12', cursor)
// → [{ cursor, service, topic, messageId, author, authorId, body, at, traceparent }], oldest first; pass the last cursor to read on
```

`outbox` and `inbox` open the default store on first use (settings resolved like mycelium's own); `openBroker({ path, tracer, log })` opens another.

- **Topics.** The only topic kind is `issue:<owner/repo>#<n>`: one public thread (`owner/repo#n`) in the decisions channel, created on the topic's first post and reused after. Any other topic is refused by `put`.
- **Drain.** `run` (every `MYCELIUM_BROKER_INTERVAL_S`, default 30) and `mycelium broker` post queued messages oldest first, mentions never parsed, at most 2000 characters. Each is marked sent once Discord answers, and carries a nonce Discord enforces, so neither a restart nor a lost answer posts it twice. A failed post stops the pass there and is retried next pass.
- **Receive.** Then every topic thread is read past its cursor. A message by a person lands in the inbox once for each service that has posted to the topic. Bot and webhook messages (mycelium's own posts among them) and system notices only move the cursor.
- **Intake.** The decisions channel is never an intake channel: a `MYCELIUM_DECISIONS_CHANNEL` that is also in `MYCELIUM_DISCORD_CHANNELS` is refused by every command.
- **Tracing and logs.** `put`, each send and each receive record a span, `mycelium.broker.put`, `.send` and `.receive`, with `mycelium.broker.service`, `.topic` and `.key`. `put` is a child of the caller's `traceparent`; the send is a child of the put; a receive is a child of that service's last put in the topic, and its traceparent is on the inbox row. Each also logs one JSON line to the mycelium log: `{ direction: 'out' | 'in', event: 'put' | 'send' | 'receive', service, topic, key }` (a receive's key is `discord:<message id>`).

The bot needs View Channel, Read Message History, Send Messages, Create Public Threads and Send Messages in Threads on the decisions channel.

## Configuration

Three places, highest first:

1. The environment.
2. `~/.oakgreen/env`: credentials, as `KEY=value` lines with the variable names below (`#` comments, values bare or quoted). Mode `0600`. Shared with the rest of the stack.
3. The `mycelium` section of `~/.oakgreen/forest.json` (`$OAKGREEN_FOREST_CONFIG_PATH` names another file): everything that is not a credential, in camelCase without the prefix. `"repo"` is `MYCELIUM_REPO`, `"discordChannels"` is `MYCELIUM_DISCORD_CHANNELS`. Values are strings, numbers or booleans; a list joins with commas.

```json
{ "mycelium": { "repo": "owner/name", "discordChannels": ["123", "forum:456"], "discordGuild": "789" } }
```

A credential (marked † below) in `forest.json` is refused, and so is a key mycelium does not know. A source with missing settings is skipped by `run` and refused by `poll`. With no `mycelium` section while an old `~/.mycelium` (or `$XDG_STATE_HOME/mycelium`) is still there, mycelium exits 1 and names `oakgreen config migrate`.

| variable                                                     | meaning                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `MYCELIUM_REPO`                                              | `owner/name` that receives intents (or `--repo`)                                                                                      |
| `MYCELIUM_STATUS`                                            | status file, default `~/.oakgreen/mycelium/status.json` (see [Status file](#status-file))                                             |
| `MYCELIUM_STATE`                                             | cursor file (or `--state`)                                                                                                            |
| `MYCELIUM_BACKFILL_HOURS`                                    | first-run window, default 24                                                                                                          |
| `MYCELIUM_<SOURCE>_INTERVAL_S`                               | `run` interval; defaults discord 60, asc 900, testflight 900, play 1800, vitals 3600, devicelog 300 (`MYCELIUM_DEVICELOG_INTERVAL_S`) |
| `MYCELIUM_DISCORD_TOKEN` †                                   | bot token (needs View Channel + Read Message History)                                                                                 |
| `MYCELIUM_DISCORD_CHANNELS`                                  | comma list of channel ids; `forum:<id>` for a forum channel                                                                           |
| `MYCELIUM_DISCORD_GUILD`                                     | guild id; required for forum channels, used for message links                                                                         |
| `MYCELIUM_DISCORD_NOTIFY`                                    | `true` answers Discord reporters ([Notify](#notify)); the token then needs Send Messages                                              |
| `MYCELIUM_NOTIFY_INTERVAL_S`                                 | notifier interval in `run`, default 60                                                                                                |
| `MYCELIUM_DECISIONS_CHANNEL` | text channel id whose threads carry the [broker](#broker)'s topics; never also in `MYCELIUM_DISCORD_CHANNELS`; unset: no broker |
| `MYCELIUM_BROKER_DB` | broker store, default `~/.oakgreen/mycelium/broker.db` |
| `MYCELIUM_BROKER_INTERVAL_S` | broker drain and receive interval in `run`, default 30 |
| `MYCELIUM_ASC_KEY_ID`, `MYCELIUM_ASC_ISSUER_ID` †            | App Store Connect API key, shared by `asc` and `testflight` (read access to reviews and beta feedback; no other credential)           |
| `MYCELIUM_ASC_KEY_P8` †                                      | the `.p8` PEM, or its base64                                                                                                          |
| `MYCELIUM_ASC_APP_ID`                                        | the app's numeric App Store Connect id                                                                                                |
| `MYCELIUM_PLAY_PACKAGE`                                      | Android package name (play and vitals)                                                                                                |
| `MYCELIUM_PLAY_KEY_JSON` † / `MYCELIUM_PLAY_KEY_PATH`        | service-account key JSON, inline or as a path (Play Console: reply to reviews / view app info; see [Vitals](#vitals))                 |
| `MYCELIUM_DEVICELOG_API`                                     | SeKtor API base (`VITE_API_BASE_URL`); `/v3` is added unless present                                                                  |
| `MYCELIUM_DEVICELOG_POOL_ID`, `MYCELIUM_DEVICELOG_CLIENT_ID` | the admin Cognito user pool and its app client                                                                                        |
| `MYCELIUM_DEVICELOG_USER`, `MYCELIUM_DEVICELOG_PASSWORD` †   | the log reader's sign-in                                                                                                              |
| `MYCELIUM_DEVICELOG_TOTP_SECRET` †                           | the log reader's base32 TOTP secret                                                                                                   |
| `MYCELIUM_DEVICELOG_STAGE`                                   | the stage in the identity, default `prod`                                                                                             |
| `MYCELIUM_DEVICELOG_CRASHES`                                 | `true` also files `kind: crash` logs, grouped by signature                                                                            |

The connectors only read: Discord, App Store Connect (reviews and TestFlight), Play and the Device Log API are sent GETs (plus Google's OAuth token exchange and the Cognito sign-in). The only writes outside GitHub are the [notifier](#notify)'s, and only for channels turned on. Play's reviews API returns only reviews created or edited in the last week.

## Vitals

The `vitals` source reads Android vitals through the Play Developer Reporting API: `GET https://playdeveloperreporting.googleapis.com/v1beta1/apps/<package>/errorIssues:search` (pages of 100, at most 10), the crash and ANR issues Google has already grouped, each with its cause, location, report and user counts over the last 24 hours, and its first and last app version.

- **New issue:** one intent. Its body gives the cause, location, counts and app versions, plus one sample stack trace from `errorReports:search` filtered on the issue (`errorIssueId = <id>`, one report). If the trace cannot be read, the issue is filed without it.
- **Repeat issue:** a comment, but only when its 24-hour report count goes above the highest count seen so far, or when its app version range (`first..last` version code) changes. If nothing changed, nothing is filed. A count that falls is not news.
- **Cursor:** per issue, the highest count, the version range and the last report time. An issue with no reports for 30 days is dropped from it, so if that issue comes back it counts as new: a comment on its intent if that intent is still open, otherwise a new intent.

It needs no settings of its own: it is configured whenever play is (`MYCELIUM_PLAY_PACKAGE` and `MYCELIUM_PLAY_KEY_*`). It uses the same service account and requests the scope `https://www.googleapis.com/auth/playdeveloperreporting`. In Play Console → Users and permissions, give that account **View app information (read-only)** on the app. Without it the API returns 403, and the error names that permission and the account. The Google Cloud project also needs the Google Play Developer Reporting API enabled.

Interval and quota: `run` polls every hour (`MYCELIUM_VITALS_INTERVAL_S`, default 3600). Google updates vitals data hourly at best, so polling more often only spends quota. Each pass makes one token exchange (cached for an hour), one `errorIssues:search` call per 100 issues, and one `errorReports:search` call per new issue. That is a few dozen calls a day, far below the Reporting API's per-project quota (see the quota in Google Cloud console).

**Test-track feedback has no API.** Play's reviews API covers only production. Testers on internal, closed and open tracks send feedback through the feedback URL or email address set on each track's opt-in page, or through private feedback that shows only in Play Console. Recommendation: in Play Console, set each test track's feedback URL to the Discord #bugs forum, which mycelium already reads (`MYCELIUM_DISCORD_CHANNELS=forum:<id>`). That is a console setting, not code.
