// @ts-check

export const COLUMNS = /** @type {const} */ (['intake', 'waiting', 'task', 'running', 'human', 'promote'])
const QUEUE_LABEL = { intake: 'q:intake', task: 'q:task', human: 'q:human', promote: 'q:promote' }
const RUNNING = 'running'
const LABELS = [...Object.values(QUEUE_LABEL), RUNNING]
/** cambium's marks on a `q:intake` issue triage parked: deferred to a time, or blocked by open GitHub issues. */
const WAIT = { deferred: 'wait:deferred', blocked: 'wait:blocked' }
const STATE_RE = /<!-- cambium:state (.*?) -->/s

/**
 * One query per repo: the queued issues (with their open and closed GitHub `blockedBy` issues), the comments of the
 * parked ones (`wait:*`, whose cambium state comment says why and until when), the closed ones still in `q:promote` (merged, not yet promoted; cambium
 * takes the label off once promoted), and the open PRs with their check rollup.
 */
export const QUEUES_QUERY = `query($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name) {
    issues(labels: $labels, states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number title url createdAt updatedAt labels(first: 30) { nodes { name } }
        blockedBy(first: 20) { nodes { number title url state } }
      }
    }
    waiting: issues(labels: ["${WAIT.deferred}", "${WAIT.blocked}"], states: OPEN, first: 100) {
      nodes { number comments(first: 100) { nodes { body } } }
    }
    awaiting: issues(labels: ["${QUEUE_LABEL.promote}"], states: CLOSED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url createdAt updatedAt labels(first: 30) { nodes { name } } }
    }
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url headRefName isDraft isInMergeQueue createdAt updatedAt mergeStateStatus
        additions deletions changedFiles
        autoMergeRequest { enabledAt }
        mergeQueueEntry { position state }
        closingIssuesReferences(first: 5) { nodes { number } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 0) {
                  checkRunCountsByState { state count }
                  statusContextCountsByState { state count }
                }
              }
            }
          }
        }
      }
    }
    closed: pullRequests(states: CLOSED, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url headRefName closedAt
        closingIssuesReferences(first: 5) {
          nodes { number title url state createdAt updatedAt labels(first: 30) { nodes { name } } }
        }
      }
    }
  }
}`

export const queryVars = (/** @type {string} */ slug) => {
  const [owner, name] = slug.split('/')
  return { owner, name, labels: LABELS }
}

/**
 * @typedef {{ repo: string, number: number, title: string, url: string, createdAt: string | null,
 *   updatedAt: string | null, labels: string[], why: string | null, priority: string | null, wait?: Wait | null,
 *   brief?: { path: string, command: string }, decide?: import('./decide.mjs').DecideSummary,
 *   decideCommand?: string }} Item
 *   `brief`: added by the server (server.mjs `briefOf`) to a `q:human` item cambium wrote a session brief for.
 *   `decide`: how far a decision has got, from cambium's queue view (cambium queue-view.mjs `decideOf`): on an
 *   `ask:decide` item or one with a `cambium:decide` marker; GitHub's answer never carries it.
 *   `decideCommand`: added by the server (server.mjs `decideCommandOf`) to a `q:human` decision item.
 * @typedef {{ kind: 'deferred' | 'blocked', reason: string | null, until: string | null,
 *   blockers: { number: number, title: string, url: string }[] }} Wait
 *   Why a `waiting` issue is parked: cambium's defer reason and recheck time (`until`, deferred only) from its state
 *   comment, and its open `blockedBy` issues.
 * @typedef {{ passed: number, failed: number, pending: number }} CheckCounts
 *   Checks on the PR's head commit, check runs and commit statuses together; skipped and neutral count as passed.
 * @typedef {{ repo: string, number: number, title: string, url: string, branch: string, draft: boolean,
 *   checks: string | null, tally: CheckCounts | null, inMergeQueue: boolean, autoMerge: boolean,
 *   queue: { position: number | null, state: string | null } | null, mergeState: string | null,
 *   additions: number | null, deletions: number | null, files: number | null,
 *   closes: number[], createdAt: string | null, updatedAt: string | null }} Pr
 * @typedef {{ intake: Item[], waiting: Item[], task: Item[], running: Item[], human: Item[], promote: Item[] }} Columns
 *   `intake`: awaiting triage. `waiting`: in `q:intake` too, but triage parked it (`wait:deferred` / `wait:blocked`).
 * @typedef {Item & { pr: { number: number, title: string, url: string, branch: string, closedAt: string | null } }} Stranded
 *   An open issue with no queue label whose `agent/*` PR was closed unmerged and nothing open replaces it:
 *   it left the Release Queue, and cambium will not pick it up again.
 * @typedef {{ columns: Columns, prs: Pr[], stranded: Stranded[] }} Queues
 */

export const emptyColumns = () =>
  /** @type {Columns} */ ({ intake: [], waiting: [], task: [], running: [], human: [], promote: [] })

/**
 * The column an issue belongs in, by cambium's labels: `running` wins over `q:task`; a `q:intake` issue with a
 * `wait:*` label is `waiting`, not awaiting triage.
 */
export function columnOf(/** @type {string[]} */ labels) {
  if (labels.includes(RUNNING)) return 'running'
  if (labels.includes(QUEUE_LABEL.intake) && (labels.includes(WAIT.deferred) || labels.includes(WAIT.blocked)))
    return 'waiting'
  for (const c of /** @type {const} */ (['human', 'task', 'promote', 'intake']))
    if (labels.includes(QUEUE_LABEL[c])) return c
  return null
}

/**
 * GraphQL answer (`data`, or `{ data }`) → columns and `agent/*` PRs.
 *
 * @param {any} answer
 * @param {string} repo
 * @returns {Queues}
 */
export function group(answer, repo) {
  const r = (answer?.data ?? answer)?.repository
  if (!r) throw new Error(`${repo}: no repository in the GraphQL answer`)
  const columns = emptyColumns()
  /** @type {Map<number, any>} */
  const markers = new Map()
  for (const n of r.waiting?.nodes ?? []) {
    const m = (n?.comments?.nodes ?? []).map((/** @type {any} */ c) => markerIn(c?.body)).find(Boolean)
    if (m) markers.set(n.number, m)
  }
  // Open issues first; a closed one counts only in Promote.
  const awaiting = (r.awaiting?.nodes ?? []).filter(
    (/** @type {any} */ n) => n && !(r.issues?.nodes ?? []).some((/** @type {any} */ o) => o?.number === n.number),
  )
  for (const n of [...(r.issues?.nodes ?? []), ...awaiting.map((/** @type {any} */ n) => ({ ...n, closed: true }))]) {
    const labels = (n?.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name)
    const col = n.closed ? (labels.includes(QUEUE_LABEL.promote) ? 'promote' : null) : columnOf(labels)
    if (!col) continue
    columns[col].push({
      repo,
      number: n.number,
      title: n.title ?? '',
      url: n.url ?? `https://github.com/${repo}/issues/${n.number}`,
      createdAt: n.createdAt ?? null,
      updatedAt: n.updatedAt ?? null,
      labels,
      why: labels.find((/** @type {string} */ l) => l.startsWith('why:'))?.slice(4) ?? null,
      priority: labels.find((/** @type {string} */ l) => l.startsWith('priority:'))?.slice(9) ?? null,
      ...(col === 'waiting' ? { wait: waitOf(n, labels, markers.get(n.number), repo) } : {}),
    })
  }
  /** @type {Pr[]} */
  const prs = (r.pullRequests?.nodes ?? [])
    .filter((/** @type {any} */ p) => p?.headRefName?.startsWith('agent/'))
    .map((/** @type {any} */ p) => ({
      repo,
      number: p.number,
      title: p.title ?? '',
      url: p.url ?? `https://github.com/${repo}/pull/${p.number}`,
      branch: p.headRefName,
      draft: Boolean(p.isDraft),
      checks: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      tally: tallyOf(p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts),
      inMergeQueue: Boolean(p.isInMergeQueue),
      autoMerge: Boolean(p.autoMergeRequest),
      queue: p.mergeQueueEntry
        ? { position: p.mergeQueueEntry.position ?? null, state: p.mergeQueueEntry.state ?? null }
        : null,
      mergeState: p.mergeStateStatus ?? null,
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      files: p.changedFiles ?? null,
      closes: (p.closingIssuesReferences?.nodes ?? []).map((/** @type {any} */ i) => i.number),
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
    }))
  return { columns, prs, stranded: strandedOf(r.closed?.nodes ?? [], prs, repo) }
}

/** cambium's state marker in a comment body, or null. @param {unknown} body */
function markerIn(body) {
  const m = typeof body === 'string' ? STATE_RE.exec(body) : null
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

/**
 * Why a parked issue waits: `wait:blocked` wins (the open `blockedBy` issues), else deferred until the marker's
 * `deferUntil`.
 * @param {any} n @param {string[]} labels @param {any} marker @param {string} repo @returns {Wait}
 */
function waitOf(n, labels, marker, repo) {
  const blockers = (n.blockedBy?.nodes ?? [])
    .filter((/** @type {any} */ b) => b && b.state === 'OPEN')
    .map((/** @type {any} */ b) => ({
      number: b.number,
      title: b.title ?? '',
      url: b.url ?? `https://github.com/${repo}/issues/${b.number}`,
    }))
  const kind = labels.includes(WAIT.blocked) ? 'blocked' : 'deferred'
  return {
    kind,
    reason: typeof marker?.deferReason === 'string' ? marker.deferReason : null,
    until: kind === 'deferred' && typeof marker?.deferUntil === 'string' ? marker.deferUntil : null,
    blockers,
  }
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])

/**
 * A rollup's per-state counts → passed, failed and still pending; null when GitHub sent no counts.
 * A completed check run with no conclusion yet (`COMPLETED`) is left out rather than guessed at.
 *
 * @param {any} contexts
 * @returns {CheckCounts | null}
 */
export function tallyOf(contexts) {
  const rows = [...(contexts?.checkRunCountsByState ?? []), ...(contexts?.statusContextCountsByState ?? [])]
  if (!rows.length) return null
  const t = { passed: 0, failed: 0, pending: 0 }
  for (const { state, count } of rows) {
    if (!count || state === 'COMPLETED') continue
    if (PASSED.has(state)) t.passed += count
    else if (PENDING.has(state)) t.pending += count
    else t.failed += count
  }
  return t
}

/**
 * Closed unmerged `agent/*` PRs (newest first) → the open, unqueued issues they would have closed,
 * once each, skipping any an open agent PR still closes.
 *
 * @param {any[]} closed
 * @param {Pr[]} open
 * @param {string} repo
 * @returns {Stranded[]}
 */
export function strandedOf(closed, open, repo) {
  const covered = new Set(open.flatMap((p) => p.closes))
  /** @type {Stranded[]} */
  const out = []
  for (const p of closed) {
    if (!p?.headRefName?.startsWith('agent/')) continue
    for (const n of p.closingIssuesReferences?.nodes ?? []) {
      if (!n || n.state !== 'OPEN' || covered.has(n.number)) continue
      const labels = (n.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name)
      if (columnOf(labels)) continue
      covered.add(n.number)
      out.push({
        repo,
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? `https://github.com/${repo}/issues/${n.number}`,
        createdAt: n.createdAt ?? null,
        updatedAt: n.updatedAt ?? null,
        labels,
        why: null,
        priority: labels.find((/** @type {string} */ l) => l.startsWith('priority:'))?.slice(9) ?? null,
        pr: {
          number: p.number,
          title: p.title ?? '',
          url: p.url ?? `https://github.com/${repo}/pull/${p.number}`,
          branch: p.headRefName,
          closedAt: p.closedAt ?? null,
        },
      })
    }
  }
  return out
}

/**
 * @typedef {{ slug: string, ok: boolean, error: string | null, fetchedAt: string | null } & Queues} RepoQueues
 * @typedef {{ repos: { slug: string, ok: boolean, error: string | null, fetchedAt: string | null }[], columns: Columns, prs: Pr[], stranded: Stranded[], fetchedAt: string | null, cached: boolean }} QueueView
 */

/**
 * Merge per-repo results into one set of columns, keeping each repo's status.
 *
 * @param {RepoQueues[]} repos
 * @returns {QueueView}
 */
export function combine(repos, cached = false) {
  const columns = emptyColumns()
  for (const r of repos) for (const c of COLUMNS) columns[c].push(...(r.columns[c] ?? []))
  const times = repos
    .map((r) => r.fetchedAt)
    .filter(Boolean)
    .sort()
  return {
    repos: repos.map(({ slug, ok, error, fetchedAt }) => ({ slug, ok, error, fetchedAt })),
    columns,
    prs: repos.flatMap((r) => r.prs),
    stranded: repos.flatMap((r) => r.stranded ?? []),
    fetchedAt: times[0] ?? null,
    cached,
  }
}
