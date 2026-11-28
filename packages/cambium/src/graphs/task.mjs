// @ts-check
/**
 * The Task phase as a graph: a worker turns a `q:task` issue into a published PR, and the graph ends there
 * (`submit`). What happens to the PR after that (merge, rework, close, the Human Queue) is the PR graph's
 * (graphs/pr.mjs); a rework comes back here through `q:task`. Each node declares the queue label it sits in and
 * whether it holds `running`; every label change goes through `move()` from that declaration (see {@link landAt}).
 *
 * Step nodes write their own transition (marker, then labels) before or after their side effect. A wait node
 * with `enter` is written by the runtime when an edge lands on it.
 */
import { capsFor } from '../config.mjs'
import { z } from 'zod'
import { defineGraph, defineNode, defineWait, END } from '../graph/index.mjs'
import { branchName } from '../convention.mjs'
import { iso, key, markerOf, setLabels, setMarker } from '../issue-state.mjs'
import { move, Q, WHY } from '../labels.mjs'
import { withHistory } from '../marker.mjs'
import { handOffOf, handOffReason, linkIssue, prFor, taskExit, taskPrompt } from '../phases/task.mjs'
import { PREPARE_FAILED_LINE } from '../prepare.mjs'
import { traceWorker } from '../tracing.mjs'
import { recordCost } from '../cost.mjs'
import { baseRed, isRepair } from '../base-health.mjs'
import { stopOverdue } from '../workers.mjs'

/**
 * @typedef {import('../github.mjs').Issue} Issue
 * @typedef {import('../github.mjs').Snapshot} Snapshot
 * @typedef {import('../github.mjs').PullRequest} PullRequest
 * @typedef {import('../marker.mjs').Marker} Marker
 * @typedef {{
 *   slug: string, number: number, issue?: Issue, snap?: Snapshot,
 *   pr?: PullRequest | null, deleted?: Set<string>, foreground?: boolean, reaped?: Set<number>,
 *   started?: import('../workers.mjs').Started & { attempt: number }, traceparent?: string | null,
 * }} Subject
 *   One issue's turn. `pr` is the PR Watch is looking at; `deleted` the branches already deleted this tick;
 *   `foreground`/`reaped`/`started` are for `cambium run`; `traceparent` is the issue trace while the turn is
 *   traced (tracing.mjs `turnTracer`), which markers written in the turn take.
 * @typedef {import('../tick.mjs').Deps & {
 *   tick: import('../tick.mjs').Ctx, subject: Subject, traceparent?: string | null,
 * }} TaskCtx
 *   `traceparent`: the running step node's span, when advance is instrumented (tracing.mjs).
 * @typedef {{ node: string, input: unknown }} Position
 * @typedef {{
 *   queue: string | null, running: boolean, about?: string, pollOnEntry?: boolean,
 *   enter?: (input: any, ctx: TaskCtx) => Promise<void>,
 *   recover?: (ctx: TaskCtx) => Position,
 * }} Declared
 *   `queue`/`running`: the labels an issue resting here carries. `pollOnEntry`: a wait polled in the same turn it
 *   is entered (otherwise entering a wait ends the turn). `enter`: the write that lands an issue on this wait.
 *   `recover`: where a stale `running` lease at this node goes (default: requeue).
 * @typedef {import('../graph/define.mjs').GraphNode & Declared} TaskNode
 */

/**
 * @template {import('../graph/define.mjs').GraphNode} N @param {N} node @param {Declared} decl
 * @returns {N & Declared}
 */
export const declare = (node, decl) => Object.freeze({ ...node, ...decl })

/** @param {TaskCtx} ctx */
export function issueOf(ctx) {
  const { issue } = ctx.subject
  if (!issue) throw new Error(`${ctx.subject.slug}#${ctx.subject.number} is not in the snapshot`)
  return issue
}

/** @param {TaskCtx} ctx */
export function snapOf(ctx) {
  const { snap } = ctx.subject
  if (!snap) throw new Error(`${ctx.subject.slug} has no snapshot this tick`)
  return snap
}

/** A marker as the graph writes it: no stage-tick `stage`, which would override `node`. @param {Marker} m */
const graphMarker = (m) => /** @type {Marker} */ (Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'stage')))

/**
 * Put the issue at `node` of graph `g`: the marker first, then the labels `node` declares, via `move()`. A
 * half-applied transition is re-done (and over-counted) on the next tick, never under-counted.
 *
 * @param {import('../graph/define.mjs').Graph} g @param {TaskCtx} ctx @param {string} node @param {Marker} marker
 * @param {{ extra?: string[], status?: Marker['status'] }} [opts]
 */
export async function landAt(g, ctx, node, marker, { extra = [], status = 'waiting' } = {}) {
  const { slug } = ctx.subject
  const issue = issueOf(ctx)
  const decl = /** @type {Declared | undefined} */ (g.nodes.find((n) => n.name === node))
  if (!decl) throw new Error(`${g.name} graph has no node "${node}"`)
  await setMarker(ctx, slug, issue, {
    ...graphMarker(marker),
    graph: g.name,
    graphVersion: g.version,
    node,
    status,
    enteredAt: iso(ctx.tick.now),
  })
  await setLabels(ctx, slug, issue, move(issue.labels, decl.queue, { running: decl.running, extra }))
  ctx.tick.touched.add(key(slug, issue.number))
}

/** {@link landAt} in the task graph. @param {TaskCtx} ctx @param {string} node @param {Marker} marker @param {{ extra?: string[], status?: Marker['status'] }} [opts] */
const land = (ctx, node, marker, opts) => landAt(task, ctx, node, marker, opts)

// ---- Schemas

export const failure = {
  reason: z.string(),
  outcome: z.string(),
  pr: z.number().int().optional(),
  log: z.string().optional(),
  failedSha: z.string().nullable().optional(),
  /** The worker posted a hand-off comment (phases/task.mjs `HAND_OFF`): straight to a person. */
  handOff: z.boolean().optional(),
  /** Where the failure happened, when that is not the node the marker rests at. */
  at: z.string().optional(),
}
const Failure = z.object(failure)
const Empty = z.object({})
const WorkerIn = z.object({ branch: z.string().nullable(), attempt: z.number().int() })
// ---- Edge predicates (their names label the Mermaid edges)

const started = (/** @type {{ to: string }} */ o) => o.to === 'running'
const budgetSpent = (/** @type {{ to: string }} */ o) => o.to === 'human'
const issueGone = (/** @type {{ exit: string }} */ o) => o.exit === 'gone'
const submitted = (/** @type {{ exit: string }} */ o) => o.exit === 'submitted'
const attemptsLeft = (/** @type {{ to: string }} */ o) => o.to === 'start'

// ---- Shared checks

/** A history entry's `node` from a failure's `at`, when it names one. @param {{ at?: string }} what */
export const nodeAt = (what) => (what.at ? { node: what.at } : {})

// ---- Nodes

const startWorker = declare(
  defineNode({
    name: 'start-worker',
    input: Empty,
    output: z.discriminatedUnion('to', [
      z.object({
        to: z.literal('running'),
        pid: z.number().int(),
        branch: z.string(),
        worktree: z.string(),
        attempt: z.number().int(),
      }),
      z.object({ to: z.literal('requeue'), ...failure }),
      z.object({ to: z.literal('human'), ...failure }),
    ]),
    /**
     * Claim the issue and start its worker: marker, then `running`, then the process. A crash between the claim
     * and the spawn leaves a stale lease that the sweep recovers.
     * @param {{}} _ @param {TaskCtx} ctx
     */
    run: async (_, ctx) => {
      const { config, spawner, store } = ctx
      const { slug, snap, foreground = false } = ctx.subject
      const issue = issueOf(ctx)
      const repo = config.repos.find((r) => r.slug === slug)
      if (!repo) throw new Error(`${slug} is not in the config`)
      const caps = capsFor(config, slug, 'task')
      const m0 = markerOf(issue)
      if (m0.attempt > caps.maxAttempts)
        return { to: 'human', reason: `${caps.maxAttempts} attempts spent`, outcome: 'budget' }
      /** @type {import('../convention.mjs').Convention} */
      let convention
      try {
        convention = spawner.convention(repo)
      } catch (err) {
        return {
          to: 'requeue',
          reason: `could not start the worker: ${/** @type {Error} */ (err)?.message ?? err}`,
          outcome: 'spawn-failed',
        }
      }
      const known = snap ? prFor(snap, { issue: issue.number, branch: m0.branch }) : null
      const pr = known?.state === 'OPEN' ? known : null
      // Sticky: a retry keeps the branch (and so the worktree topic) its first attempt chose.
      const branch = pr?.branch ?? m0.branch ?? branchName(convention.branch, issue.number, issue.title)
      await land(ctx, 'worker-running', {
        ...m0,
        phase: 'task',
        host: config.host,
        start: iso(ctx.tick.now),
        branch,
        pr: pr?.number ?? m0.pr ?? null,
        input: { branch, attempt: m0.attempt },
      })
      const marker = markerOf(issue)

      /** @type {import('../workers.mjs').Started} */
      let s
      try {
        s = await spawner.start({
          repo,
          convention,
          issue: issue.number,
          attempt: marker.attempt,
          branch,
          phase: 'task',
          maxTurns: caps.maxTurns,
          foreground,
          // This node's cambium.node span, so Claude Code's own spans (when worker.env turns them on) join the trace.
          env: ctx.traceparent ? { TRACEPARENT: ctx.traceparent } : undefined,
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
        // The claim already put the marker at worker-running; the failure is this node's.
        return {
          to: 'requeue',
          reason: `could not start the worker: ${/** @type {Error} */ (err)?.message ?? err}`,
          outcome: 'spawn-failed',
          at: 'start-worker',
        }
      }
      store.addWorker({
        repo: slug,
        issue: issue.number,
        phase: 'task',
        pid: s.pid,
        worktree: s.worktree,
        branch,
        attempt: marker.attempt,
        startedAt: ctx.tick.now,
        host: config.host,
        stdout: s.stdout,
        stderr: s.stderr,
        traceparent: ctx.traceparent ?? null,
      })
      const where = { repo: slug, issue: issue.number }
      if (s.reused) ctx.log('warn', `continuing in the previous worktree ${s.worktree}: ${s.reused}`, where)
      ctx.log('info', `started task worker pid ${s.pid} (attempt ${marker.attempt}, ${branch})`, where)
      ctx.subject.started = { ...s, attempt: marker.attempt }
      return { to: 'running', pid: s.pid, branch, worktree: s.worktree, attempt: marker.attempt }
    },
  }),
  {
    queue: Q.task,
    running: false,
    about: 'Claims the issue and starts a Claude worker on its branch; out of attempts, it goes to a human.',
  },
)

const workerRunning = declare(
  defineWait({
    name: 'worker-running',
    input: WorkerIn,
    output: z.discriminatedUnion('exit', [
      z.object({ exit: z.literal('submitted'), pr: z.number().int(), branch: z.string(), log: z.string() }),
      z.object({ exit: z.literal('failed'), ...failure }),
      z.object({ exit: z.literal('gone') }),
    ]),
    /**
     * Alive and under the wall-clock cap: hold. Over it: kill, then exit-check. Gone: the exit check (a PR that
     * is open or merged and not still on the red commit) or a failure with the stderr tail.
     * @param {unknown} _ @param {TaskCtx} ctx
     */
    poll: async (_, ctx) => {
      const { config, store, procs, spawner } = ctx
      const { slug, number, snap, issue, reaped } = ctx.subject
      const w = store.worker(slug, number)
      if (!w) {
        const host = issue?.stateComment?.marker.host
        if (host && host !== config.host) return { ready: false }
        return { ready: true, output: { exit: 'failed', ...lostLeaseOf(ctx) } }
      }
      const caps = capsFor(config, w.repo, w.phase)
      if (
        !reaped?.has(w.pid) &&
        stopOverdue({ procs, store, log: ctx.log }, w, caps.wallClockMinutes, ctx.tick.now) !== 'gone'
      )
        return { ready: false }
      if (!snap) return { ready: false } // a dead worker waits for a readable snapshot
      await recordCost(ctx, issue, w, ctx.tick.now)
      if (issue?.state !== 'OPEN') {
        ctx.log('info', 'worker gone; issue is closed or no longer queued', { repo: w.repo, issue: w.issue })
        return { ready: true, output: { exit: 'gone' } }
      }
      traceWorker(ctx, w)
      const pr = prFor(snap, w)
      const m = markerOf(issue)
      const prepFailed = !w.killedReason && spawner.tail(w.stderr, 15).includes(PREPARE_FAILED_LINE)
      const verdict = w.killedReason
        ? { ok: false, reason: w.killedReason }
        : prepFailed
          ? { ok: false, reason: 'could not start the worker: prepare failed' }
          : taskExit(pr, m)
      if (verdict.ok && pr)
        return { ready: true, output: { exit: 'submitted', pr: pr.number, branch: pr.branch, log: w.stdout } }
      const handOff = !w.killedReason && !prepFailed && pr?.state !== 'OPEN' ? handOffOf(issue, w.startedAt) : null
      if (handOff)
        return {
          ready: true,
          output: {
            exit: 'failed',
            reason: handOffReason(handOff),
            outcome: 'handed-off',
            handOff: true,
            log: w.stdout,
          },
        }
      const tail = spawner.tail(w.stderr, 15)
      return {
        ready: true,
        output: {
          exit: 'failed',
          reason: `${'reason' in verdict ? verdict.reason : 'worker failed'}${tail ? `\n--- stderr (last lines, ${w.stderr})\n${tail}` : ''}`,
          outcome: w.killedReason ? 'killed' : prepFailed ? 'spawn-failed' : 'failed',
          pr: pr?.number,
          log: w.stdout,
        },
      }
    },
  }),
  {
    queue: Q.task,
    about: 'Holds while the worker runs under its wall-clock cap; on exit, looks for the PR it published.',
    running: true,
    recover: (ctx) => ({ node: 'requeue', input: lostLeaseOf(ctx) }),
  },
)

/** @param {TaskCtx} ctx */
export const lostLeaseOf = (ctx) => ({
  reason: `worker lost: \`running\` on ${ctx.config.host} with no live process`,
  outcome: 'lost',
})

const SubmitIn = z.object({ pr: z.number().int(), branch: z.string(), log: z.string().optional() })

const submit = declare(
  defineNode({
    name: 'submit',
    input: SubmitIn,
    output: Empty,
    /**
     * The worker published its PR: the task graph ends. The issue leaves every queue and the PR graph takes the PR
     * from the next tick (graphs/pr.mjs). A PR found only by its branch gets `Closes #n`, so it can be paired.
     * @param {z.infer<typeof SubmitIn>} input @param {TaskCtx} ctx
     */
    run: async (input, ctx) => {
      const m = markerOf(issueOf(ctx))
      const at = iso(ctx.tick.now)
      await land(
        ctx,
        'submit',
        {
          ...withHistory(m, { at, attempt: m.attempt, outcome: 'submitted', pr: input.pr, log: input.log }),
          pr: input.pr,
          branch: input.branch,
          submittedAt: at,
          queued: false,
          lastFailure: null,
          input: null,
        },
        { status: 'done' },
      )
      ctx.log('info', `submitted PR #${input.pr}; watching CI`, { repo: ctx.subject.slug, issue: ctx.subject.number })
      const snap = ctx.subject.snap
      const pr = snap?.prs.find((p) => p.number === input.pr) ?? null
      await linkIssue(ctx, ctx.subject.slug, pr, ctx.subject.number)
      return {}
    },
  }),
  {
    queue: null,
    running: false,
    about: 'The worker published its PR: the issue leaves every queue and the PR graph takes over.',
  },
)

const requeue = declare(
  defineNode({
    name: 'requeue',
    input: Failure,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('start'), attempt: z.number().int() }),
      z.object({ to: z.literal('human'), ...failure }),
    ]),
    /**
     * Back to `q:task` with attempt + 1, or to the Human Queue once the attempts are spent or the worker handed
     * the issue off. While the base is red (base-health.mjs) a failure is not the work's own: it requeues at the
     * same attempt, never to the Human Queue, and Schedule holds it until the base is green. The repair issue
     * itself is charged as usual.
     * @param {z.infer<typeof Failure>} what @param {TaskCtx} ctx
     */
    run: async (what, ctx) => {
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      const max = ctx.config.phases.task.maxAttempts
      if (what.handOff) return { ...what, to: 'human' }
      const free = baseRed(ctx.subject.snap) && !isRepair(issue)
      if (m.attempt >= max && !free)
        return { ...what, to: 'human', reason: `${max} attempts spent. Last: ${what.reason}` }
      const { pr, log, failedSha } = what
      const base = ctx.subject.snap?.base
      const outcome = free ? 'base-red' : what.outcome
      const reason = free
        ? `${base?.branch} is red at ${(base?.red?.sha ?? '').slice(0, 7)}; not charged. ${what.reason}`
        : what.reason
      const next = free ? m.attempt : m.attempt + 1
      await land(ctx, 'start-worker', {
        ...withHistory(m, { ...nodeAt(what), at: iso(ctx.tick.now), attempt: m.attempt, outcome, reason, pr, log }),
        attempt: next,
        lastFailure: reason,
        host: null,
        start: null,
        input: null,
        ...(failedSha !== undefined ? { failedSha } : {}),
      })
      ctx.log('info', `requeued (attempt ${next}/${max}): ${reason.split('\n')[0]}`, {
        repo: ctx.subject.slug,
        issue: issue.number,
      })
      return { to: 'start', attempt: next }
    },
  }),
  {
    queue: Q.task,
    running: false,
    about:
      'Back to q:task with attempt + 1, or to a human once the attempts are spent. Not charged while the base is red.',
  },
)

const HumanIn = z.object({ ...failure, why: z.string().optional() })
const toHuman = declare(
  defineNode({
    name: 'to-human',
    input: HumanIn,
    output: Empty,
    /** Into the Human Queue with a reason label. @param {z.infer<typeof HumanIn>} what @param {TaskCtx} ctx */
    run: async (what, ctx) => {
      const { reason, outcome, pr, log, failedSha, why = WHY.budget } = what
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      await land(
        ctx,
        'to-human',
        {
          ...withHistory(m, { ...nodeAt(what), at: iso(ctx.tick.now), attempt: m.attempt, outcome, reason, pr, log }),
          lastFailure: reason,
          ...(m.ask ? { ask: null } : {}),
          host: null,
          start: null,
          input: null,
          ...(failedSha !== undefined ? { failedSha } : {}),
        },
        { extra: [why] },
      )
      ctx.log('warn', `→ q:human (${why}): ${reason.split('\n')[0]}`, { repo: ctx.subject.slug, issue: issue.number })
      return {}
    },
  }),
  { queue: Q.human, running: false, about: 'Into q:human with a why:* reason label.' },
)

/**
 * The Task phase. Bump `version` when a node is removed or renamed (see marker.mjs `graphVersionDecision`).
 * v2: the PR nodes (`ci-running`, `merge`, `merging`, `merge-queue`, `close-out`) moved to the PR graph; a
 * marker resting at one of them is the PR graph's (graph-engine.mjs `locate`), not a restart.
 */
export const task = defineGraph({
  name: 'task',
  about: 'Turns a q:task issue into a published PR; a failed attempt is retried until the budget is spent.',
  version: 2,
  entry: { queue: Q.task, node: 'start-worker', input: () => ({}) },
  nodes: [startWorker, workerRunning, submit, requeue, toHuman],
  edges: [
    ['start-worker', 'worker-running', started],
    ['start-worker', 'to-human', budgetSpent],
    ['start-worker', 'requeue'],
    ['worker-running', END, issueGone],
    ['worker-running', 'submit', submitted],
    ['worker-running', 'requeue'],
    ['submit', END],
    ['requeue', 'start-worker', attemptsLeft],
    ['requeue', 'to-human'],
    ['to-human', END],
  ],
})

/** Task-graph nodes of v1 (and stage-era `submitted`/`done`) that the PR graph now owns: an issue resting at one has a PR. */
export const HANDED_OFF = new Set(['submit', 'ci-running', 'merge', 'merging', 'merge-queue', 'close-out'])

/** @param {string} name @returns {TaskNode} */
export function nodeOf(name) {
  const node = task.nodes.find((n) => n.name === name)
  if (!node) throw new Error(`task graph has no node "${name}"`)
  return /** @type {TaskNode} */ (node)
}

/** Nodes that end the graph: an issue resting here has nothing left to run. */
export const TERMINAL = new Set(task.edges.filter(([, to]) => to === END).map(([from]) => from))
TERMINAL.delete('worker-running')

/** Queue label → owner, for `effectivePosition`: `q:task` belongs to the task graph's nodes that declare it. */
export const TASK_QUEUES = {
  [Q.task]: {
    graph: task.name,
    entryNode: task.entry.node,
    nodes: task.nodes.filter((n) => /** @type {TaskNode} */ (n).queue === Q.task).map((n) => n.name),
  },
}

/** The input a resting node resumes with, rebuilt from the marker. @param {string} node @param {Marker} m */
export function inputFor(node, m) {
  if (node === 'worker-running') return { branch: m.branch, attempt: m.attempt }
  return {}
}
