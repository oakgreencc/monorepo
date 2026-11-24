// @ts-check
/**
 * `engine: "graph"`: the Task-phase steps of the tick, driven through the `task` graph (graphs/task.mjs) and the
 * `pr` graph (graphs/pr.mjs).
 *
 * The tick keeps its shape (Reconcile → Watch → Sweep → Schedule); each step only chooses where a turn starts:
 *
 * - Reconcile: every tracked worker's issue at `worker-running` (task graph, which ends at `submit`).
 * - Watch: every agent PR paired with a cambium-owned issue, at the PR graph's `assess`: a merged one (its issue
 *   open) to close out, an open one once its CI has settled and its issue has no Task queued or running.
 * - Sweep: a stale `running` lease runs its node's `recover` (default: `requeue`).
 * - Schedule: the gate on the task entry. Caps and priority pick the issues; each starts at `start-worker`.
 *
 * A turn ({@link drive}) advances one transition at a time and stops when it reaches the entry node again (only
 * Schedule admits entries), when it enters a wait (polled next tick, unless the wait is `pollOnEntry`), at END,
 * or at a wait that is not ready.
 */
import { upkeep } from './upkeep.mjs'
import { advance, END } from './graph/index.mjs'
import { deleteMergedBranch, prGraph } from './graphs/pr.mjs'
import { HANDED_OFF, inputFor, lostLeaseOf, task, TASK_QUEUES, TERMINAL } from './graphs/task.mjs'
import { prFor } from './phases/task.mjs'
import { iso, key, markerOf, setLabels, setMarker } from './issue-state.mjs'
import { effectivePosition, graphVersionDecision, withHistory } from './marker.mjs'
import { each, eachWorker, newCtx, staleLeases, taskCandidates, watchPairs } from './tick.mjs'
import { move, Q, RUNNING } from './labels.mjs'
import { markerTrace, turnTracer } from './tracing.mjs'
import { DISPATCH_STEPS, driveDispatch } from './dispatch-engine.mjs'
import { dispatch } from './graphs/dispatch.mjs'
import { releasePrepare, releasePromote, runRelease } from './graphs/release.mjs'
import { trackPromotion } from './promotion.mjs'
import { trackBaseHealth } from './base-health.mjs'
import { rescue } from './graphs/rescue.mjs'
import { runRescue } from './rescue-engine.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./graphs/task.mjs').Subject} Subject
 * @typedef {import('./graphs/task.mjs').Position} Position
 * @typedef {import('./graph/advance.mjs').Transition} Transition
 * @typedef {{ transitions: Transition[], reason: 'waiting' | 'gated' | 'end', node: string, input: unknown }} Turn
 */

/** @param {Deps} deps @param {Ctx} ctx @param {Subject} subject @returns {import('./graphs/task.mjs').TaskCtx} */
const taskCtx = (deps, ctx, subject) => ({ ...deps, tick: ctx, subject })

/** @param {import('./graph/define.mjs').Graph} g @param {string} name @returns {import('./graphs/task.mjs').TaskNode} */
function nodeIn(g, name) {
  const node = g.nodes.find((n) => n.name === name)
  if (!node) throw new Error(`${g.name} graph has no node "${name}"`)
  return /** @type {import('./graphs/task.mjs').TaskNode} */ (node)
}

/**
 * One issue's turn from `at` in graph `g` (the task graph unless given). A node error is rethrown as the node's own
 * error (the step logs it, as the legacy tick does); a worker whose `worker-running` was left is torn down only
 * after the turn's writes succeeded.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {Subject} subject @param {Position} at
 * @param {import('./graph/define.mjs').Graph} [g]
 * @returns {Promise<Turn>}
 */
export async function drive(deps, ctx, subject, at, g = task) {
  const c = taskCtx(deps, ctx, subject)
  const traced = turnTracer(deps.telemetry, subject, {
    graph: g.name,
    graphVersion: g.version,
    repo: subject.slug,
    issue: subject.number,
    issueBody: subject.issue?.body ?? null,
    ...markerTrace(subject.issue?.stateComment?.marker),
  })
  /** @type {Transition[]} */
  const transitions = []
  let pos = at
  /** @type {Turn['reason']} */
  let reason
  for (;;) {
    const r = await advance(g, pos, c, { maxTransitions: 1, instrument: traced.instrument })
    if (r.error) throw r.error.cause instanceof Error ? r.error.cause : r.error
    transitions.push(...r.transitions)
    const t = r.transitions[0]
    traced.sync()
    if (t && t.to !== END) await nodeIn(g, t.to).enter?.(t.next, c)
    pos = { node: r.node, input: r.input }
    if (r.reason !== 'limit') {
      reason = r.reason === 'waiting' ? 'waiting' : 'end'
      break
    }
    if (r.node === g.entry.node) {
      reason = 'gated'
      break
    }
    const next = nodeIn(g, r.node)
    if (next.kind === 'wait' && !next.pollOnEntry) {
      reason = 'waiting'
      break
    }
  }
  if (transitions.some((t) => t.from === 'worker-running')) await releaseWorker(deps, subject)
  return { transitions, reason, ...pos }
}

/** The worker row goes, then its worktree (kept, with a warning, when it holds local-only work). @param {Deps} deps @param {Subject} s */
async function releaseWorker(deps, s) {
  const w = deps.store.worker(s.slug, s.number)
  if (!w) return
  deps.store.removeWorker(s.slug, s.number)
  const repo = deps.config.repos.find((r) => r.slug === s.slug)
  if (!repo) return
  const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch })
  if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: s.slug, issue: s.number })
}

/**
 * Where an issue rests in the task graph, from its labels and marker: the label wins (marker.mjs
 * `effectivePosition`), a node the PR graph now owns (v1's `ci-running` … `close-out`, a stage-era `submitted`)
 * is not the task graph's, and any other node the current graph version no longer has restarts at the entry (with
 * a `graph-changed` history note).
 *
 * @param {import('./github.mjs').Issue} issue @param {number} now
 * @returns {(Position & { note?: import('./marker.mjs').HistoryEntry }) | null} null: not in the task graph
 */
export function locate(issue, now) {
  const marker = issue.stateComment?.marker ?? null
  const pos = effectivePosition(issue.labels, marker, TASK_QUEUES)
  if (!pos || pos.graph !== task.name) return null
  if (pos.reset || !marker) return { node: task.entry.node, input: {} }
  if (!issue.labels.includes(Q.task) && HANDED_OFF.has(pos.node)) return null
  const v = graphVersionDecision(marker, {
    version: task.version,
    nodes: task.nodes.map((n) => n.name),
    entryNode: task.entry.node,
    at: iso(now),
  })
  if (v.action === 'restart') return { node: v.node, input: {}, note: v.note }
  return { node: pos.node, input: inputFor(pos.node, marker) }
}

/**
 * A marker whose node is gone from the graph: back to `q:task` at the entry, with the note in its history.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {import('./github.mjs').Issue} issue
 * @param {import('./marker.mjs').HistoryEntry} note
 */
async function restart(deps, ctx, slug, issue, note) {
  const m = markerOf(issue)
  await setMarker(deps, slug, issue, {
    ...withHistory(m, note),
    graph: task.name,
    graphVersion: task.version,
    node: task.entry.node,
    status: 'waiting',
    host: null,
    start: null,
    input: null,
  })
  await setLabels(deps, slug, issue, move(issue.labels, Q.task))
  ctx.touched.add(key(slug, issue.number))
  deps.log('info', note.reason ?? 'graph changed; restarting', { repo: slug, issue: issue.number })
}

// ---- The Task-phase steps

/** @param {Deps} deps @param {Ctx} ctx */
async function reconcile(deps, ctx) {
  await eachWorker(
    deps,
    ctx,
    deps.store.workers().filter((w) => w.phase === 'task'),
    async (w) => {
      const snap = ctx.snaps.get(w.repo)
      const subject = { slug: w.repo, number: w.issue, snap, issue: snap?.issues.get(w.issue) }
      await drive(deps, ctx, subject, { node: 'worker-running', input: { branch: w.branch, attempt: w.attempt } })
    },
  )
}

/** Queues that mean a Task is still to run (or a triage, or a promotion): the PR graph leaves the PR alone. */
const BUSY = new Set([Q.task, Q.intake, Q.promote])

/**
 * The PR graph may assess this pair: its CI has settled and its issue has no Task queued or running (no lease, no
 * tracked worker). `q:human` is allowed; `assess` only takes such an issue back to merge a green PR.
 * @param {Deps} deps @param {string} slug @param {import('./github.mjs').PullRequest} pr @param {import('./github.mjs').Issue} issue
 */
export const assessable = (deps, slug, pr, issue) =>
  pr.state === 'OPEN' &&
  pr.checks !== 'PENDING' &&
  pr.checks !== 'EXPECTED' &&
  !issue.labels.some((l) => BUSY.has(l) || l === RUNNING) &&
  !deps.store.worker(slug, issue.number)

/** @param {Deps} deps @param {Ctx} ctx */
async function watch(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    /** @type {Set<string>} */
    const deleted = new Set()
    await each(
      deps,
      watchPairs(snap),
      async ([pr, issue]) => {
        if (ctx.touched.has(key(slug, issue.number))) return
        /** @type {Subject} */
        const subject = { slug, number: issue.number, snap, issue, pr, deleted }
        const entry = { node: prGraph.entry.node, input: {} }
        if (pr.state === 'MERGED') {
          if (issue.state === 'OPEN') await drive(deps, ctx, subject, entry, prGraph)
          else await deleteMergedBranch(taskCtx(deps, ctx, subject), pr)
          return
        }
        if (assessable(deps, slug, pr, issue)) await drive(deps, ctx, subject, entry, prGraph)
      },
      ([, issue]) => ({ repo: slug, issue: issue.number }),
    )
  }
}

/** @param {Deps} deps @param {Ctx} ctx */
async function sweep(deps, ctx) {
  for (const [slug, snap] of ctx.snaps)
    await each(
      deps,
      staleLeases(deps, ctx, slug, snap).filter((issue) => !issue.labels.includes(Q.intake)),
      async (issue) => {
        const subject = { slug, number: issue.number, snap, issue }
        const c = taskCtx(deps, ctx, subject)
        const at = locate(issue, ctx.now)
        const recover = (at && nodeIn(task, at.node).recover) || defaultRecover
        await drive(deps, ctx, subject, recover(c))
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
}

/** @param {Deps} deps @param {Ctx} ctx */
async function scheduleTasks(deps, ctx) {
  await each(
    deps,
    taskCandidates(deps, ctx),
    async (c) => {
      const subject = { slug: c.slug, number: c.issue.number, snap: c.snap, issue: c.issue }
      await drive(deps, ctx, subject, { node: task.entry.node, input: {} })
    },
    (c) => ({ repo: c.slug, issue: c.issue.number }),
  )
}

/** A stale lease at a node without its own `recover`: requeue. @param {import('./graphs/task.mjs').TaskCtx} c */
const defaultRecover = (c) => ({ node: 'requeue', input: lostLeaseOf(c) })

/** @param {import('./tick.mjs').StepFn[]} steps @returns {import('./tick.mjs').StepFn} */
const inOrder =
  (...steps) =>
  async (deps, ctx) => {
    for (const step of steps) await step(deps, ctx)
  }

/** @type {import('./tick.mjs').Engine} */
export const GRAPH_ENGINE = {
  reconcile: inOrder(reconcile, DISPATCH_STEPS.reconcile),
  watch: inOrder(watch, trackPromotion, trackBaseHealth),
  sweep: inOrder(sweep, DISPATCH_STEPS.sweep),
  scheduleTasks,
  scheduleDispatch: DISPATCH_STEPS.schedule,
  upkeep,
}

// ---- `cambium run <graph> --issue <n> [--follow]`, `cambium run release-* --repo <slug> [--issue <pr>]`

/** Graphs `cambium run` knows, by name. */
export const GRAPHS = {
  [task.name]: task,
  [prGraph.name]: prGraph,
  [dispatch.name]: dispatch,
  [releasePrepare.name]: releasePrepare,
  [releasePromote.name]: releasePromote,
  [rescue.name]: rescue,
}

/**
 * The graphs for which `--issue` is optional: the release graphs (their subject is the repo's promotion PR), and
 * rescue (without it, a list of what is stuck).
 */
export const REPO_GRAPHS = new Set([releasePrepare.name, releasePromote.name, rescue.name])

export { prGraph }

/**
 * The graph runtime in the foreground for one issue. A `q:task` issue without a lease starts at the entry with a
 * foreground worker, whose exit is awaited; anything else resumes where its marker rests. Stops at the first wait
 * that is not ready, unless `follow`, which re-reads and polls again every `tickSeconds` until the graph ends.
 *
 * The dispatch graph runs the same way from `q:intake` ({@link runDispatch}); the release graphs take the repo,
 * with `number` (optional) naming the promotion PR (graphs/release.mjs `runRelease`).
 *
 * @param {Deps} deps
 * @param {{
 *   graph: string, slug: string, number?: number, follow?: boolean,
 *   out: (line: string) => void, sleep?: (ms: number) => Promise<void>, signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runIssue(deps, { graph, slug, number, follow = false, out, sleep = delay, signal }) {
  if (!Object.hasOwn(GRAPHS, graph))
    return { ok: false, error: `unknown graph "${graph}"; known: ${Object.keys(GRAPHS).join(', ')}` }
  if (graph === rescue.name) return runRescue(deps, { slug, number, out, newCtx })
  if (REPO_GRAPHS.has(graph)) return runRelease(deps, newCtx(deps), { graph, slug, pr: number, out })
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: `the ${graph} graph needs --issue <n>` }
  if (graph === prGraph.name) return runPr(deps, { slug, number, follow, out, sleep, signal })
  if (graph === dispatch.name) return runDispatch(deps, { slug, number, follow, out, sleep, signal })
  /** @type {Set<number>} */
  const reaped = new Set()
  const source = snapshotSource(deps, slug, { follow, sleep, signal })
  let first = true
  for (;;) {
    const ctx = newCtx(deps)
    const snap = await source.read()
    ctx.snaps.set(slug, snap)
    const issue = snap.issues.get(number)
    if (issue?.state !== 'OPEN') {
      if (first) return { ok: false, error: `${slug}#${number} is not an open issue` }
      return report(out, slug, number, issue)
    }
    const worker = deps.store.worker(slug, number)
    const fresh = issue.labels.includes(Q.task) && !issue.labels.includes('running') && !worker
    const located = fresh
      ? { node: task.entry.node, input: {} }
      : worker
        ? { node: 'worker-running', input: { branch: worker.branch, attempt: worker.attempt } }
        : locate(issue, ctx.now)
    if (!located || TERMINAL.has(located.node)) {
      if (first)
        return {
          ok: false,
          error: `${slug}#${number} has nothing to run in the ${graph} graph${
            located ? '' : `; a submitted PR is the pr graph's: cambium run pr --issue ${number}`
          }`,
        }
      return report(out, slug, number, issue)
    }
    if (located.note) await restart(deps, ctx, slug, issue, located.note)
    /** @type {Subject} */
    const subject = { slug, number, snap, issue, foreground: true, reaped }
    const turn = located.note ? null : await drive(deps, ctx, subject, located)
    if (subject.started) {
      const s = subject.started
      out(`worker pid ${s.pid} in ${s.worktree}\n  stdout ${s.stdout}\n  stderr ${s.stderr}`)
      const code = await s.exited
      out(`worker exited ${code}`)
      reaped.add(s.pid)
      first = false
      continue
    }
    if (first && fresh && !follow)
      return { ok: false, error: `${slug}#${number} was not started; see its state comment` }
    first = false
    if (turn?.reason === 'end' || !follow || signal?.aborted) return report(out, slug, number, issue)
    await source.pause()
    if (signal?.aborted) return report(out, slug, number, issue)
  }
}

/**
 * `cambium run pr --issue N [--follow]`: the PR graph for the issue's agent PR, as Watch would run it: one turn
 * when its CI has settled and no Task is queued or running, else a report. `--follow` re-reads every `tickSeconds`
 * until the issue is closed.
 * @param {Deps} deps
 * @param {{ slug: string, number: number, follow: boolean, out: (line: string) => void, sleep: (ms: number) => Promise<void>, signal?: AbortSignal }} o
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function runPr(deps, { slug, number, follow, out, sleep, signal }) {
  const source = snapshotSource(deps, slug, { follow, sleep, signal })
  for (let first = true; ; first = false) {
    const ctx = newCtx(deps)
    const snap = await source.read()
    ctx.snaps.set(slug, snap)
    const issue = snap.issues.get(number)
    const pr = issue ? prFor(snap, { issue: number, branch: issue.stateComment?.marker.branch ?? null }) : null
    if (first && (!issue || !pr)) return { ok: false, error: `${slug}#${number} has no agent PR to assess` }
    if (issue && pr && issue.stateComment) {
      /** @type {Subject} */
      const subject = { slug, number, snap, issue, pr }
      const entry = { node: prGraph.entry.node, input: {} }
      if ((pr.state === 'MERGED' && issue.state === 'OPEN') || assessable(deps, slug, pr, issue)) {
        const turn = await drive(deps, ctx, subject, entry, prGraph)
        out(`PR #${pr.number}: ${turn.transitions.map((t) => String(t.to)).join(' → ') || 'assessed'}`)
      } else out(`PR #${pr.number}: not assessed (CI ${pr.checks ?? 'none'}, ${pr.state.toLowerCase()})`)
    }
    if (!follow || issue?.state !== 'OPEN' || signal?.aborted) return report(out, slug, number, issue)
    await source.pause()
    if (signal?.aborted) return report(out, slug, number, issue)
  }
}

/**
 * `cambium run dispatch --issue N [--follow]`: triage in the foreground. A `q:intake` issue without a lease starts
 * at `start-triage` with a foreground triage worker, whose exit is awaited; then `triaging` reads its verdict and
 * the graph ends (to-task, to-human, closed, or deferred). A tracked triage worker resumes at `triaging`.
 * `--follow` polls every `tickSeconds` until the graph ends (e.g. after a retried triage).
 * @param {Deps} deps
 * @param {{ slug: string, number: number, follow: boolean, out: (line: string) => void, sleep: (ms: number) => Promise<void>, signal?: AbortSignal }} o
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function runDispatch(deps, { slug, number, follow, out, sleep, signal }) {
  /** @type {Set<number>} */
  const reaped = new Set()
  const source = snapshotSource(deps, slug, { follow, sleep, signal })
  for (let first = true; ; first = false) {
    const ctx = newCtx(deps)
    const snap = await source.read()
    ctx.snaps.set(slug, snap)
    const issue = snap.issues.get(number)
    if (issue?.state !== 'OPEN') {
      if (first) return { ok: false, error: `${slug}#${number} is not an open issue` }
      return report(out, slug, number, issue)
    }
    const worker = deps.store.worker(slug, number)
    const fresh = issue.labels.includes(Q.intake) && !issue.labels.includes(RUNNING) && !worker
    const at = fresh
      ? { node: dispatch.entry.node, input: {} }
      : worker?.phase === 'dispatch'
        ? { node: 'triaging', input: { attempt: worker.attempt } }
        : null
    if (!at) {
      if (first)
        return {
          ok: false,
          error: `${slug}#${number} has nothing to run in the dispatch graph (not in ${Q.intake}, or its triage holds a lease with no worker here)`,
        }
      return report(out, slug, number, issue)
    }
    /** @type {Subject} */
    const subject = { slug, number, snap, issue, foreground: true, reaped }
    const turn = await driveDispatch(deps, ctx, subject, at)
    if (subject.started) {
      const s = subject.started
      out(`triage worker pid ${s.pid} in ${s.worktree}\n  stdout ${s.stdout}\n  stderr ${s.stderr}`)
      const code = await s.exited
      out(`triage worker exited ${code}`)
      reaped.add(s.pid)
      continue
    }
    if (first && fresh && !follow)
      return { ok: false, error: `${slug}#${number} was not started; see its state comment` }
    const ended = turn.transitions.some((t) => t.to === END)
    if (ended || !follow || signal?.aborted) return report(out, slug, number, issue)
    await source.pause()
    if (signal?.aborted) return report(out, slug, number, issue)
  }
}

/** How often a follower beside a live daemon looks for the daemon's next snapshot. */
export const FEED_POLL_MS = 2000

/**
 * Where `run … --follow` gets each turn's snapshot. Beside a live daemon (`deps.daemonFeed`: a fresh heartbeat and a
 * usable snapshots file, snapshot-file.mjs) it reads the daemon's snapshot and never GitHub: the first turn takes the
 * latest one, each later turn waits for one the daemon read after this follower's last turn (so it holds that
 * turn's writes). Without a daemon (or once its heartbeat goes stale, its file goes missing, or it has not read the
 * repo for three ticks) it reads GitHub itself every `tickSeconds`, as it always has. A run without `--follow` always
 * reads GitHub.
 * @param {Deps} deps @param {string} slug
 * @param {{ follow: boolean, sleep: (ms: number) => Promise<void>, signal?: AbortSignal }} o
 */
export function snapshotSource(deps, slug, { follow, sleep, signal }) {
  const feed = () => (follow && deps.daemonFeed ? deps.daemonFeed.latest(slug) : { live: false })
  const tickMs = deps.config.tickSeconds * 1000
  let first = true
  return {
    /** @returns {Promise<import('./github.mjs').Snapshot>} */
    async read() {
      // This follower's last turn has ended: a daemon snapshot must have been read after it.
      const since = first ? -Infinity : deps.clock.now()
      first = false
      for (let waited = 0; waited <= 3 * tickMs && !signal?.aborted; waited += FEED_POLL_MS) {
        const f = feed()
        if (!f.live) break
        if (f.snap && f.fetchedAt > since) return f.snap
        await sleep(FEED_POLL_MS)
      }
      return deps.github.read(slug)
    },
    /** Between turns: with a live daemon, {@link read} does the waiting. */
    async pause() {
      if (!feed().live) await sleep(tickMs)
    },
  }
}

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {(line: string) => void} out @param {string} slug @param {number} n
 * @param {import('./github.mjs').Issue | undefined} issue
 */
function report(out, slug, n, issue) {
  const m = issue?.state === 'OPEN' ? issue.stateComment?.marker : null
  const where = m ? `${m.node}${m.status === 'waiting' ? '' : ` (${m.status})`}` : 'closed'
  out(`${slug}#${n}: ${where} · labels ${issue?.labels.join(', ') || '(none)'}`)
  return { ok: true }
}
