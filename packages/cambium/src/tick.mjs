// @ts-check
/**
 * One tick: Read → Reconcile → Watch → Sweep → Schedule → Release → GC →
 * Heartbeat. Every collaborator is injected ({@link Deps}); the daemon is a
 * loop around this function. Each step is bounded by `stepTimeoutSeconds`; a
 * step that throws or times out is recorded and the tick moves on. Nothing
 * here waits on a worker.
 */
import { capsFor } from './config.mjs'
import { watchStates, watchWorkflows } from './watch.mjs'
import { stallStates, watchStalls } from './merge-stall.mjs'
import { stallState } from './stall.mjs'
import { byPriorityThenAge, move, Q, queueOf, RUNNING, WHY } from './labels.mjs'
import { withHistory } from './marker.mjs'
import { failureSummary, iso, key, markerOf, MIN, setLabels, setMarker } from './issue-state.mjs'
import { GRAPH_ENGINE, GRAPHS } from './graph-engine.mjs'
import { describeGraph } from './graph/describe.mjs'
import { linkIssue, prFor, taskExit, taskPrompt } from './phases/task.mjs'
import { adopt } from './adopt.mjs'
import { branchName } from './convention.mjs'
import { PREPARE_FAILED_LINE } from './prepare.mjs'
import { releaseDue, releaseNotBuilt } from './phases/release.mjs'
import { decide } from './graphs/decide.mjs'
import { releaseGraphs } from './graphs/release.mjs'
import { DISPATCH_NOT_BUILT, dispatchNotBuilt } from './phases/dispatch.mjs'
import { isRepair } from './base-health.mjs'
import { stopOverdue } from './workers.mjs'
import { syncBriefs } from './briefs.mjs'
import { queueView } from './queue-view.mjs'
import { snapshotsFile } from './snapshot-file.mjs'
import { costDays, costOf, dayOf, overBudget, recordCost } from './cost.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {import('./store.mjs').Worker} Worker
 * @typedef {{ at: string, level: 'info' | 'warn' | 'error', msg: string, repo?: string, issue?: number }} Event
 * @typedef {{
 *   config: import('./config.mjs').Config,
 *   clock: { now(): number },
 *   github: import('./github.mjs').GitHub,
 *   store: import('./store.mjs').Store,
 *   spawner: import('./workers.mjs').Spawner,
 *   procs: import('./workers.mjs').Procs,
 *   log: (level: Event['level'], msg: string, where?: { repo?: string, issue?: number }) => void,
 *   events?: () => Event[],
 *   heartbeat?: (state: HeartbeatState) => void | Promise<void>,
 *   queues?: { write(view: import('./queue-view.mjs').QueuesFile): void | Promise<void>,
 *     prev?(): import('./queue-view.mjs').QueuesFile | null },
 *   snapshots?: { write(file: import('./snapshot-file.mjs').SnapshotsFile): void | Promise<void> },
 *   daemonFeed?: { latest(slug: string): import('./snapshot-file.mjs').Feed },
 *   dispatch?: import('./phases/dispatch.mjs').Dispatch,
 *   release?: import('./phases/release.mjs').Release,
 *   tickNumber?: number,
 *   telemetry?: import('./tracing.mjs').Telemetry,
 *   updater?: import('./update.mjs').Updater,
 *   gc?: () => Promise<unknown>,
 *   briefs?: { dir: string, fs?: import('./briefs.mjs').BriefFs },
 *   daemonStartedAt?: number,
 *   pid?: number,
 * }} Deps
 *   `queues`: writes the queue view canopy reads (queue-view.mjs); `prev` is the last one written, whose boards a repo
 *   not read this tick keeps. `snapshots`: writes each repo's full snapshot (snapshot-file.mjs), for followers.
 *   `daemonFeed`: a follower's view of a live daemon's snapshots (graph-engine.mjs `runIssue`); the tick ignores it.
 * @typedef {{ name: string, ok: boolean, ms: number, error: string | null }} StepResult
 * @typedef {{
 *   now: number, mode: import('./store.mjs').Mode, snaps: Map<string, Snapshot>,
 *   readErrors: Map<string, string>, touched: Set<string>, steps: StepResult[], reads: Map<string, ReadKind>,
 * }} Ctx
 *   `reads`: per repo read this tick, whether it probed and reused the last snapshot or read it in full.
 */

/**
 * @typedef {(deps: Deps, ctx: Ctx) => Promise<void>} StepFn
 * @typedef {{ reconcile: StepFn, watch: StepFn, sweep: StepFn, scheduleTasks: StepFn, scheduleDispatch?: StepFn, upkeep?: StepFn }} Engine
 *   The Task-phase steps. `config.engine` picks the legacy stage tick (this file) or the `task` graph
 *   (graph-engine.mjs). The graph engine also folds the Dispatch phase into reconcile and sweep and brings its own
 *   `scheduleDispatch` (without one, the dispatch stub runs). Read and Heartbeat are shared.
 */

/** @param {Deps} deps @returns {Ctx} */
export function newCtx(deps) {
  return {
    now: deps.clock.now(),
    mode: deps.store.mode(),
    snaps: new Map(),
    readErrors: new Map(),
    reads: new Map(),
    touched: new Set(),
    steps: [],
  }
}

/**
 * @param {Deps} deps
 * @returns {Promise<HeartbeatState>}
 */
export async function tick(deps) {
  const ctx = newCtx(deps)
  const paused = ctx.mode === 'paused'
  const engine = engineOf(deps)
  /** @type {StepFn} */
  const schedule = async (d, c) => {
    await engine.scheduleTasks(d, c)
    await (engine.scheduleDispatch ?? scheduleDispatch)(d, c)
  }
  /** @type {[string, StepFn][]} */
  const steps = [
    ['read', read],
    ...(paused
      ? []
      : /** @type {[string, StepFn][]} */ ([
          ['reconcile', engine.reconcile],
          ['watch', engine.watch],
          ['sweep', engine.sweep],
          ['adopt', adopt],
        ])),
    ...(ctx.mode === 'running' ? /** @type {[string, StepFn][]} */ ([['schedule', schedule]]) : []),
    ...(paused ? [] : /** @type {[string, any][]} */ ([['release', release]])),
    ...(paused ? [] : /** @type {[string, StepFn][]} */ ([['workflows', watchWorkflows]])),
    ...(paused ? [] : /** @type {[string, StepFn][]} */ ([['stalls', watchStalls]])),
    ...(paused || !engine.upkeep ? [] : /** @type {[string, StepFn][]} */ ([['upkeep', engine.upkeep]])),
    ...(paused || !deps.gc ? [] : /** @type {[string, StepFn][]} */ ([['gc', gc]])),
    ...(deps.briefs ? /** @type {[string, StepFn][]} */ ([['briefs', briefs]]) : []),
  ]
  for (const [name, fn] of steps) await runStep(deps, ctx, name, () => fn(deps, ctx))
  if (deps.queues) await runStep(deps, ctx, 'queues', () => writeQueueView(deps, ctx))
  if (deps.snapshots) await runStep(deps, ctx, 'snapshots', () => writeSnapshotsFile(deps, ctx))
  const state = heartbeatState(deps, ctx)
  if (deps.heartbeat) await runStep(deps, ctx, 'heartbeat', async () => deps.heartbeat?.(state))
  return state
}

/** @type {Engine} */
const LEGACY = { reconcile, watch, sweep, scheduleTasks, upkeep: async () => {} }

/** @param {Deps} deps @returns {Engine} */
export const engineOf = (deps) => (deps.config.engine === 'graph' ? GRAPH_ENGINE : LEGACY)

/**
 * @param {Deps} deps @param {Ctx} ctx @param {string} name @param {() => Promise<void>} fn
 */
async function runStep(deps, ctx, name, fn) {
  const t0 = performance.now()
  const limit = deps.config.stepTimeoutSeconds * 1000
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step exceeded ${deps.config.stepTimeoutSeconds}s`)), limit)
      }),
    ])
    ctx.steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), error: null })
  } catch (err) {
    const error = /** @type {Error} */ (err)?.message ?? String(err)
    ctx.steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), error })
    deps.log('error', `${name}: ${error}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run each item's work on its own: one failure is logged, the rest still run.
 *
 * @template T
 * @param {Deps} deps @param {T[]} items @param {(item: T) => Promise<void>} fn
 * @param {(item: T) => { repo?: string, issue?: number }} where
 */
export async function each(deps, items, fn, where) {
  for (const item of items) {
    try {
      await fn(item)
    } catch (err) {
      deps.log('error', /** @type {Error} */ (err)?.message ?? String(err), where(item))
    }
  }
}

/** The first retry of a worker row whose reconcile failed waits this long; each further failure doubles it. */
export const RETRY_BASE_MS = MIN
/** The longest wait between retries of a failing worker row. */
export const RETRY_MAX_MS = 60 * MIN

/**
 * {@link each} over worker rows, with a backoff: a row whose reconcile throws (a GitHub write refused, say) keeps
 * its row, so the next tick would redo the same failing transition. Instead the failure is counted on the row and
 * the row is skipped until its `retryAt`: 1 minute, then doubling up to an hour. A new worker for the issue gets a
 * fresh row, and so a fresh count.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {Worker[]} workers @param {(w: Worker) => Promise<void>} fn
 */
export async function eachWorker(deps, ctx, workers, fn) {
  for (const w of workers) {
    if (w.retryAt != null && w.retryAt > ctx.now) continue
    try {
      await fn(w)
    } catch (err) {
      const msg = /** @type {Error} */ (err)?.message ?? String(err)
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** w.failures)
      const failures = deps.store.noteFailure(w.repo, w.issue, ctx.now + delay)
      deps.log('error', `${msg} (failure ${failures}; retried in ${Math.round(delay / MIN)}m)`, {
        repo: w.repo,
        issue: w.issue,
      })
    }
  }
}

// ---- Read

/**
 * @typedef {'first' | 'config' | 'due' | 'pending' | 'changed' | 'probe-failed' | 'always'} FullReadWhy
 *   Why a repo was read in full: no snapshot yet; its config changed; `fullReadEvery` reached; an open PR's
 *   checks, merge queue or `mergeable` are still settling (none bumps `updatedAt`); the probe differs; the probe
 *   failed; no probe at all (`fullReadEvery` 1, or a GitHub without one).
 * @typedef {{ kind: 'probe', why: null } | { kind: 'full', why: FullReadWhy }} ReadKind
 * @typedef {{ snap: Snapshot, probe: import('./github.mjs').Probe, key: string, reused: number }} CachedRead
 *   `reused`: ticks the snapshot has been reused since it was read. `key`: the config it was read under.
 */

/** The last full read per repo, per daemon (its `deps`): tick to tick, never persisted. @type {WeakMap<Deps, Map<string, CachedRead>>} */
const READS = new WeakMap()

/** @param {Deps} deps */
const readsOf = (deps) => {
  const m = READS.get(deps) ?? new Map()
  READS.set(deps, m)
  return m
}

/** What the snapshot read depends on in the config: a change reads afresh. @param {Deps} deps @param {string} slug */
const readKey = (deps, slug) =>
  JSON.stringify([deps.config.repos.find((r) => r.slug === slug), deps.config.intake, deps.config.graft.botLogin])

/**
 * An open PR whose state may change with no `updatedAt` to show it: checks running, in the merge queue, or
 * `mergeable` still being computed.
 * @param {Snapshot} snap
 */
export const settling = (snap) =>
  snap.prs.some(
    (p) =>
      p.state === 'OPEN' &&
      (p.checks === 'PENDING' || p.checks === 'EXPECTED' || p.inMergeQueue || p.mergeable === 'UNKNOWN'),
  )

/**
 * Whether the repo must be read in full this tick, before probing: the reason, or null (the probe decides).
 * @param {CachedRead | undefined} cached @param {string} key @param {number} every
 * @returns {FullReadWhy | null}
 */
export function fullReadDue(cached, key, every) {
  if (!cached) return 'first'
  if (cached.key !== key) return 'config'
  if (cached.reused + 1 >= every) return 'due'
  if (settling(cached.snap)) return 'pending'
  return null
}

/** @param {import('./github.mjs').Probe} a @param {import('./github.mjs').Probe} b */
const sameProbe = (a, b) =>
  a.issuesAt === b.issuesAt && a.prsAt === b.prsAt && JSON.stringify(a.heads) === JSON.stringify(b.heads)

/**
 * One repo's snapshot. With a probe (`github.probe`, `fullReadEvery` > 1): probe first, then reuse the last full
 * read when nothing it reads has changed ({@link fullReadDue}). The probe runs before a full read too, so the
 * snapshot is never older than the probe it is compared by: a change between the two only costs a read.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @returns {Promise<Snapshot>}
 */
export async function readRepo(deps, ctx, slug) {
  const every = deps.config.fullReadEvery ?? 1
  const cache = readsOf(deps)
  const full = async (/** @type {FullReadWhy} */ why, /** @type {import('./github.mjs').Probe | null} */ probe) => {
    cache.delete(slug)
    const snap = await deps.github.read(slug)
    if (probe) cache.set(slug, { snap: structuredClone(snap), probe, key: readKey(deps, slug), reused: 0 })
    ctx.reads.set(slug, { kind: 'full', why })
    return snap
  }
  if (!deps.github.probe || every <= 1) return full('always', null)
  const cached = cache.get(slug)
  const key = readKey(deps, slug)
  /** @type {import('./github.mjs').Probe} */
  let probe
  try {
    probe = await deps.github.probe(slug)
  } catch (err) {
    deps.log('warn', `probe: ${/** @type {Error} */ (err)?.message ?? err}; reading in full`, { repo: slug })
    return full('probe-failed', null)
  }
  const due = fullReadDue(cached, key, every)
  if (due) return full(due, probe)
  const was = /** @type {CachedRead} */ (cached)
  if (!sameProbe(was.probe, probe)) return full('changed', probe)
  was.reused++
  ctx.reads.set(slug, { kind: 'probe', why: null })
  // The budget now, at the full read's cost: the pause below still allows for the next full read.
  const rl = probe.rateLimit
  const rateLimit = rl
    ? { ...rl, cost: Math.max(rl.cost, was.snap.rateLimit?.cost ?? 0) }
    : (was.snap.rateLimit ?? null)
  const snap = { ...structuredClone(was.snap), rateLimit }
  // Not read this tick: a release part reused waits for the next read, as a kept one does (github.mjs).
  if (snap.release) snap.release.fresh = false
  return snap
}

/** @param {Deps} deps @param {Ctx} ctx */
async function read(deps, ctx) {
  let skipped = 0
  for (const repo of deps.config.repos) {
    const where = { repo: repo.slug }
    const pausedKey = `ratelimit.until:${repo.slug}`
    const until = Number(deps.store.get(pausedKey) ?? 0)
    if (ctx.now < until) {
      ctx.readErrors.set(repo.slug, `GraphQL budget spent; reads paused until ${iso(until)}`)
      skipped++
      continue
    }
    const pause = (/** @type {number} */ at, /** @type {string} */ why) => {
      deps.store.set(pausedKey, String(at))
      deps.log('warn', `${why}; reads paused until ${iso(at)}`, where)
    }
    try {
      const snap = await readRepo(deps, ctx, repo.slug)
      ctx.snaps.set(repo.slug, snap)
      // Stop one read short of the wall: the budget left must cover this read and a margin for workers' calls.
      const rl = snap.rateLimit
      const resetAt = Date.parse(rl?.resetAt ?? '')
      if (rl && resetAt > ctx.now && rl.remaining < rl.cost * RATE_LIMIT_MARGIN)
        pause(resetAt, `GraphQL budget nearly spent (${rl.remaining} left, ${rl.cost} a read)`)
    } catch (err) {
      const msg = /** @type {Error} */ (err)?.message ?? String(err)
      ctx.readErrors.set(repo.slug, msg)
      deps.log('error', `read: ${msg}`, where)
      if (/RATE_LIMIT|rate limited/.test(msg)) {
        const at = Date.parse(msg.match(/rate limited until (\S+Z)/)?.[1] ?? '')
        pause(at > ctx.now ? at : ctx.now + RATE_LIMIT_FALLBACK_MINUTES * MIN, 'GraphQL rate limited')
      }
    }
  }
  const failed = ctx.readErrors.size - skipped
  if (failed > 0 && failed === deps.config.repos.length - skipped) throw new Error(`no repository could be read`)
}

/** Reads pause while the GraphQL budget left is under this many reads' worth. */
export const RATE_LIMIT_MARGIN = 5
/** How long reads pause after a rate-limit error that does not say when the budget resets. */
export const RATE_LIMIT_FALLBACK_MINUTES = 10

/**
 * Into the Human Queue with a reason label. The marker is written before the
 * labels: a half-applied transition is then re-done (and over-counted) on the
 * next tick, never under-counted.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue
 * @param {{ reason: string, outcome: string, pr?: number, log?: string, failedSha?: string | null, why?: string }} what
 */
export async function toHuman(deps, ctx, slug, issue, { reason, outcome, pr, log, failedSha, why = WHY.budget }) {
  const m = markerOf(issue)
  const marker = {
    ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome, reason, pr, log }),
    stage: /** @type {const} */ ('human'),
    lastFailure: reason,
    host: null,
    start: null,
    ...(failedSha !== undefined ? { failedSha } : {}),
  }
  await setMarker(deps, slug, issue, marker)
  await setLabels(deps, slug, issue, move(issue.labels, Q.human, { extra: [why] }))
  ctx.touched.add(key(slug, issue.number))
  deps.log('warn', `→ q:human (${why}): ${reason.split('\n')[0]}`, { repo: slug, issue: issue.number })
}

/**
 * Back to `q:task` with attempt + 1, or to the Human Queue (`why:budget`)
 * when the attempts are spent.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue
 * @param {{ reason: string, outcome: string, pr?: number, log?: string, failedSha?: string | null }} what
 */
export async function requeue(deps, ctx, slug, issue, what) {
  const m = markerOf(issue)
  const max = deps.config.phases.task.maxAttempts
  if (m.attempt >= max)
    return toHuman(deps, ctx, slug, issue, {
      ...what,
      reason: `${max} attempts spent. Last: ${what.reason}`,
    })
  const { reason, outcome, pr, log, failedSha } = what
  const marker = {
    ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome, reason, pr, log }),
    stage: /** @type {const} */ ('queued'),
    attempt: m.attempt + 1,
    lastFailure: reason,
    host: null,
    start: null,
    ...(failedSha !== undefined ? { failedSha } : {}),
  }
  await setMarker(deps, slug, issue, marker)
  await setLabels(deps, slug, issue, move(issue.labels, Q.task))
  ctx.touched.add(key(slug, issue.number))
  deps.log('info', `requeued (attempt ${marker.attempt}/${max}): ${reason.split('\n')[0]}`, {
    repo: slug,
    issue: issue.number,
  })
}

// ---- Reconcile

/**
 * A triage or rescue worker (phase `dispatch` or `rescue`, started by the graph engine before a switch to `legacy`)
 * is only held to its wall-clock cap: its row stays, so its `running` lease is not swept, and the graph engine reads its verdict once
 * switched back. Legacy never finishes it as a Task.
 * @param {Deps} deps @param {Ctx} ctx
 */
async function reconcile(deps, ctx) {
  const { config, store, procs } = deps
  await eachWorker(deps, ctx, store.workers(), async (w) => {
    const caps = capsFor(config, w.repo, w.phase)
    if (stopOverdue({ procs, store, log: deps.log }, w, caps.wallClockMinutes, ctx.now) !== 'gone') return
    if (w.phase === 'dispatch' || w.phase === 'rescue') return
    const snap = ctx.snaps.get(w.repo)
    if (snap) await finish(deps, ctx, w, snap)
  })
}

/**
 * A worker whose process is gone: run the exit check and make the transition.
 * The row is removed only after GitHub took the writes, so a failed write is
 * retried next tick.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {Worker} w @param {Snapshot} snap
 */
export async function finish(deps, ctx, w, snap) {
  const repo = deps.config.repos.find((r) => r.slug === w.repo)
  const issue = snap.issues.get(w.issue)
  const pr = prFor(snap, w)
  const done = async () => {
    deps.store.removeWorker(w.repo, w.issue)
    if (!repo) return
    const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch })
    if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: w.repo, issue: w.issue })
  }
  await recordCost(deps, issue, w, ctx.now)
  if (issue?.state !== 'OPEN') {
    deps.log('info', 'worker gone; issue is closed or no longer queued', { repo: w.repo, issue: w.issue })
    return done()
  }
  const m = markerOf(issue)
  const prepFailed = !w.killedReason && deps.spawner.tail(w.stderr, 15).includes(PREPARE_FAILED_LINE)
  const verdict = w.killedReason
    ? { ok: false, reason: w.killedReason }
    : prepFailed
      ? { ok: false, reason: 'could not start the worker: prepare failed' }
      : taskExit(pr, m)
  if (verdict.ok && pr) {
    const marker = {
      ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome: 'submitted', pr: pr.number, log: w.stdout }),
      stage: /** @type {const} */ ('submitted'),
      pr: pr.number,
      branch: pr.branch,
      submittedAt: iso(ctx.now),
      queued: false,
      lastFailure: null,
    }
    await setMarker(deps, w.repo, issue, marker)
    await setLabels(deps, w.repo, issue, move(issue.labels, null))
    ctx.touched.add(key(w.repo, w.issue))
    deps.log('info', `submitted PR #${pr.number}; watching CI`, { repo: w.repo, issue: w.issue })
    await linkIssue(deps, w.repo, pr, w.issue)
  } else {
    const tail = deps.spawner.tail(w.stderr, 15)
    const reason = `${'reason' in verdict ? verdict.reason : 'worker failed'}${tail ? `\n--- stderr (last lines, ${w.stderr})\n${tail}` : ''}`
    await requeue(deps, ctx, w.repo, issue, {
      reason,
      outcome: w.killedReason ? 'killed' : prepFailed ? 'spawn-failed' : 'failed',
      pr: pr?.number,
      log: w.stdout,
    })
  }
  await done()
}

// ---- Watch (no agent)

/** @param {Deps} deps @param {Ctx} ctx */
async function watch(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    const deleted = new Set()
    await each(
      deps,
      watchPairs(snap),
      async ([pr, issue]) => {
        if (ctx.touched.has(key(slug, issue.number))) return
        const m = markerOf(issue)
        if (pr.state === 'MERGED') {
          if (issue.state === 'OPEN') {
            const marker = {
              ...withHistory(m, { at: iso(ctx.now), attempt: m.attempt, outcome: 'merged', pr: pr.number }),
              stage: /** @type {const} */ ('done'),
            }
            await setMarker(deps, slug, issue, marker)
            await setLabels(deps, slug, issue, move(issue.labels, null))
            await deps.github.close(slug, issue.number, `Merged in #${pr.number}. Closed by cambium.`)
            issue.state = 'CLOSED'
            ctx.touched.add(key(slug, issue.number))
            deps.log('info', `PR #${pr.number} merged; closed`, { repo: slug, issue: issue.number })
          }
          if (pr.branchExists && !deleted.has(pr.branch)) {
            deleted.add(pr.branch)
            await deps.github.deleteBranch(slug, pr.branch)
          }
          return
        }
        if (pr.state !== 'OPEN' || issue.state !== 'OPEN') return
        if (!watched(deps, slug, issue)) return
        if ((pr.checks === 'FAILURE' || pr.checks === 'ERROR') && pr.headSha !== m.failedSha)
          return requeue(deps, ctx, slug, issue, {
            reason: failureSummary(pr),
            outcome: 'ci-red',
            pr: pr.number,
            failedSha: pr.headSha,
          })
        // `submitted` too: an issue whose queue label was removed by hand is still at its old stage (#38).
        if (pr.inMergeQueue && !m.queued) await setMarker(deps, slug, issue, { ...m, stage: 'submitted', queued: true })
        const settled = pr.checks !== 'PENDING' && pr.checks !== 'EXPECTED'
        if (m.queued && !pr.inMergeQueue && !pr.autoMerge && settled)
          return requeue(deps, ctx, slug, issue, {
            reason: `PR #${pr.number} left the merge queue without merging`,
            outcome: 'dequeued',
            pr: pr.number,
          })
        const cap = deps.config.mergeQueueMinutes
        if (m.submittedAt && ctx.now - Date.parse(m.submittedAt) > cap * MIN)
          return toHuman(deps, ctx, slug, issue, {
            reason: `PR #${pr.number} not merged within ${cap} min of submission`,
            outcome: 'stalled',
            pr: pr.number,
          })
      },
      ([, issue]) => ({ repo: slug, issue: issue.number }),
    )
  }
}

/**
 * Watch's work list: every (PR, issue it closes) pair where cambium already owns the issue's state comment.
 * @param {Snapshot} snap
 */
export function watchPairs(snap) {
  /** @type {[import('./github.mjs').PullRequest, Issue][]} */
  const pairs = []
  for (const pr of snap.prs)
    for (const n of pr.closes) {
      const issue = snap.issues.get(n)
      if (issue?.stateComment) pairs.push([pr, issue])
    }
  return pairs
}

/**
 * Watch acts on an open PR only while its issue is in no queue, holds no lease and has no tracked worker.
 * @param {Deps} deps @param {string} slug @param {Issue} issue
 */
export const watched = (deps, slug, issue) =>
  !(queueOf(issue.labels) || issue.labels.includes(RUNNING) || deps.store.worker(slug, issue.number))

// ---- Sweep: stale leases (a `running` label on this host with no tracked worker)

/**
 * A stale lease on a `q:intake` issue is a lost triage (the graph engine's): legacy leaves it to the dispatch
 * graph's sweep rather than requeue it as a Task.
 * @param {Deps} deps @param {Ctx} ctx
 */
async function sweep(deps, ctx) {
  for (const [slug, snap] of ctx.snaps)
    await each(
      deps,
      staleLeases(deps, ctx, slug, snap).filter((issue) => !issue.labels.includes(Q.intake)),
      (issue) => requeue(deps, ctx, slug, issue, lostLease(deps)),
      (issue) => ({ repo: slug, issue: issue.number }),
    )
}

/**
 * Open issues labelled `running` on this host (or no host) with no tracked worker, untouched this tick.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Snapshot} snap
 */
export function staleLeases(deps, ctx, slug, snap) {
  return [...snap.issues.values()].filter((issue) => {
    if (issue.state !== 'OPEN' || !issue.labels.includes(RUNNING)) return false
    if (ctx.touched.has(key(slug, issue.number)) || deps.store.worker(slug, issue.number)) return false
    const host = issue.stateComment?.marker.host
    return !host || host === deps.config.host
  })
}

/** @param {Deps} deps */
export const lostLease = (deps) => ({
  reason: `worker lost: \`running\` on ${deps.config.host} with no live process`,
  outcome: 'lost',
})

// ---- Schedule

/** @param {Deps} deps @param {Ctx} ctx */
async function scheduleTasks(deps, ctx) {
  await each(
    deps,
    taskCandidates(deps, ctx),
    async (c) => {
      await startTask(deps, ctx, c.slug, c.issue, c.snap)
    },
    (c) => ({ repo: c.slug, issue: c.issue.number }),
  )
}

/**
 * The `q:task` issues to start this tick: no `running`, no tracked worker, by priority then age, up to the free
 * slots counted from live task workers.
 *
 * The base's health gates it (base-health.mjs): a repo whose base is red starts only its repair issue, which
 * takes no slot (it is what frees the others); a repair issue on a green base is left for `trackBaseHealth` to
 * close.
 * @param {Deps} deps @param {Ctx} ctx
 */
export function taskCandidates(deps, ctx) {
  const { config, store } = deps
  const free = config.phases.task.cap - store.workers().filter((w) => w.phase === 'task').length
  /** @type {{ slug: string, issue: Issue, snap: Snapshot }[]} */
  const candidates = []
  /** @type {{ slug: string, issue: Issue, snap: Snapshot }[]} */
  const repairs = []
  for (const [slug, snap] of ctx.snaps) {
    const health = snap.base?.state ?? 'unknown'
    for (const issue of snap.issues.values()) {
      if (
        issue.state !== 'OPEN' ||
        !issue.labels.includes(Q.task) ||
        issue.labels.includes(RUNNING) ||
        store.worker(slug, issue.number)
      )
        continue
      if (isRepair(issue)) {
        if (health !== 'green') repairs.push({ slug, issue, snap })
      } else if (health !== 'red') candidates.push({ slug, issue, snap })
    }
  }
  const order = byPriorityThenAge(config.priorityLabels)
  candidates.sort((a, b) => order(a.issue, b.issue))
  repairs.sort((a, b) => order(a.issue, b.issue))
  return [...repairs, ...candidates.slice(0, Math.max(0, free))]
}

/** @param {Deps} deps @param {Ctx} ctx */
async function scheduleDispatch(deps, ctx) {
  const { config } = deps
  const dispatchCap = config.phases.dispatch.cap
  if (dispatchCap > 0) {
    const dispatch = deps.dispatch ?? dispatchNotBuilt
    for (const [slug, snap] of ctx.snaps) {
      const intake = [...snap.issues.values()].filter((i) => i.state === 'OPEN' && i.labels.includes(Q.intake))
      if (!intake.length) continue
      intake.sort(byPriorityThenAge([]))
      const { started } = await dispatch({ repo: slug, intake, capacity: dispatchCap, now: ctx.now })
      if (!started.length && !deps.dispatch) deps.log('info', DISPATCH_NOT_BUILT, { repo: slug })
    }
  }
}

/**
 * Claim an issue and start its Task worker: marker, then `running`, then the
 * process. A crash between the claim and the spawn leaves a stale lease that
 * the next sweep requeues.
 *
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue @param {Snapshot} snap
 * @param {{ foreground?: boolean }} [opts]
 * @returns {Promise<(import('./workers.mjs').Started & { attempt: number }) | null>}
 */
export async function startTask(deps, ctx, slug, issue, snap, { foreground = false } = {}) {
  const { config } = deps
  const repo = config.repos.find((r) => r.slug === slug)
  if (!repo) throw new Error(`${slug} is not in the config`)
  const caps = capsFor(config, slug, 'task')
  const m0 = markerOf(issue)
  if (m0.attempt > caps.maxAttempts) {
    await toHuman(deps, ctx, slug, issue, { reason: `${caps.maxAttempts} attempts spent`, outcome: 'budget' })
    return null
  }
  /** @type {import('./convention.mjs').Convention} */
  let convention
  try {
    convention = deps.spawner.convention(repo)
  } catch (err) {
    await requeue(deps, ctx, slug, issue, {
      reason: `could not start the worker: ${/** @type {Error} */ (err)?.message ?? err}`,
      outcome: 'spawn-failed',
    })
    return null
  }
  const known = prFor(snap, { issue: issue.number, branch: m0.branch })
  const pr = known?.state === 'OPEN' ? known : null
  // Sticky: a retry keeps the branch (and so the worktree topic) its first attempt chose.
  const branch = pr?.branch ?? m0.branch ?? branchName(convention.branch, issue.number, issue.title)
  const marker = {
    ...m0,
    phase: /** @type {const} */ ('task'),
    stage: /** @type {const} */ ('running'),
    host: config.host,
    start: iso(ctx.now),
    branch,
    pr: pr?.number ?? m0.pr ?? null,
  }
  await setMarker(deps, slug, issue, marker)
  await setLabels(deps, slug, issue, move(issue.labels, Q.task, { running: true }))
  ctx.touched.add(key(slug, issue.number))

  let started
  try {
    started = await deps.spawner.start({
      repo,
      convention,
      issue: issue.number,
      attempt: marker.attempt,
      branch,
      phase: 'task',
      maxTurns: caps.maxTurns,
      foreground,
      buildPrompt: (agentsMd) =>
        taskPrompt({
          repo: slug,
          issue,
          marker,
          branch,
          pr,
          agentsMd,
          maxAttempts: caps.maxAttempts,
          merge: repo.merge,
        }),
    })
  } catch (err) {
    await requeue(deps, ctx, slug, issue, {
      reason: `could not start the worker: ${/** @type {Error} */ (err)?.message ?? err}`,
      outcome: 'spawn-failed',
    })
    return null
  }
  deps.store.addWorker({
    repo: slug,
    issue: issue.number,
    phase: 'task',
    pid: started.pid,
    worktree: started.worktree,
    branch,
    attempt: marker.attempt,
    startedAt: ctx.now,
    host: config.host,
    stdout: started.stdout,
    stderr: started.stderr,
  })
  if (started.reused)
    deps.log('warn', `continuing in the previous worktree ${started.worktree}: ${started.reused}`, {
      repo: slug,
      issue: issue.number,
    })
  deps.log('info', `started task worker pid ${started.pid} (attempt ${marker.attempt}, ${branch})`, {
    repo: slug,
    issue: issue.number,
  })
  return { ...started, attempt: marker.attempt }
}

// ---- GC

/**
 * Start a worktree sweep (gc.mjs) every `gc.everyMinutes`; 0 switches it off. Not awaited: a sweep asks
 * GitHub about each worktree and can outlast the step.
 *
 * @param {Deps} deps @param {Ctx} ctx
 */
async function gc(deps, ctx) {
  const every = deps.config.gc.everyMinutes
  const last = Number(deps.store.get('gc.lastRun') ?? 0)
  if (!every || ctx.now - last < every * MIN) return
  deps.store.set('gc.lastRun', String(ctx.now))
  void deps.gc?.()
}

// ---- Release (no agent). Legacy: once a day, the run is a seam. Graph: the release-prepare / release-promote
// graphs (graphs/release.mjs), per repo.

/** @param {Deps} deps @param {Ctx} ctx */
async function release(deps, ctx) {
  if (deps.config.engine === 'graph') return releaseGraphs(deps, ctx)
  const { config, store } = deps
  if (!config.release.enabled) return
  const last = store.get('release.lastRun')
  if (!releaseDue(ctx.now, last === null ? null : Number(last), config.release.time)) return
  store.set('release.lastRun', String(ctx.now))
  for (const repo of config.repos) {
    const result = await (deps.release ?? releaseNotBuilt)({ repo, now: ctx.now })
    deps.log('info', `release: ${result.note}`, { repo: repo.slug })
  }
}

// ---- Heartbeat

/**
 * @typedef {{ intake: number, task: number, human: number, promote: number, running: number, review: number }} Counts
 * @typedef {{
 *   version: 1,
 *   host: string,
 *   pid: number,
 *   mode: import('./store.mjs').Mode,
 *   daemon: { startedAt: string | null, tickSeconds: number },
 *   tick: { n: number, startedAt: string, finishedAt: string, durationMs: number, nextAt: string },
 *   steps: StepResult[],
 *   counts: Counts & { workers: number },
 *   caps: { task: number, dispatch: number },
 *   repos: {
 *     slug: string, ok: boolean, error: string | null, read: ReadKind | null, counts: Counts | null,
 *     base: import('./base-health.mjs').BaseHealth | null,
 *     watch: import('./watch.mjs').WatchState[],
 *     stalls: import('./merge-stall.mjs').Stall[],
 *     stall: import('./stall.mjs').StallState,
 *     rateLimit: { cost: number, remaining: number, resetAt: string } | null,
 *     cost: { issues: IssueCost[], days: import('./cost.mjs').CostDay[] },
 *   }[],
 *   workers: {
 *     repo: string, issue: number, phase: string, pid: number, alive: boolean, attempt: number, branch: string,
 *     worktree: string, startedAt: string, elapsedMs: number, wallClockMs: number, killedReason: string | null,
 *     logs: { stdout: string, stderr: string },
 *   }[],
 *   events: Event[],
 *   engine: 'legacy' | 'graph',
 *   graphs: import('./graph/describe.mjs').GraphDescription[],
 *   costFlagUsd: number,
 * }} HeartbeatState
 * @typedef {{
 *   number: number, title: string, url: string, labels: string[], cost: import('./cost.mjs').Cost, flagged: boolean,
 * }} IssueCost
 *   An active (`q:intake`, `q:task`, `running`) or `q:human` issue that has cost something. `flagged`: its task
 *   spend is over `costFlagUsd` and it has no merged PR (cost.mjs `overBudget`).
 */

/** Days of the per-repo cost ledger the heartbeat carries, today included. */
export const COST_DAYS = 14

/**
 * The repo's issues worth a cost line, most expensive first.
 * @param {Snapshot} snap @param {number} flagUsd @returns {IssueCost[]}
 */
export function issueCosts(snap, flagUsd) {
  /** @type {IssueCost[]} */
  const out = []
  for (const issue of snap.issues.values()) {
    if (issue.state !== 'OPEN') continue
    const q = queueOf(issue.labels)
    if (q !== Q.intake && q !== Q.task && q !== Q.human && !issue.labels.includes(RUNNING)) continue
    const marker = issue.stateComment?.marker
    const cost = costOf(marker)
    if (!cost.total.runs) continue
    const merged = snap.prs.some(
      (p) =>
        p.state === 'MERGED' && (p.closes.includes(issue.number) || (marker?.pr != null && p.number === marker.pr)),
    )
    out.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      cost,
      flagged: overBudget(cost, flagUsd, merged),
    })
  }
  return out.sort((a, b) => b.cost.total.usd - a.cost.total.usd || a.number - b.number)
}

/** @param {Snapshot} snap @returns {Counts} */
function countsOf(snap) {
  const c = { intake: 0, task: 0, human: 0, promote: 0, running: 0, review: 0 }
  for (const issue of snap.issues.values()) {
    if (issue.state !== 'OPEN') {
      // Closed and merged, waiting for promotion (promotion.mjs).
      if (issue.labels.includes(Q.promote)) c.promote++
      continue
    }
    const q = queueOf(issue.labels)
    if (q === Q.intake) c.intake++
    else if (q === Q.task) c.task++
    else if (q === Q.human) c.human++
    else if (q === Q.promote) c.promote++
    if (issue.labels.includes(RUNNING)) c.running++
  }
  c.review = snap.prs.filter((p) => p.state === 'OPEN').length
  return c
}

/** @type {import('./graph/describe.mjs').GraphDescription[] | undefined} */
let described
/**
 * Every graph cambium defines, as plain JSON; built once, on first use (graph-engine.mjs imports this file). `decide`
 * is driven by a session, not the tick, so it is not in GRAPHS (`cambium run`), but canopy shows it all the same.
 */
const graphDescriptions = () => {
  described ??= [...Object.values(GRAPHS), decide].map(describeGraph)
  return described
}

/** @param {Deps} deps @param {Ctx} ctx @returns {HeartbeatState} */
export function heartbeatState(deps, ctx) {
  const { config } = deps
  const finished = deps.clock.now()
  const since = dayOf(ctx.now - (COST_DAYS - 1) * 86_400_000)
  const ledger = deps.store.costs(since)
  const repos = config.repos.map((r) => {
    const snap = ctx.snaps.get(r.slug)
    return {
      slug: r.slug,
      ok: Boolean(snap),
      error: ctx.readErrors.get(r.slug) ?? null,
      read: ctx.reads.get(r.slug) ?? null,
      counts: snap ? countsOf(snap) : null,
      base: snap?.base ?? null,
      watch: watchStates(deps, r.slug),
      stalls: stallStates(deps.store, r.slug),
      stall: stallState(deps.store, r.slug),
      rateLimit: snap?.rateLimit ?? null,
      cost: {
        issues: snap ? issueCosts(snap, config.costFlagUsd) : [],
        days: costDays(ledger.filter((row) => row.repo === r.slug)),
      },
    }
  })
  const total = { intake: 0, task: 0, human: 0, promote: 0, running: 0, review: 0 }
  for (const r of repos)
    if (r.counts) for (const k of /** @type {(keyof Counts)[]} */ (Object.keys(total))) total[k] += r.counts[k]
  const workers = deps.store.workers().map((w) => {
    const caps = capsFor(config, w.repo, w.phase)
    return {
      repo: w.repo,
      issue: w.issue,
      phase: w.phase,
      pid: w.pid,
      alive: deps.procs.alive(w.pid),
      attempt: w.attempt,
      branch: w.branch,
      worktree: w.worktree,
      startedAt: iso(w.startedAt),
      elapsedMs: finished - w.startedAt,
      wallClockMs: caps.wallClockMinutes * MIN,
      killedReason: w.killedReason,
      logs: { stdout: w.stdout, stderr: w.stderr },
    }
  })
  return {
    version: 1,
    host: config.host,
    pid: deps.pid ?? process.pid,
    mode: ctx.mode,
    daemon: { startedAt: deps.daemonStartedAt ? iso(deps.daemonStartedAt) : null, tickSeconds: config.tickSeconds },
    tick: {
      n: deps.tickNumber ?? 0,
      startedAt: iso(ctx.now),
      finishedAt: iso(finished),
      durationMs: finished - ctx.now,
      nextAt: iso(finished + config.tickSeconds * 1000),
    },
    steps: [...ctx.steps],
    counts: { ...total, workers: workers.length },
    caps: { task: config.phases.task.cap, dispatch: config.phases.dispatch.cap },
    repos,
    workers,
    events: deps.events?.() ?? [],
    engine: config.engine,
    graphs: graphDescriptions(),
    costFlagUsd: config.costFlagUsd,
  }
}

// ---- Queue view

/**
 * canopy's board, from this tick's snapshots (queue-view.mjs). Local files only; runs while paused too.
 * @param {Deps} deps @param {Ctx} ctx
 */
async function writeQueueView(deps, ctx) {
  if (!deps.queues) return
  const view = queueView({
    repos: deps.config.repos.map((r) => r.slug),
    snaps: ctx.snaps,
    readErrors: ctx.readErrors,
    now: deps.clock.now(),
    tickSeconds: deps.config.tickSeconds,
    prev: deps.queues.prev?.() ?? null,
  })
  await deps.queues.write(view)
}

/**
 * Each repo's full snapshot, as this tick leaves it, for `run … --follow` (snapshot-file.mjs). Local files only.
 * @param {Deps} deps @param {Ctx} ctx
 */
async function writeSnapshotsFile(deps, ctx) {
  await deps.snapshots?.write(
    snapshotsFile({
      repos: deps.config.repos.map((r) => r.slug),
      snaps: ctx.snaps,
      readErrors: ctx.readErrors,
      fetchedAt: ctx.now,
      now: deps.clock.now(),
      tickSeconds: deps.config.tickSeconds,
    }),
  )
}

// ---- Briefs

/**
 * Session briefs (briefs.mjs) for the `q:human` items worth an interactive session, from this tick's snapshots.
 * Local files only; runs while paused too, since it changes nothing on GitHub.
 * @param {Deps} deps @param {Ctx} ctx
 */
async function briefs(deps, ctx) {
  if (!deps.briefs) return
  const { written, removed } = syncBriefs({ ...deps.briefs, config: deps.config, snaps: ctx.snaps })
  for (const p of written) deps.log('info', `session brief written: ${p}`)
  for (const p of removed) deps.log('info', `session brief removed: ${p}`)
}
