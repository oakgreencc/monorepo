# canopy

A local, read-only page over [cambium](../cambium)'s heartbeat and the GitHub queues: mode, last tick and its staleness, step results, counts and caps, workers (attempt, elapsed against the wall-clock cap, log paths), recent events, the `q:human` items with their `why:*`, issues stranded when their agent PR closed unmerged, and one swim lane per queue (`q:intake`, `q:task`, `running`, `q:promote`, which also lists closed issues merged but not yet promoted) next to the open `agent/*` PRs and their checks.

The page has six tabs under a header that always shows mode and tick: **Inbox** (what needs you: `q:human`, and stranded issues), **Queue** (work in hand on top: **Triage**, shown while triage workers run, **Running** and **Pull requests**, each with how far it has got; the `q:intake`, `q:task` and `q:promote` lanes beneath, each under the active column its work moves into; over them, a band with every issue in the loop by stage, `q:human` included, each stage's oldest issue, and from the traces the last 24 hours: issues active, the cambium node each last reached, failed runs and spend), **Graphs** (each of cambium's graphs drawn, with the day's moves replayed over it, see [Graphs](#graphs)), **Traces** (workflow runs, see [Traces](#traces)), **Intake** (mycelium's sources, see [Intake](#intake)) and **Health** (last tick; per repository the last read, the GraphQL budget left and when it resets, and each watched workflow green, red or unknown, linked to its run and `watch` issue; workers; events). Tab badges carry the inbox count, the queued-issue count, the traced-run count (amber when a run has a failed span) and the configured intake-source count (amber when one is failing or overdue, or mycelium is not running), a health dot whose tooltip names the problem, and the browser tab title is prefixed with the inbox count. The tab is kept in the URL hash (`#inbox`, `#inbox/<owner>/<name>/<n>`, `#queue`, `#graphs`, `#graphs/<name>`, `#traces`, `#traces/<trace id>`, `#intake`, `#health`).

## Inbox

The Inbox is a list beside a reading pane, so an item can be read without opening GitHub.

- **At a glance.** A band over the list counts the whole inbox: how many items, when the oldest was opened, the split by reason (`why:*`, no `why:`, **PR closed**) and by priority, and issue ages (under a day, a week, four weeks, older). Age is from the issue's creation, since GitHub's answer doesn't say when an item entered `q:human`.
- **List.** `q:human` items and stranded issues together, each with its `why:*` (or **PR closed**), `priority:*`, repo and age. Sort by **Newest**, **Oldest** or **Priority** (`critical`, `high`, `medium`, `low`, then anything else, then none; newest first within each). A decision's lens (`lens:product` or `lens:technical`) shows next to its `why:*`. Filter from the menus on the list's toolbar (**Kind**: `q:human` / `stranded`, **Reason**: each `why:*`, **Lens**: a decision's `product` / `technical`, **Priority**, **Repo**, and **Label** for any other label); chosen tags show under the toolbar, each removable, with the shown count and **Clear**. Tags in one group widen the list (any of them), tags in different groups narrow it (all groups). Only tags that would change the list are offered. Sort and filters are remembered in this browser.
- **Groups.** The list is grouped by what answering takes, from cambium's `why:*` and `ask:*` labels (`groupOf` / `inboxGroups` in `src/inbox.mjs`), in this order: **Needs a session** (`why:budget`, or `ask:decide` with `ask:session`), **Answer in a comment** (any other `ask:decide`), **Offline chores** (`ask:verify`, `ask:chore`), **Approvals** (`why:approve`, `ask:approve`; matched first), **Other** (no ask to go by) and **PR closed** (stranded). The sort holds within each group; empty groups are hidden; `j` / `k` move through the groups in order.
- **Pane.** The selected issue: cambium's state comment (its readable part; the hidden marker is dropped), the description, and the newest 10 other comments, rendered from Markdown in the page. Images become links, since the page loads nothing from elsewhere. A stranded issue says which PR closed and how to send it back. The pane is not redrawn while nothing in it changed, so text can be selected and `<details>` stay open across polls.
- **Decide.** An `ask:decide` item's pane opens with **Decision**: the command that starts or resumes it in claude, `cd <repo> && claude "/oakgreen:decide <owner/repo#n>"`, with **Copy** (no `cd` when cambium's config gives no checkout for the repo), its lens, and how far it has got, from the `decide` summary in cambium's queue view (its `cambium:decide` marker): **Not started** (no marker yet), **Live** (the node it is at, the round of questions, who holds it, and the last turn's error if it failed), **Paused** (idle at a wait; a reply or the command resumes it), or **Committed** with the outcome and a link to the answer once there is one (**Abandoned** when it was dropped). While canopy reads the queues from GitHub instead, the status shows as unknown. canopy only shows the command: it starts nothing and writes nothing. Items that are no decision look as before.
- **Keys.** `j` / `k` (or the arrow keys in the list) move, `Enter` reads, `o` opens the item on GitHub, `Escape` goes back to the list on narrow screens, where the list and the pane take turns.
- **Reading.** The selected issue is read first, then the rest of the list one at a time; each is re-read when its `updatedAt` changes or after a minute.

## Graphs

The **Graphs** tab draws cambium's graphs as the heartbeat describes them (cambium's `graphs`, from `describeGraph`), so canopy needs no copy of them. A cambium too old to publish them gets a note saying so.

- **Drawer.** Every graph with its version, what it is for, its node and wait counts, how many issues still in the loop last stepped through it, and its moves in the last 24 hours. Docked beside the drawing on wide screens (hide it with the button by the title; remembered in this browser), a slide-over drawer on narrow ones.
- **Drawing.** Left to right when it fits, top down when that draws larger. Steps are boxes, waits chamfered; each node shows its queue label (colored like the Queue lanes) and whether it holds `running`. Conditional edges carry the condition's name; a retry runs in a lane under the nodes it loops past; an ending is a short stub into a terminal mark. Edge weight is the last day's traffic; a badge counts the issues, still in the loop, whose newest traced step was that node.
- **Flow.** The last 24 hours of moves through the graph, read from the traces, replay in 24 seconds (a second an hour) as pulses along the edges, with a timeline to pause or jump. Moves traced while you watch run as they land. With no moves (or tracing off) the drawing walks every path an issue can take, and says so. Reduced motion swaps pulses for a brief highlight of the edge.
- **Details.** Hover or focus a node for what it does, the labels an issue resting there carries, its last day (visits, failures, median run or wait, last visit), the issues whose last step was there, and every edge in and out with its condition and traffic. Click (or `Enter`) pins the card; `Escape` lets it go.

## Intake

The **Intake** tab shows mycelium's sources, read from the status file `mycelium run` writes (mycelium's README, [Status file](../mycelium/README.md#status-file); `--intake`, default `$MYCELIUM_STATUS`, else `~/.mycelium/status.json`). canopy never opens mycelium's settings file: the status file names what each source reads, never its credentials.

- **At a glance.** How many sources are configured and how many need a look; mycelium's uptime and pid; what each source filed in the last 24 hours (issues opened and comments, from the `mycelium.intake` spans); the repository it files into, with the `q:intake` count awaiting triage; and whether it answers reporters.
- **Configured.** One row per source: what it reads (channel count, app id, package, stage), its state, interval, last pass (when, what it filed, how long it took), when the next is due, and its filings over 24 hours and 7 days. A failed pass's error is shown under the row. States: **polling**, **first pass due**, **failing** (last pass failed), **overdue** (next pass more than 2 minutes, or one interval, late), **stopped**. When every source is overdue, mycelium is reported as possibly stopped.
- **Not configured.** The other sources, each with the settings it lacks.
- **Recent filings.** The newest 25 `mycelium.intake` spans: when, source, opened / commented / failed, the issue, the trace, and the external id.

No status file (mycelium not running, or older than the status file) gets a note saying so; a status file with any other `version` is reported, not guessed at. Without traces the counts and filings say tracing is off.

## Traces

The **Traces** tab shows cambium's OpenTelemetry spans (see cambium's README, [Tracing](../cambium/README.md#tracing)) without Jaeger: canopy reads the JSON-lines file that cambium's local collector (`packages/cambium/otel/otelcol.yaml`) writes, `~/.cambium/otel/traces.jsonl` by default, plus its rotated backups (`traces-<time>.jsonl`, newest first, up to 64 MB in all).

- **Runs.** One row per trace, newest first: one workflow run of an issue through cambium's graphs (the `cambium.issue` root and every `cambium.node` / `cambium.wait` / `claude.*` span under it, across ticks), or a mycelium intake. Each row shows the issue, graph, the last node to finish and its `cambium.outcome`, start, duration, span and failed-span counts and the summed `claude.cost_usd`.
- **One run** (`#traces/<id>`): a waterfall of its spans, parents above children; waits are grey, failed spans red. Click a span for its attributes, status and events.
- **Stranded.** An open issue with no queue label whose `agent/*` PR was closed unmerged (and no open agent PR closes it) has left the Release Queue and cambium won't pick it up again. The Inbox lists it under **PR closed, issue stranded** with the closed PR; it counts toward the inbox badge. Read from the 50 most recently updated closed PRs per repo.
- **Cost.** From the heartbeat's `repos[].cost` (cambium's README, [State on GitHub](../cambium/README.md#state-on-github)): Inbox rows, the reading pane and Queue cards show what the issue has cost so far (per phase on hover; red once flagged), and the Queue band has a figure of the last 7 UTC days' spend, stacked by phase. An issue whose task spend is over cambium's `costFlagUsd` with no merged PR is a **session candidate**: tagged `flag:cost` ("over budget" under **Flag**), listed in the Inbox even outside `q:human`, grouped under **Needs a session** (unless it awaits an approval), and its reading pane says so.
- **Links.** Inbox and Queue items and the Workers table link to the newest trace for their issue.
- **Interactive session.** A `q:human` item cambium wrote a session brief for (`<paths.home>/briefs/<owner>__<name>/issue-<n>.md`; see cambium's README, [Session briefs](../cambium/README.md#session-briefs)) shows the command `cd <repos[].path> && claude "$(cat <brief>)"` in the reading pane with a **Copy** button. The server checks for the file on each `/api/state` and adds `brief: { path, command }` to the item; items without one show nothing. For an `ask:decide` item (or one with a `decide` summary) it adds `decideCommand`, the `/oakgreen:decide` command the pane's **Decision** part shows (see [Inbox](#inbox)).

Nothing is traced until cambium runs with `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at that collector; until then the tab says so. Files are re-parsed only when one changes size or mtime.

Zero runtime dependencies, Node ≥ 22. GitHub is read through [`graft`](../graft) (`graft graphql`), which must be on `PATH`; canopy holds no credentials and writes nothing.

## Quick start

```sh
npm install -g @oakgreencc/canopy @oakgreencc/graft
canopy                       # http://127.0.0.1:4317/
```

## As a service

On macOS, canopy can run as a launchd agent beside cambium, so it is always up and restarts with the stack:

```sh
oakgreen start canopy        # writes the agent (canopy install) on first run, then loads it
oakgreen restart canopy      # new process on new code, e.g. after npm i -g
```

With the `proxy` service running too (`oakgreen start` starts it), canopy is also at `http://canopy.localhost/`; see oakgreen's [Proxy](../oakgreen/README.md#proxy).

`canopy install [flags]` writes `~/Library/LaunchAgents/com.oakgreencc.canopy.plist`, serving with the flags given (`--dry-run` prints it instead). KeepAlive restarts it whenever it exits; output goes to `~/.canopy/logs/canopy.log`. After changing the flags, run `canopy install …` again, then `oakgreen reload canopy`.

## Flags

| Flag                  | Default                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--port <n>`          | `4317`                                                                                          |
| `--host <addr>`       | `127.0.0.1`. canopy never binds a public address unless told to.                                |
| `--state <file>`      | cambium config's `paths.heartbeat` (or `paths.home`/`state.json`), else `~/.cambium/state.json` |
| `--queues <file>`     | cambium config's `paths.queues` (or `paths.home`/`queues.json`), else `~/.cambium/queues.json`  |
| `--traces <file>`     | `<paths.home>/otel/traces.jsonl` from the cambium config, else `~/.cambium/otel/traces.jsonl`   |
| `--intake <file>`     | `$MYCELIUM_STATUS`, else `~/.mycelium/status.json`                                              |
| `--config <file>`     | `$CAMBIUM_CONFIG`, else `~/.cambium/config.json`                                                |
| `--repo <owner/name>` | repeatable; else the config's `repos[].slug`, else the heartbeat's repos                        |
| `--cache <seconds>`   | `60`; minimum `15`; for GitHub reads only                                                       |
| `--graft <cmd>`       | `graft`                                                                                         |

## What it serves

- `GET /`: one self-contained HTML page (inline CSS and JS, no external requests, light and dark by `prefers-color-scheme`). It polls `/api/state` every 5 s.
- `GET /api/state`: `{ now, pollMs, cacheMs, notes, heartbeat, github, traces, intake, cost }`.
  - `intake`: `{ status, path, message, running, data, activity }`. `status` is `ok`, `missing`, `unreadable` or `unknown-version`; `data` is the status file with a `state` on each source (`ok`, `waiting`, `failing`, `overdue`, `stopped`, `off`) and `ageMs`; `running` is false once mycelium stopped or every source is overdue. `activity` (null without traces): `{ bySource: { <source>: { day, week, lastAt } }, recent }`, `day`/`week` being `{ created, commented, failed }` and `recent` the newest 25 filings `{ at, source, action, issue, externalId, failed, traceId }`.
  - `traces`: `{ status, path, message, files, malformed, total, errored, byIssue, progress, recent, flow }`. `recent` covers traces with a span in the last 24 hours: `{ sinceMs, runs, errored, costUsd, byNode: [{ node, n }] }`, `byNode` counting the last cambium node each reached (`null` for none), most common first. `status` is `ok`, `missing` or `unreadable`; `byIssue` maps `owner/name#n` to that issue's newest trace id, and `progress` maps it to where that run has got: `{ id, graph, node, outcome, costUsd, errors, end, trail }`, `trail` being the last 6 graph nodes it stepped through. `flow` is how work moved through each graph over the same window, from the `cambium.node`/`cambium.wait` spans: `{ sinceMs, graphs: { <graph>: { nodes: { <node>: { visits, errors, medianMs, lastAt } }, edges: [{ from, to, n }], moves: [{ from, to, at, issue, error }], total } }, at: { 'owner/name#n': { graph, node, at, outcome } } }`; `from: null` is an entry, `moves` keeps the newest 600, and `at` is each issue's newest step whenever it was.
  - `heartbeat`: `{ status, path, message, stale, ageMs, staleAfterMs, data }`. `status` is `ok`, `missing`, `unreadable` or `unknown-version`; anything but `ok` has `data: null` and a `message` the page shows. `stale` once the last tick finished more than 3 × `tickSeconds` ago. `data.engine` and `data.graphs` are cambium's, as its heartbeat carries them (`graphs` is `null` from a cambium that predates them).
  - `github`: `{ repos: [{ slug, ok, error, fetchedAt }], columns: { intake, waiting, task, running, human, promote }, prs, fetchedAt, cached, source, fallback }`. `source` is `cambium` (from its queue view), `github` or `mixed`; `fallback` says why canopy read GitHub itself, else `null`. Each PR carries its check rollup (`checks`) and `tally` (`{ passed, failed, pending }` over check runs and statuses), `autoMerge`, `inMergeQueue` and `queue` (`{ position, state }`), `mergeState` (GitHub's `mergeStateStatus`), `additions`, `deletions`, `files` and `closes`.

- `GET /api/traces`: the same file fields plus `traces` (the newest 200 runs: `{ id, start, end, durationMs, spans, errors, root, services, repo, issue, graph, node, outcome, costUsd, trail }`, times in epoch ms).
- `GET /api/traces/<trace id>`: `{ summary, spans }`, spans in tree order with a `depth`; 404 for an unknown id.
- `GET /api/issue/<owner>/<name>/<n>`: `{ issue, fetchedAt, error }` for an issue in a watched repo, `issue` being `{ repo, number, title, url, state, author, body, createdAt, updatedAt, labels, status, comments, earlier }`: `status` is cambium's state comment, `comments` the newest 10 others (oldest first), `earlier` how many others are left to GitHub. Cached like the queues; `error` beside an `issue` means the last refresh failed. 404 for another repo or a missing issue.

Only `GET`/`HEAD` are answered, and only for a loopback `Host` (or the `--host` given), so another site cannot read the page through DNS rebinding.

## Contract with cambium and mycelium

canopy reads the heartbeat file as documented in cambium's README (shape `version: 1`) and, for traces, the collector's OTLP/JSON output with the span names and attributes listed there; it does not import cambium. A heartbeat with any other `version` is reported, not guessed at. mycelium is read the same way: its status file's documented `version: 1` shape is the contract, and canopy does not import mycelium.

Queues come from labels, as cambium writes them: an open issue with `running` is in **Running** (it also carries `q:task`), or in **Triage** when it carries `q:intake` (a triage worker has it); otherwise its `q:*` label places it. A `q:intake` issue triage parked carries `wait:deferred` or `wait:blocked` and goes to `waiting`, not `intake`: the Intake lane lists only issues awaiting triage, and a **Deferred / Blocked** group under it lists the parked ones with the defer reason and when it is due (from cambium's state comment), or the open GitHub `blockedBy` issues. A worker the heartbeat lists whose issue GitHub does not show as `running` is still shown, flagged. `why:*` and `priority:*` are shown on the item.

## Queue view

While cambium runs, the queues come from the queue view it writes every tick (`paths.queues`, default `~/.cambium/queues.json`; shape in cambium's README, [Queue view](../cambium/README.md#queue-view-queuesjson)), re-read on each `/api/state`, and canopy makes no GraphQL call for them. It queries GitHub itself for a repo when the file is missing, unreadable, of another `version`, older than 3 × its `tickSeconds` (cambium is down), or does not list the repo; the page shows a **Queues read from GitHub** banner saying why. The issue pane always reads GitHub, through the cache below.

## Cache

Each repo's GitHub answer is reused for `--cache` seconds (at least 15) however many tabs poll; one fetch per repo is in flight at a time, and a failed refresh keeps the last good answer next to the error.

## Tests

```sh
npm test
```

Heartbeat parsing (fresh, stale, missing, unreadable, unknown version), queue grouping, the Inbox's sorting, tag filters and groups, the Markdown renderer, issue reading and its cache, the cache, settings resolution, trace parsing (OTLP/JSON values, grouping, summaries, span tree order, rotated files, the read cache), the JSON endpoint and the HTML page, all against fixtures and an injected GitHub client on an ephemeral loopback port. Nothing touches the network or `graft`.

## License

AGPL-3.0-only
