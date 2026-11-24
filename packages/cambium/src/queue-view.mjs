// @ts-check
/**
 * The queue view: each repo's board as canopy shows it (columns, agent PRs, stranded issues), built from the tick's
 * snapshots and written next to the heartbeat (`paths.queues`), so canopy reads it instead of querying GitHub itself.
 * The shapes are canopy's (`packages/canopy/src/queues.mjs`, `Queues`); canopy checks `version` before it reads one.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Q, RUNNING, WAIT } from './labels.mjs'

export const QUEUES_VERSION = 1

/**
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {'intake' | 'waiting' | 'task' | 'running' | 'human' | 'promote'} Column
 * @typedef {{
 *   repo: string, number: number, title: string, url: string, createdAt: string | null, updatedAt: string | null,
 *   labels: string[], why: string | null, priority: string | null, wait?: Wait,
 * }} Item
 * @typedef {{ kind: 'deferred' | 'blocked', reason: string | null, until: string | null,
 *   blockers: { number: number, title: string, url: string }[] }} Wait
 * @typedef {{
 *   slug: string, ok: boolean, error: string | null, fetchedAt: string | null,
 *   columns: Record<Column, Item[]>, prs: any[], stranded: any[],
 * }} RepoView
 *   `fetchedAt`: when cambium read this repo's snapshot. A repo it could not read this tick keeps its last view, with
 *   `ok: false` and the error.
 * @typedef {{ version: number, writtenAt: string, tickSeconds: number, repos: RepoView[] }} QueuesFile
 */

/** @returns {Record<Column, Item[]>} */
const emptyColumns = () => ({ intake: [], waiting: [], task: [], running: [], human: [], promote: [] })

/** The column an issue belongs in, as canopy places it. @param {string[]} labels @returns {Column | null} */
export function columnOf(labels) {
  if (labels.includes(RUNNING)) return 'running'
  if (labels.includes(Q.intake) && (labels.includes(WAIT.deferred) || labels.includes(WAIT.blocked))) return 'waiting'
  for (const c of /** @type {const} */ (['human', 'task', 'promote', 'intake'])) if (labels.includes(Q[c])) return c
  return null
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])

/** Check counts by state → passed, failed and pending (canopy's `tallyOf`). @param {{ state: string, count: number }[] | undefined} rows */
export function tallyOf(rows) {
  if (!rows?.length) return null
  const t = { passed: 0, failed: 0, pending: 0 }
  for (const { state, count } of rows) {
    if (!count || state === 'COMPLETED') continue
    if (PASSED.has(state)) t.passed += count
    else if (PENDING.has(state)) t.pending += count
    else t.failed += count
  }
  return t
}

const labelValue = (/** @type {string[]} */ labels, /** @type {string} */ prefix) =>
  labels.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? null

/** @param {string} repo @param {Issue} i @param {Column} col @returns {Item} */
function itemOf(repo, i, col) {
  const item = /** @type {Item} */ ({
    repo,
    number: i.number,
    title: i.title,
    url: i.url || `https://github.com/${repo}/issues/${i.number}`,
    createdAt: i.createdAt ?? null,
    updatedAt: i.updatedAt ?? null,
    labels: i.labels,
    why: labelValue(i.labels, 'why:'),
    priority: labelValue(i.labels, 'priority:'),
  })
  if (col !== 'waiting') return item
  const marker = /** @type {any} */ (i.stateComment?.marker ?? null)
  const kind = i.labels.includes(WAIT.blocked) ? 'blocked' : 'deferred'
  item.wait = {
    kind,
    reason: typeof marker?.deferReason === 'string' ? marker.deferReason : null,
    until: kind === 'deferred' && typeof marker?.deferUntil === 'string' ? marker.deferUntil : null,
    blockers: i.blockedBy
      .filter((b) => b.state === 'OPEN')
      .map((b) => ({
        number: b.number,
        title: b.title ?? '',
        url: b.url || `https://github.com/${repo}/issues/${b.number}`,
      })),
  }
  return item
}

/**
 * One repo's snapshot → its board. Open queued issues by column (a closed one only in Promote, while it keeps
 * `q:promote`), the open `agent/*` PRs, and the open issues in no queue whose `agent/*` PR closed unmerged with no
 * open PR to replace it.
 * @param {string} repo @param {Snapshot} snap
 * @returns {Pick<RepoView, 'columns' | 'prs' | 'stranded'>}
 */
export function boardOf(repo, snap) {
  const columns = emptyColumns()
  for (const i of snap.issues.values()) {
    const col = i.state === 'CLOSED' ? (i.labels.includes(Q.promote) ? 'promote' : null) : columnOf(i.labels)
    if (col) columns[col].push(itemOf(repo, i, col))
  }
  const prs = snap.prs
    .filter((p) => p.state === 'OPEN')
    .map((p) => ({
      repo,
      number: p.number,
      title: p.title ?? '',
      url: p.url || `https://github.com/${repo}/pull/${p.number}`,
      branch: p.branch,
      draft: Boolean(p.draft),
      checks: p.checks,
      tally: tallyOf(p.counts),
      inMergeQueue: p.inMergeQueue,
      autoMerge: p.autoMerge,
      queue: p.queue ?? null,
      mergeState: p.mergeState ?? null,
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      files: p.files ?? null,
      closes: p.closes,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
    }))
  const covered = new Set(prs.flatMap((p) => p.closes))
  const stranded = []
  for (const p of snap.closed ?? []) {
    if (!p.branch.startsWith('agent/')) continue
    for (const n of p.closes) {
      if (n.state !== 'OPEN' || covered.has(n.number)) continue
      // An issue the snapshot holds is one cambium read for a queue or a PR; only one in no queue is stranded.
      const known = snap.issues.get(n.number)
      if (known && columnOf(known.labels)) continue
      covered.add(n.number)
      const labels = known?.labels ?? []
      stranded.push({
        repo,
        number: n.number,
        title: n.title,
        url: n.url || `https://github.com/${repo}/issues/${n.number}`,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        labels,
        why: null,
        priority: labelValue(labels, 'priority:'),
        pr: {
          number: p.number,
          title: p.title,
          url: p.url || `https://github.com/${repo}/pull/${p.number}`,
          branch: p.branch,
          closedAt: p.closedAt,
        },
      })
    }
  }
  return { columns, prs, stranded }
}

/**
 * The queue view for this tick. A repo not read this tick keeps its board from `prev` (the last file written), marked
 * not ok with the reason; with none to keep, its board is empty.
 * @param {{ repos: string[], snaps: Map<string, Snapshot>, readErrors: Map<string, string>, now: number,
 *   tickSeconds: number, prev?: QueuesFile | null }} o
 * @returns {QueuesFile}
 */
export function queueView({ repos, snaps, readErrors, now, tickSeconds, prev = null }) {
  const at = new Date(now).toISOString()
  return {
    version: QUEUES_VERSION,
    writtenAt: at,
    tickSeconds,
    repos: repos.map((slug) => {
      const snap = snaps.get(slug)
      if (snap) return { slug, ok: true, error: null, fetchedAt: at, ...boardOf(slug, snap) }
      const error = readErrors.get(slug) ?? 'not read this tick'
      const last = prev?.repos?.find((r) => r.slug === slug)
      return last
        ? { ...last, ok: false, error }
        : { slug, ok: false, error, fetchedAt: null, columns: emptyColumns(), prs: [], stranded: [] }
    }),
  }
}

/** Write the queue view atomically: a temp file renamed over the old one. @param {string} path @param {QueuesFile} view */
export function writeQueues(path, view) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(view)}\n`)
  renameSync(tmp, path)
}
