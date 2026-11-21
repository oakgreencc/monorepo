# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a solo maintainer running cambium against their own repos. canopy sits in an open browser tab beside their work; they glance at it between tasks rather than sitting in it. Secondary, by virtue of npm publication: strangers who install the oakgreen stack and run canopy on their own machine with no other guidance than the page and its README.

## Product Purpose

canopy is the window onto an autonomous loop. cambium runs headless Claude workers off GitHub label queues; canopy shows, on one local page, whether that loop is alive and what it is doing. Three jobs carry equal weight, and none may be buried to serve another:

- **Health:** mode, last tick and its staleness, step results, workers against their caps and wall-clock limits.
- **What needs me:** `q:human` items and their `why:*` reasons, and issues stranded when their agent PR closed unmerged.
- **Flow:** work moving `q:intake` → `q:task` → `running` → `q:promote`, beside the open `agent/*` PRs and their checks.

Success is a glance that answers "is it healthy, does anything need me, is work moving" without reading.

## Positioning

The only view that joins cambium's local heartbeat file with the GitHub queue labels cambium writes. It holds no credentials (GitHub is read through `graft graphql`), binds loopback only, and imports nothing of cambium's: the heartbeat's documented `version: 1` shape is the whole contract.

## Operating Context

- Started with `canopy`, served at `http://127.0.0.1:4317/`; the page polls `/api/state` every 5 s, GitHub answers are cached ≥ 15 s per repo.
- Heartbeat states the page must express: `ok`, `missing`, `unreadable`, `unknown-version`, and `stale` (last tick older than 3 × `tickSeconds`).
- Per-repo GitHub fetches can fail independently; a failed refresh keeps the last good answer next to its error.
- Multiple repos may be watched at once (`--repo`, repeatable).
- Vocabulary is cambium's: queue labels `q:intake`, `q:task`, `running`, `q:human`, `q:promote`; annotations `why:*`, `priority:*`; branches `agent/*`.

## Capabilities and Constraints

- **Zero runtime dependencies, one self-contained page:** inline CSS and JS, no build step, no external requests (no web fonts, CDNs, or images fetched from elsewhere). Node ≥ 22.
- **Light and dark follow the OS** via `prefers-color-scheme`; no in-page theme toggle.
- **Public OSS:** published to npm as `@oakgreencc/canopy`, AGPL-3.0-only. The page must make sense to someone who has never seen cambium's internals.
- Only `GET`/`HEAD`, only for a loopback `Host`, to defeat DNS rebinding.
- **Open decision:** canopy is read-only today. Whether it stays read-only or later gains actions (relabel, retry, approve) is not decided; future work must not assume either way.

## Brand Commitments

Part of the oakgreen stack, whose packages carry tree names (graft, cambium, mycelium, canopy, canker, deadwood). The name `canopy` is fixed. canopy wears the oakgreen.cc brand as the docs site records it in `docs/DESIGN.md` ("The Forest Manual"): the forest-green ramp (Forest Black ground in dark, Moss Paper in light), flat surfaces separated by hairlines, pills for anything pressed, and the tree ring as its mark. The ring in the header and the favicon takes the health colour. Status gold and rust, and the span-family blue and bark, are the only non-green hues.

## Evidence on Hand

- Test fixtures for every heartbeat state and queue grouping in `test/`.
- No screenshots, users, testimonials, or adoption numbers exist; do not invent them.

## Product Principles

1. **Glanceable first.** The tab is seen in peripheral vision; state must read before text does.
2. **Truth over comfort.** Stale, missing, or failed data is shown plainly with its reason, never smoothed over or hidden behind a last-good value without saying so.
3. **Three jobs, equal footing.** Health, what-needs-me, and flow each get a tab (Health, Inbox, Queue); the header and tab badges keep all three glanceable from whichever tab is open. The Graphs tab shows the shape the flow runs along: each cambium graph, its day's traffic replayed over it. Traces is the drill-down: how one workflow run actually went, span by span.
4. **Self-contained and local.** Nothing leaves the machine; nothing outside the page is required to render it.
5. **Speak cambium's language.** Labels and states use the stack's real terms so the page, the CLI, and GitHub agree.
