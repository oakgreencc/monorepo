// @ts-check
import { readFile } from 'node:fs/promises'

export const SUPPORTED_VERSION = 1
export const STALE_TICKS = 3
const DEFAULT_TICK_SECONDS = 30

/**
 * @typedef {{
 *   status: 'ok' | 'missing' | 'unreadable' | 'unknown-version',
 *   path: string,
 *   message: string | null,
 *   stale: boolean,
 *   ageMs: number | null,
 *   staleAfterMs: number | null,
 *   data: any,
 * }} Heartbeat
 */

/**
 * Judge an already-parsed heartbeat. Never throws: a page over a broken file
 * must still render and say what is wrong.
 *
 * @param {unknown} raw
 * @param {{ path?: string, now?: number }} [opts]
 * @returns {Heartbeat}
 */
export function judge(raw, { path = '', now = Date.now() } = {}) {
  const base = { path, stale: true, ageMs: null, staleAfterMs: null, data: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...base, status: 'unreadable', message: 'heartbeat is not a JSON object' }
  const hb = /** @type {any} */ (raw)
  if (hb.version !== SUPPORTED_VERSION)
    return {
      ...base,
      status: 'unknown-version',
      message: `heartbeat version ${JSON.stringify(hb.version ?? null)} is not one canopy reads (expects ${SUPPORTED_VERSION}); upgrade canopy or cambium so they agree`,
    }
  const data = normalize(hb)
  const tickSeconds = Number(data.daemon.tickSeconds) > 0 ? Number(data.daemon.tickSeconds) : DEFAULT_TICK_SECONDS
  const staleAfterMs = STALE_TICKS * tickSeconds * 1000
  const finished = Date.parse(data.tick.finishedAt ?? '')
  const ageMs = Number.isFinite(finished) ? Math.max(0, now - finished) : null
  const stale = ageMs === null || ageMs > staleAfterMs
  return {
    path,
    status: 'ok',
    message: stale ? staleMessage(ageMs, tickSeconds) : null,
    stale,
    ageMs,
    staleAfterMs,
    data,
  }
}

function staleMessage(/** @type {number | null} */ ageMs, /** @type {number} */ tickSeconds) {
  if (ageMs === null) return 'cambium has not finished a tick yet'
  return `last tick finished ${Math.round(ageMs / 1000)}s ago, past the ${STALE_TICKS} ticks of ${tickSeconds}s allowed. Check that cambium is running.`
}

const arr = (/** @type {any} */ v) => (Array.isArray(v) ? v : [])
const obj = (/** @type {any} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** Fill the optional parts so the page can read every field without guards. */
function normalize(/** @type {any} */ hb) {
  return {
    version: hb.version,
    host: hb.host ?? null,
    pid: hb.pid ?? null,
    mode: hb.mode ?? 'unknown',
    daemon: { startedAt: null, tickSeconds: null, ...obj(hb.daemon) },
    tick: { n: null, startedAt: null, finishedAt: null, durationMs: null, nextAt: null, ...obj(hb.tick) },
    steps: arr(hb.steps).map((s) => ({
      name: String(s?.name ?? '?'),
      ok: Boolean(s?.ok),
      ms: s?.ms ?? null,
      error: s?.error ?? null,
    })),
    counts: obj(hb.counts),
    caps: obj(hb.caps),
    repos: arr(hb.repos).map((r) => ({
      slug: r?.slug ?? null,
      ok: Boolean(r?.ok),
      error: r?.error ?? null,
      counts: r?.counts ?? null,
      // Absent before cambium watched workflows or reported its GraphQL budget: none watched, budget unknown.
      watch: arr(r?.watch)
        .map(watchOf)
        .filter((w) => w !== null),
      rateLimit: rateLimitOf(r?.rateLimit),
      pausedUntil: pausedUntil(r?.error),
      // Absent before cambium kept cost accounts: no issues, no days.
      cost: { issues: arr(r?.cost?.issues), days: arr(r?.cost?.days) },
    })),
    workers: arr(hb.workers).map((w) => ({ ...obj(w), logs: obj(w?.logs) })),
    events: arr(hb.events),
    engine: typeof hb.engine === 'string' ? hb.engine : null,
    // null: this cambium predates `graphs` (an older heartbeat), which the page says rather than showing none.
    graphs: Array.isArray(hb.graphs) ? hb.graphs.map(graphOf).filter((g) => g !== null) : null,
    costFlagUsd: typeof hb.costFlagUsd === 'number' ? hb.costFlagUsd : null,
  }
}

const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : null)
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const WATCH_STATES = new Set(['green', 'red', 'unknown'])

/**
 * One watched workflow as cambium's `watchStates` writes it, or null without a workflow name. A state canopy does
 * not know reads as unknown; a run without an https URL is kept but not linked.
 * @param {any} w
 */
function watchOf(w) {
  const workflow = str(w?.workflow)
  if (!workflow) return null
  const run = obj(w?.run)
  return {
    workflow,
    branch: str(w.branch),
    state: WATCH_STATES.has(w.state) ? w.state : 'unknown',
    run:
      str(run.url) || str(run.conclusion)
        ? { url: str(run.url), conclusion: str(run.conclusion), at: str(run.at) }
        : null,
    issue: Number.isInteger(w.issue) && w.issue > 0 ? w.issue : null,
    checkedAt: str(w.checkedAt),
    error: str(w.error),
  }
}

/** The GraphQL budget after the repo's last read, or null when cambium did not report it. @param {any} rl */
function rateLimitOf(rl) {
  const remaining = num(rl?.remaining)
  if (remaining === null) return null
  return { remaining, cost: num(rl.cost), resetAt: str(rl.resetAt) }
}

/**
 * When a repo's reads resume, if cambium paused them to save the GraphQL budget (tick.mjs `read`); null otherwise.
 * A paused repo is waiting, not failing, and the page says so.
 * @param {unknown} error
 */
export function pausedUntil(error) {
  const m = typeof error === 'string' ? error.match(/^GraphQL budget spent; reads paused until (\S+)/) : null
  return m && Number.isFinite(Date.parse(m[1])) ? m[1] : null
}

/**
 * One graph as cambium's `describeGraph` writes it, or null when it has no name or nodes. Edges to a node the
 * graph does not list are dropped, so the page never draws a dangling arrow.
 * @param {any} g
 */
function graphOf(g) {
  const name = str(g?.name)
  const nodes = arr(g?.nodes)
    .filter((n) => str(n?.name))
    .map((n) => ({
      name: String(n.name),
      kind: n.kind === 'wait' ? 'wait' : 'step',
      queue: str(n.queue),
      running: n.running === true,
      about: str(n.about),
    }))
  if (!name || !nodes.length) return null
  const names = new Set(nodes.map((n) => n.name))
  const entry = str(g?.entry?.node)
  return {
    name,
    version: Number.isInteger(g.version) ? g.version : null,
    about: str(g.about),
    entry: { queue: str(g?.entry?.queue), node: entry && names.has(entry) ? entry : nodes[0].name },
    nodes,
    edges: arr(g.edges)
      .filter((e) => names.has(e?.from) && (e.to === null || names.has(e.to)))
      .map((e) => ({ from: String(e.from), to: e.to === null ? null : String(e.to), when: str(e.when) })),
  }
}

/**
 * Read and judge the heartbeat file.
 *
 * @param {string} path
 * @param {{ now?: number, read?: (p: string) => Promise<string> }} [opts]
 * @returns {Promise<Heartbeat>}
 */
export async function readHeartbeat(path, { now = Date.now(), read = (p) => readFile(p, 'utf8') } = {}) {
  let text
  try {
    text = await read(path)
  } catch (err) {
    const missing = /** @type {any} */ (err)?.code === 'ENOENT'
    return {
      status: missing ? 'missing' : 'unreadable',
      path,
      message: missing
        ? `no heartbeat at ${path}: cambium has not run here yet, or --state points elsewhere`
        : `cannot read ${path}: ${/** @type {Error} */ (err).message}`,
      stale: true,
      ageMs: null,
      staleAfterMs: null,
      data: null,
    }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      status: 'unreadable',
      path,
      message: `${path} is not JSON: ${/** @type {Error} */ (err).message}`,
      stale: true,
      ageMs: null,
      staleAfterMs: null,
      data: null,
    }
  }
  return judge(raw, { path, now })
}
