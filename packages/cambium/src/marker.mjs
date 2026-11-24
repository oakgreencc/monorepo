// @ts-check
/**
 * The cambium-owned state comment: a hidden JSON marker that is the truth,
 * plus a human-readable rendering of it. One per issue; cambium edits it in
 * place on every transition.
 *
 * Marker v2 names a position in a graph: `{ graph, graphVersion, node, status }`.
 * v1 markers (a `stage` in the fixed task pipeline) are still read and are
 * normalised to v2 in memory; the writer only emits v2.
 *
 * Until the graph runtime replaces the stage tick, v2 also carries the v1
 * fields the tick drives (`phase`, `stage`, `pr`, `host`, …). While `stage` is
 * present it is the tick's view and decides `node` (and `status`) on write.
 */

/**
 * @typedef {'queued' | 'running' | 'submitted' | 'human' | 'done'} Stage
 * @typedef {'waiting' | 'entering' | 'done'} Status
 * @typedef {{
 *   at: string, attempt: number, outcome: string, reason?: string, pr?: number, log?: string,
 *   node?: string | null, spanId?: string,
 * }} HistoryEntry
 * @typedef {{
 *   v: 2,
 *   graph: string,
 *   graphVersion: number,
 *   node: string,
 *   status: Status,
 *   input: Record<string, unknown> | null,
 *   attempt: number,
 *   traceparent: string | null,
 *   enteredAt: string | null,
 *   history: HistoryEntry[],
 *   phase: 'task' | 'dispatch' | 'release' | 'rescue',
 *   stage?: Stage,
 *   pr: number | null,
 *   branch: string | null,
 *   host: string | null,
 *   start: string | null,
 *   submittedAt?: string | null,
 *   queued?: boolean,
 *   failedSha?: string | null,
 *   lastFailure?: string | null,
 *   mergeRefusal?: { sha: string | null, at: string, reason: string } | null,
 *   reworks?: number,
 *   triage?: { title?: string, acceptance?: string[] } | null,
 *   defers?: number,
 *   deferUntil?: string | null,
 *   deferReason?: string | null,
 *   blockedBy?: number[] | null,
 *   reply?: { since: string, question: string | null } | null,
 *   ask?: import('./ask.mjs').AskT | null,
 *   fingerprint?: { hash: string, at: string } | null,
 *   cost?: import('./cost.mjs').Cost | null,
 * }} Marker
 *   `cost`: what this issue's workers have cost so far, per phase (`triage`, `task`, `rescue`) and in `total`, from
 *   each worker's `result` event (cost.mjs). Every write keeps it; a marker without one counts from zero.
 *   `mergeRefusal`: the last `graft pr merge` cambium was refused (PR graph `merge`), and on which head.
 *   `reworks`: how many times the PR graph sent this issue's PR back to a worker.
 *   `defers`, `deferUntil`, `deferReason`: the dispatch graph's `deferred` node: how many times triage deferred, until
 *   when, and what the next triage should check. At the `blocked` node `deferReason` is why and `blockedBy` the open
 *   GitHub `blockedBy` issues it waits on (no `deferUntil`).
 *   `reply`: while triage is pending or running, what a human reply answers (human-reply.mjs): human comments after
 *   `since` are quoted in the triage prompt as the answer to `question`. Cleared when triage lands a verdict.
 *   `ask`: at a `to-human` node, what the person is asked to do (ask.mjs); the comment renders it.
 *   `fingerprint`: the triage inputs (triage-inputs.mjs) the last triage saw, taken at `start-triage` and kept by
 *   `to-human` only for a needs-human verdict; the stall fallback re-triages it only once they change.
 *   `triage`: what the dispatch graph's triage added when it handed the issue to `q:task`; the task prompt shows it.
 * @typedef {{ graph: string, entryNode: string, nodes?: Iterable<string> }} QueueOwner
 */
import { renderAsk } from './ask.mjs'

const PREFIX = '<!-- cambium:state '
const RE = /<!-- cambium:state (.*?) -->/s
const HISTORY_KEPT = 20

/** The task graph's entry node: where a fresh or reset task issue starts. */
export const TASK_ENTRY = 'start-worker'

/** v1 `stage` → the task-graph node it corresponds to. */
export const STAGE_NODE = Object.freeze({
  queued: TASK_ENTRY,
  running: 'worker-running',
  submitted: 'ci-running',
  human: 'to-human',
  done: 'close-out',
})

/**
 * Markers written by the stage tick (and v1 markers) predate graph versions.
 * A real graph version is ≥ 1, so a stage-era marker always goes through the
 * node-still-exists check the first time the graph runtime sees it.
 */
const STAGE_ERA_VERSION = 0

/** v2 defaults, without the stage tick's `stage`. @param {Partial<Marker>} from @returns {Marker} */
const withDefaults = (from) =>
  syncStage({
    graph: 'task',
    graphVersion: STAGE_ERA_VERSION,
    node: TASK_ENTRY,
    status: 'waiting',
    input: null,
    attempt: 1,
    traceparent: null,
    enteredAt: null,
    phase: 'task',
    pr: null,
    branch: null,
    host: null,
    start: null,
    history: [],
    ...from,
    v: 2,
  })

/**
 * A fresh marker. Unless a `node` is given it is the stage tick's: `queued`
 * at the task graph's entry.
 *
 * @param {Partial<Marker>} [from] @returns {Marker}
 */
export const newMarker = (from = {}) => withDefaults(from.node ? from : { stage: 'queued', ...from })

/**
 * While the stage tick drives the marker, `stage` decides the node: the tick
 * only ever spreads a new `stage` into the marker.
 *
 * @param {Marker} m @returns {Marker}
 */
function syncStage(m) {
  if (!m.stage || !(m.stage in STAGE_NODE)) return m
  return { ...m, node: STAGE_NODE[m.stage], status: m.stage === 'done' ? 'done' : 'waiting' }
}

/**
 * A v1 marker as v2: stage → node, phase → graph, `start` → `enteredAt`. The
 * v1 fields stay, so the stage tick keeps working on the result.
 *
 * @param {Record<string, any>} v1 @returns {Marker}
 */
export function migrateV1(v1) {
  return withDefaults({
    stage: 'queued',
    ...v1,
    graph: v1.phase ?? 'task',
    graphVersion: STAGE_ERA_VERSION,
    enteredAt: v1.start ?? null,
    history: Array.isArray(v1.history) ? v1.history : [],
  })
}

/** @param {string | null | undefined} body @returns {Marker | null} */
export function parseMarker(body) {
  const m = RE.exec(body ?? '')
  if (!m) return null
  try {
    const parsed = JSON.parse(m[1])
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.v === 2) return withDefaults(parsed)
    if (parsed.v === 1 || parsed.v === undefined) return migrateV1(parsed)
    return null
  } catch {
    return null
  }
}

/**
 * Appends to the history (newest 20 kept). An entry without a `node` records
 * the node the marker is at, i.e. where the outcome happened.
 *
 * @param {Marker} marker @param {HistoryEntry} entry @returns {Marker}
 */
export const withHistory = (marker, entry) => ({
  ...marker,
  history: [...marker.history, { node: marker.node, ...entry }].slice(-HISTORY_KEPT),
})

/**
 * The comment body. `--` inside the JSON would end the HTML comment early, so
 * it is written as a JSON escape. Always emits v2.
 *
 * @param {Marker} input
 * @param {{ maxAttempts?: number }} [opts]
 */
export function renderMarker(input, { maxAttempts } = {}) {
  const marker = withDefaults(input)
  const json = JSON.stringify(marker).replace(/--/g, '-\\u002d')
  const of = maxAttempts ? `/${maxAttempts}` : ''
  const lines = [
    `${PREFIX}${json} -->`,
    `**cambium** · ${marker.graph} · ${marker.node}${marker.status === 'waiting' ? '' : ` (${marker.status})`}` +
      ` · attempt ${marker.attempt}${of}` +
      (marker.pr ? ` · PR #${marker.pr}` : '') +
      (marker.host ? ` · host \`${marker.host}\`` : '') +
      (marker.start ? ` · started ${marker.start}` : '') +
      (marker.cost?.total?.usd ? ` · cost $${marker.cost.total.usd.toFixed(2)}` : '') +
      (marker.node === 'deferred' && marker.deferUntil ? ` · re-triage after ${marker.deferUntil}` : '') +
      (marker.node === 'blocked' && marker.blockedBy?.length
        ? ` · re-triage once ${marker.blockedBy.map((n) => `#${n}`).join(', ')} close`
        : ''),
  ]
  if (marker.ask && marker.node === 'to-human' && marker.status !== 'done') lines.push('', ...renderAsk(marker.ask))
  if (marker.lastFailure)
    lines.push(
      '',
      '<details><summary>Last failure</summary>',
      '',
      '```',
      marker.lastFailure.replace(/```/g, "'''"),
      '```',
      '</details>',
    )
  if (marker.history.length) {
    lines.push('', '| at | node | attempt | outcome | detail |', '|---|---|---|---|---|')
    for (const h of marker.history)
      lines.push(
        `| ${h.at} | ${h.node ?? ''} | ${h.attempt} | ${h.outcome} | ${[
          h.pr ? `#${h.pr}` : '',
          h.reason ?? '',
          h.log ? `log \`${h.log}\`` : '',
        ]
          .filter(Boolean)
          .join(' · ')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ')} |`,
      )
  }
  lines.push('', '_Written by cambium. Only cambium moves this issue’s labels._')
  return lines.join('\n')
}

// ---- Rules for the graph runtime (pure; the runtime applies them)

/**
 * Label vs node: the queue label wins. If the issue's queue label is owned by
 * a different graph than the marker's, or (when the owner lists its `nodes`)
 * the marker's node does not sit in that queue, or the marker's graph is done,
 * the issue restarts at the owning graph's entry node.
 *
 * No queue label known to `queues`: the marker stands (nothing to compare).
 * No marker: a fresh start at the entry node, which is not a reset.
 *
 * @param {string[]} labels
 * @param {Marker | null} marker
 * @param {Record<string, QueueOwner>} queues queue label → owning graph
 * @returns {{ graph: string, node: string, reset: boolean } | null} null: no queue label and no marker
 */
export function effectivePosition(labels, marker, queues) {
  const label = labels.find((l) => Object.hasOwn(queues, l))
  if (!label) return marker ? { graph: marker.graph, node: marker.node, reset: false } : null
  const owner = queues[label]
  if (!marker) return { graph: owner.graph, node: owner.entryNode, reset: false }
  const agrees =
    marker.graph === owner.graph && marker.status !== 'done' && (!owner.nodes || new Set(owner.nodes).has(marker.node))
  return agrees
    ? { graph: marker.graph, node: marker.node, reset: false }
    : { graph: owner.graph, node: owner.entryNode, reset: true }
}

/**
 * Graph versioning: a marker written under an older version keeps running if
 * its node still exists in the current version; otherwise it restarts at the
 * entry node, with a history note saying why.
 *
 * @param {Marker} marker
 * @param {{ version: number, nodes: Iterable<string>, entryNode: string, at: string }} current
 * @returns {{ action: 'keep' } | { action: 'restart', node: string, note: HistoryEntry }}
 */
export function graphVersionDecision(marker, { version, nodes, entryNode, at }) {
  if (marker.graphVersion === version || new Set(nodes).has(marker.node)) return { action: 'keep' }
  return {
    action: 'restart',
    node: entryNode,
    note: {
      at,
      attempt: marker.attempt,
      node: marker.node,
      outcome: 'graph-changed',
      reason: `${marker.graph} v${marker.graphVersion} → v${version}: node ${marker.node} no longer exists; restarting at ${entryNode}`,
    },
  }
}

/**
 * `status: 'entering'` is written before a step node runs. On a later tick,
 * a marker still `entering` with no tracked process means the step died
 * mid-flight: the node's `recover` runs (default: requeue). Anything else
 * resumes normally.
 *
 * @param {Marker} marker @param {boolean} hasTrackedProcess
 * @returns {'resume' | 'recover'}
 */
export const enteringDecision = (marker, hasTrackedProcess) =>
  marker.status === 'entering' && !hasTrackedProcess ? 'recover' : 'resume'
