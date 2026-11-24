// @ts-check
/**
 * The Dispatch phase as a graph: a `q:intake` issue is triaged by a one-shot `claude -p` worker whose final
 * message carries a typed verdict ({@link TriageResult}), then moved to `q:task`, moved to `q:human`, or closed as
 * a duplicate or obsolete, deferred to be triaged again later, or parked as blocked until its GitHub `blockedBy` issues close. Same conventions as the task graph (graphs/task.mjs): each node declares its queue label and
 * whether it holds `running`, and a node's write is the marker first, then the labels via `move()`.
 *
 * The triage worker runs in a read-only checkout (workers.mjs `readOnly`): detached at the base branch, no install,
 * no Edit/Write. It reads code to judge the issue, and nothing it could leave behind is worth keeping.
 */
import { capsFor } from '../config.mjs'
import { z } from 'zod'
import { defineGraph, defineNode, defineWait, END } from '../graph/index.mjs'
import { iso, key, markerOf, MIN, setLabels, setMarker } from '../issue-state.mjs'
import { Ask, withAskLabels } from '../ask.mjs'
import { move, Q, WAIT, WHY } from '../labels.mjs'
import { newMarker, withHistory } from '../marker.mjs'
import { readTriage, TriageResult, triageComment, triagePrompt } from '../phases/dispatch.mjs'
import { humanReplies, quoted, replyContextOf } from '../human-reply.mjs'
import { traceWorker } from '../tracing.mjs'
import { fingerprintOf } from '../triage-inputs.mjs'
import { recordCost } from '../cost.mjs'
import { stopOverdue } from '../workers.mjs'
import { task } from './task.mjs'

/**
 * @typedef {import('../github.mjs').Issue} Issue
 * @typedef {import('../marker.mjs').Marker} Marker
 * @typedef {import('./task.mjs').Subject} Subject
 * @typedef {import('./task.mjs').TaskCtx} DispatchCtx
 * @typedef {{ queue: string | null, running: boolean, about?: string }} Declared
 *   A stale `running` lease (at `triaging`) goes to `retry-triage` (dispatch-engine.mjs sweep).
 * @typedef {import('../graph/define.mjs').GraphNode & Declared} DispatchNode
 */

/** The nodes an issue in `q:intake` can rest at; a marker elsewhere starts triage over at attempt 1. */
const INTAKE_NODES = new Set(['start-triage', 'triaging', 'retry-triage', 'deferred', 'blocked'])
/** The nodes before a verdict: the marker keeps its `reply` context through them; any other node drops it. */
const PRE_VERDICT = new Set(['start-triage', 'triaging', 'retry-triage'])

/** The open issues among `issue`'s GitHub `blockedBy` links. @param {Issue} issue */
export const openBlockers = (issue) => (issue.blockedBy ?? []).filter((b) => b.state === 'OPEN').map((b) => b.number)

/** The pseudo-branch that names an issue's triage checkout (`<root>/triage-<n>`); never created. @param {number} n */
export const triageBranch = (n) => `cambium/triage-${n}`

/**
 * @template {import('../graph/define.mjs').GraphNode} N @param {N} node @param {Declared} decl
 * @returns {N & Declared}
 */
const declare = (node, decl) => Object.freeze({ ...node, ...decl })

/** @param {DispatchCtx} ctx */
function issueOf(ctx) {
  const { issue } = ctx.subject
  if (!issue) throw new Error(`${ctx.subject.slug}#${ctx.subject.number} is not in the snapshot`)
  return issue
}

/** @param {Marker} m */
const graphMarker = (m) => /** @type {Marker} */ (Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'stage')))

/**
 * Put the issue at `node` of this graph: the marker, then the labels `node` declares.
 * @param {DispatchCtx} ctx @param {string} node @param {Marker} marker
 * @param {{ extra?: string[], status?: Marker['status'] }} [opts]
 */
async function land(ctx, node, marker, { extra = [], status = 'waiting' } = {}) {
  const { slug } = ctx.subject
  const issue = issueOf(ctx)
  const decl = nodeOf(node)
  await setMarker(ctx, slug, issue, {
    ...graphMarker(marker),
    ...(PRE_VERDICT.has(node) ? {} : { reply: null }),
    ...(node === 'to-human' ? {} : { ask: null }),
    graph: dispatch.name,
    graphVersion: dispatch.version,
    phase: 'dispatch',
    node,
    status,
    enteredAt: iso(ctx.tick.now),
  })
  await setLabels(ctx, slug, issue, move(issue.labels, decl.queue, { running: decl.running, extra }))
  ctx.tick.touched.add(key(slug, issue.number))
}

/**
 * The marker triage continues from: this graph's own while the issue is still in intake, else a fresh one at
 * attempt 1 that keeps the history (e.g. a human sent a `q:human` issue back to `q:intake`).
 * @param {Issue} issue @returns {Marker}
 */
function intakeMarker(issue) {
  const m = markerOf(issue)
  if (m.graph === dispatch.name && m.status !== 'done' && INTAKE_NODES.has(m.node)) return m
  return newMarker({
    graph: dispatch.name,
    node: dispatch.entry.node,
    phase: 'dispatch',
    history: m.history,
    traceparent: m.traceparent,
  })
}

// ---- Schemas

const failure = { reason: z.string(), outcome: z.string(), log: z.string().optional() }
const Failure = z.object(failure)
const Empty = z.object({})
const Verdict = z.object({ result: TriageResult, log: z.string() })

// ---- Edge predicates (their names label the Mermaid edges)

const started = (/** @type {{ to: string }} */ o) => o.to === 'running'
const budgetSpent = (/** @type {{ to: string }} */ o) => o.to === 'human'
const attemptsLeft = (/** @type {{ to: string }} */ o) => o.to === 'start'
const issueGone = (/** @type {{ exit: string }} */ o) => o.exit === 'gone'
const leaseLost = (/** @type {{ exit: string }} */ o) => o.exit === 'lost'
/** @typedef {{ exit: string, result?: { verdict: string } }} Triaged */
const verdictOf = (/** @type {Triaged} */ o) => (o.exit === 'triaged' ? o.result?.verdict : undefined)
const actionable = (/** @type {Triaged} */ o) => verdictOf(o) === 'actionable'
const needsHuman = (/** @type {Triaged} */ o) => verdictOf(o) === 'needs-human'
const duplicate = (/** @type {Triaged} */ o) => verdictOf(o) === 'duplicate'
const obsolete = (/** @type {Triaged} */ o) => verdictOf(o) === 'obsolete'
const defer = (/** @type {Triaged} */ o) => verdictOf(o) === 'defer'
const blocked = (/** @type {Triaged} */ o) => verdictOf(o) === 'blocked'
const noneOpen = (/** @type {{ to: string }} */ o) => o.to === 'defer'

/** @param {DispatchCtx} ctx */
export const lostLeaseOf = (ctx) => ({
  reason: `triage worker lost: \`running\` on ${ctx.config.host} with no live process`,
  outcome: 'lost',
})

// ---- Nodes

const startTriage = declare(
  defineNode({
    name: 'start-triage',
    input: Empty,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('running'), pid: z.number().int(), worktree: z.string(), attempt: z.number().int() }),
      z.object({ to: z.literal('retry'), ...failure }),
      z.object({ to: z.literal('human'), ...failure }),
    ]),
    /**
     * Claim the issue (marker, then `running`), then start the triage worker in a read-only checkout.
     * @param {{}} _ @param {DispatchCtx} ctx
     */
    run: async (_, ctx) => {
      const { config, spawner, store } = ctx
      const { slug, snap } = ctx.subject
      const issue = issueOf(ctx)
      const repo = config.repos.find((r) => r.slug === slug)
      if (!repo) throw new Error(`${slug} is not in the config`)
      const caps = capsFor(config, slug, 'dispatch')
      const m0 = intakeMarker(issue)
      if (m0.attempt > caps.maxAttempts)
        return { to: 'human', reason: `${caps.maxAttempts} triage attempts spent`, outcome: 'budget' }
      /** @type {import('../convention.mjs').Convention} */
      let convention
      try {
        convention = spawner.convention(repo)
      } catch (err) {
        return { to: 'retry', reason: `could not start triage: ${errText(err)}`, outcome: 'spawn-failed' }
      }
      // A human reply since the issue last waited (on a needs-human, defer or blocked reason) is the answer to it.
      const reply = m0.reply ?? replyContextOf(markerOf(issue))
      const replies = reply ? quoted(humanReplies(issue, { since: reply.since, botLogin: config.graft.botLogin })) : []
      await land(ctx, 'triaging', {
        ...m0,
        reply,
        // The inputs this worker sees; to-human keeps them on a needs-human verdict, so the stall fallback re-triages it only on a change.
        fingerprint: { hash: fingerprintOf(issue, snap, { botLogin: config.graft.botLogin }), at: iso(ctx.tick.now) },
        deferUntil: null,
        host: config.host,
        start: iso(ctx.tick.now),
        input: { attempt: m0.attempt },
      })
      const marker = markerOf(issue)
      const queued = [...(snap?.issues.values() ?? [])]
        .filter((i) => i.state === 'OPEN')
        .map(({ number, title, labels }) => ({ number, title, labels }))
      /** @type {import('../workers.mjs').Started} */
      let s
      try {
        s = await spawner.start({
          repo,
          convention,
          issue: issue.number,
          attempt: marker.attempt,
          branch: triageBranch(issue.number),
          phase: 'dispatch',
          maxTurns: caps.maxTurns,
          readOnly: true,
          foreground: ctx.subject.foreground ?? false,
          // This node's cambium.node span, so Claude Code's own spans (when worker.env turns them on) join the trace.
          env: ctx.traceparent ? { TRACEPARENT: ctx.traceparent } : undefined,
          buildPrompt: (agentsMd) =>
            triagePrompt({
              repo: slug,
              baseBranch: repo.baseBranch,
              issue,
              queued,
              agentsMd,
              deferHours: caps.deferHours,
              deferred:
                !replies.length && m0.deferReason && !m0.blockedBy?.length
                  ? { count: m0.defers ?? 0, reason: m0.deferReason }
                  : null,
              blocked:
                !replies.length && m0.blockedBy?.length ? { by: m0.blockedBy, reason: m0.deferReason ?? '' } : null,
              replied: replies.length ? { question: reply?.question ?? null, replies } : null,
            }),
        })
      } catch (err) {
        return {
          to: 'retry',
          reason: `could not start triage: ${errText(err)}`,
          outcome: 'spawn-failed',
          // The claim already put the marker at triaging; the failure is this node's.
        }
      }
      store.addWorker({
        repo: slug,
        issue: issue.number,
        phase: 'dispatch',
        pid: s.pid,
        worktree: s.worktree,
        branch: triageBranch(issue.number),
        attempt: marker.attempt,
        startedAt: ctx.tick.now,
        host: config.host,
        stdout: s.stdout,
        stderr: s.stderr,
        traceparent: ctx.traceparent ?? null,
      })
      ctx.log('info', `started triage worker pid ${s.pid} (attempt ${marker.attempt})`, {
        repo: slug,
        issue: issue.number,
      })
      ctx.subject.started = { ...s, attempt: marker.attempt }
      return { to: 'running', pid: s.pid, worktree: s.worktree, attempt: marker.attempt }
    },
  }),
  {
    queue: Q.intake,
    running: false,
    about: 'Claims the issue and starts a triage worker in a read-only checkout; out of attempts, it goes to a human.',
  },
)

const triaging = declare(
  defineWait({
    name: 'triaging',
    input: z.object({ attempt: z.number().int() }),
    output: z.discriminatedUnion('exit', [
      z.object({ exit: z.literal('triaged'), ...Verdict.shape }),
      z.object({ exit: z.literal('invalid'), ...failure }),
      z.object({ exit: z.literal('lost'), ...failure }),
      z.object({ exit: z.literal('gone') }),
    ]),
    /**
     * Alive and under the wall-clock cap: hold. Over it: kill. Gone: read the verdict from its stdout log; a
     * missing or invalid one is `invalid`, with the error.
     * @param {unknown} _ @param {DispatchCtx} ctx
     */
    poll: async (_, ctx) => {
      const { config, store, procs, spawner } = ctx
      const { slug, number, snap, issue, reaped } = ctx.subject
      const w = store.worker(slug, number)
      if (!w) {
        const host = issue?.stateComment?.marker.host
        if (host && host !== config.host) return { ready: false }
        return { ready: true, output: { exit: 'lost', ...lostLeaseOf(ctx) } }
      }
      const caps = capsFor(config, slug, 'dispatch')
      if (
        !reaped?.has(w.pid) &&
        stopOverdue({ procs, store, log: ctx.log }, w, caps.wallClockMinutes, ctx.tick.now) !== 'gone'
      )
        return { ready: false }
      if (!snap) return { ready: false }
      await recordCost(ctx, issue, w, ctx.tick.now)
      if (issue?.state !== 'OPEN' || !issue.labels.includes(Q.intake)) {
        ctx.log('info', 'triage worker gone; issue is closed or left q:intake', { repo: w.repo, issue: w.issue })
        return { ready: true, output: { exit: 'gone' } }
      }
      traceWorker(ctx, w)
      const read = w.killedReason ? { ok: false, error: w.killedReason } : readTriage(spawner.readLog(w.stdout), number)
      if (read.ok && 'result' in read)
        return { ready: true, output: { exit: 'triaged', result: read.result, log: w.stdout } }
      const tail = 'error' in read && !read.error.startsWith('invalid') ? spawner.tail(w.stderr, 15) : ''
      return {
        ready: true,
        output: {
          exit: 'invalid',
          reason: `${'error' in read ? read.error : 'no verdict'}${tail ? `\n--- stderr (last lines, ${w.stderr})\n${tail}` : ''}`,
          outcome: w.killedReason ? 'killed' : 'invalid',
          log: w.stdout,
        },
      }
    },
  }),
  {
    queue: Q.intake,
    running: true,
    about:
      'Holds while the triage worker runs under its wall-clock cap; on exit, reads the typed verdict from its log.',
  },
)

const retryTriage = declare(
  defineNode({
    name: 'retry-triage',
    input: Failure,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('start'), attempt: z.number().int() }),
      z.object({ to: z.literal('human'), ...failure }),
    ]),
    /** Back to `q:intake` with attempt + 1, or to a human once the attempts are spent. @param {z.infer<typeof Failure>} what @param {DispatchCtx} ctx */
    run: async (what, ctx) => {
      const issue = issueOf(ctx)
      const m = intakeMarker(issue)
      const max = ctx.config.phases.dispatch.maxAttempts
      if (m.attempt >= max)
        return { ...what, to: 'human', reason: `${max} triage attempts spent. Last: ${what.reason}` }
      await land(ctx, 'start-triage', {
        ...withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, ...what }),
        attempt: m.attempt + 1,
        lastFailure: what.reason,
        host: null,
        start: null,
        input: null,
      })
      ctx.log('info', `triage retried (attempt ${m.attempt + 1}/${max}): ${what.reason.split('\n')[0]}`, {
        repo: ctx.subject.slug,
        issue: issue.number,
      })
      return { to: 'start', attempt: m.attempt + 1 }
    },
  }),
  {
    queue: Q.intake,
    running: false,
    about: 'Back to q:intake with attempt + 1, or to a human once the attempts are spent.',
  },
)

const ToTaskIn = z.object({
  reason: z.string(),
  title: z.string().optional(),
  acceptance: z.array(z.string()).optional(),
  log: z.string(),
})
const toTask = declare(
  defineNode({
    name: 'to-task',
    input: ToTaskIn,
    output: Empty,
    /**
     * Actionable: the triage comment (task title and acceptance checks, when given), then the hand-off: a task-graph
     * marker at its entry, attempt 1, carrying the history and `triage` for the task prompt; then `q:task`.
     * The issue body is left as its author wrote it.
     * @param {z.infer<typeof ToTaskIn>} t @param {DispatchCtx} ctx
     */
    run: async (t, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      await ctx.github.comment(slug, issue.number, triageComment(t))
      const at = iso(ctx.tick.now)
      await setMarker(ctx, slug, issue, {
        ...newMarker({
          graph: task.name,
          graphVersion: task.version,
          node: task.entry.node,
          phase: 'task',
          enteredAt: at,
          traceparent: m.traceparent,
          history: withHistory(m, { at, attempt: m.attempt, outcome: 'actionable', reason: t.reason, log: t.log })
            .history,
        }),
        triage: t.title || t.acceptance?.length ? { title: t.title, acceptance: t.acceptance } : null,
      })
      await setLabels(ctx, slug, issue, move(issue.labels, Q.task))
      ctx.tick.touched.add(key(slug, issue.number))
      ctx.log('info', `triaged actionable → q:task: ${t.reason.split('\n')[0]}`, { repo: slug, issue: issue.number })
      return {}
    },
  }),
  {
    queue: Q.task,
    running: false,
    about:
      'Actionable: posts the triage comment (title, acceptance checks), then hands the issue to the task graph in q:task.',
  },
)

const HumanIn = z.object({ ...failure, ask: Ask.optional() })
const toHuman = declare(
  defineNode({
    name: 'to-human',
    input: HumanIn,
    output: Empty,
    /**
     * Into the Human Queue with `why:triage` and the reason in the state comment; a needs-human verdict's `ask` adds
     * its `ask:*` labels and is rendered there too. A needs-human verdict keeps the triage inputs `start-triage`
     * recorded (the stall fallback re-triages it only once they change); a spent budget drops them.
     * @param {z.infer<typeof HumanIn>} input @param {DispatchCtx} ctx
     */
    run: async ({ ask, ...what }, ctx) => {
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      const marker = {
        ...withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, ...what }),
        lastFailure: what.reason,
        ask: ask ?? null,
        fingerprint: what.outcome === 'needs-human' ? (m.fingerprint ?? null) : null,
        host: null,
        start: null,
        input: null,
      }
      await withAskLabels(ctx, { repo: ctx.subject.slug, issue: issue.number }, ask, (labels) =>
        land(ctx, 'to-human', marker, { extra: [WHY.triage, ...labels] }),
      )
      ctx.log('warn', `→ q:human (${WHY.triage}): ${what.reason.split('\n')[0]}`, {
        repo: ctx.subject.slug,
        issue: issue.number,
      })
      return {}
    },
  }),
  {
    queue: Q.human,
    running: false,
    about: 'Into q:human with why:triage (plus ask:* from a needs-human ask) and the reason in the state comment.',
  },
)

const DupIn = z.object({ duplicateOf: z.number().int(), reason: z.string(), log: z.string() })
const closeDuplicate = declare(
  defineNode({
    name: 'close-duplicate',
    input: DupIn,
    output: Empty,
    /** Out of every queue, closed as a duplicate with a link to the original. @param {z.infer<typeof DupIn>} d @param {DispatchCtx} ctx */
    run: async (d, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      await land(
        ctx,
        'close-duplicate',
        {
          ...withHistory(m, {
            at: iso(ctx.tick.now),
            attempt: m.attempt,
            outcome: 'duplicate',
            reason: d.reason,
            log: d.log,
          }),
          host: null,
          start: null,
          input: null,
        },
        { status: 'done' },
      )
      const link = `https://github.com/${slug}/issues/${d.duplicateOf}`
      await ctx.github.close(
        slug,
        issue.number,
        `Duplicate of #${d.duplicateOf} (${link}). ${d.reason}\n\nClosed by cambium.`,
        {
          reason: 'duplicate',
        },
      )
      issue.state = 'CLOSED'
      ctx.log('info', `duplicate of #${d.duplicateOf}; closed`, { repo: slug, issue: issue.number })
      return {}
    },
  }),
  { queue: null, running: false, about: 'Out of every queue, closed as a duplicate with a link to the original.' },
)

const DeferIn = z.object({ reason: z.string(), recheckHours: z.number().optional(), log: z.string() })
const deferred = declare(
  defineNode({
    name: 'deferred',
    input: DeferIn,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('wait'), until: z.string() }),
      z.object({ to: z.literal('human'), ...failure }),
    ]),
    /**
     * Defer: the verdict hangs on something a machine can check later (a CD run, a release, a merge). The issue stays
     * in `q:intake`, resting here until `deferUntil`; Schedule skips it until then, then triage runs again with this
     * reason in its prompt. A defer is not a failed attempt; `phases.dispatch.maxDefers` bounds them.
     * @param {z.infer<typeof DeferIn>} d @param {DispatchCtx} ctx
     */
    run: async (d, ctx) => {
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      const { deferHours, maxDefers } = ctx.config.phases.dispatch
      const defers = (m.defers ?? 0) + 1
      if (defers > maxDefers)
        return {
          to: 'human',
          reason: `deferred ${maxDefers} times without an answer. Last: ${d.reason}`,
          outcome: 'budget',
        }
      const hours = d.recheckHours ?? deferHours
      const until = iso(ctx.tick.now + hours * 60 * MIN)
      await land(
        ctx,
        'deferred',
        {
          ...withHistory(m, {
            at: iso(ctx.tick.now),
            attempt: m.attempt,
            outcome: 'defer',
            reason: d.reason,
            log: d.log,
          }),
          defers,
          deferUntil: until,
          deferReason: d.reason,
          blockedBy: null,
          host: null,
          start: null,
          input: null,
        },
        { extra: [WAIT.deferred] },
      )
      ctx.log('info', `triage deferred until ${until} (${defers}/${maxDefers}): ${d.reason.split('\n')[0]}`, {
        repo: ctx.subject.slug,
        issue: issue.number,
      })
      return { to: 'wait', until }
    },
  }),
  {
    queue: Q.intake,
    running: false,
    about: 'Rests in q:intake until a condition a machine can check is due, then triages again. Bounded by maxDefers.',
  },
)

const BlockedIn = z.object({
  blockedBy: z.array(z.number().int().positive()).min(1),
  reason: z.string(),
  log: z.string().optional(),
})
const blockedNode = declare(
  defineNode({
    name: 'blocked',
    input: BlockedIn,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('wait'), blockedBy: z.array(z.number().int()) }),
      z.object({ to: z.literal('defer'), reason: z.string(), log: z.string() }),
    ]),
    /**
     * Blocked: the issue waits on other issues. Each one triage named that GitHub does not link yet is added as a
     * `blockedBy` link; then the issue rests here in `q:intake` with `wait:blocked` and no `deferUntil`. Schedule
     * does not triage it while any `blockedBy` issue is open, and triages it the tick after the last one closes.
     * Not a defer: `maxDefers` does not count it. Schedule also parks an untriaged issue here that GitHub already
     * shows blocked. When none of the named issues is open (closed, or the link failed) it is a plain defer.
     * @param {z.infer<typeof BlockedIn>} b @param {DispatchCtx} ctx
     */
    run: async (b, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      const links = [...(issue.blockedBy ?? [])]
      for (const n of b.blockedBy) {
        if (n === issue.number || links.some((l) => l.number === n)) continue
        try {
          const { state } = await ctx.github.addBlockedBy(slug, issue.number, n)
          links.push({ number: n, state, closedAt: null })
          ctx.log('info', `linked blockedBy #${n}`, { repo: slug, issue: issue.number })
        } catch (err) {
          ctx.log('warn', `could not link blockedBy #${n}: ${errText(err)}`, { repo: slug, issue: issue.number })
        }
      }
      issue.blockedBy = links
      const open = openBlockers(issue)
      const list = b.blockedBy.map((n) => `#${n}`).join(', ')
      if (!open.length)
        return { to: 'defer', reason: `blocked by ${list}, but none is open. ${b.reason}`, log: b.log ?? '' }
      await land(
        ctx,
        'blocked',
        {
          ...withHistory(m, {
            at: iso(ctx.tick.now),
            attempt: m.attempt,
            outcome: 'blocked',
            reason: `${open.map((n) => `#${n}`).join(', ')}: ${b.reason}`,
            ...(b.log ? { log: b.log } : {}),
          }),
          deferUntil: null,
          deferReason: b.reason,
          blockedBy: open,
          host: null,
          start: null,
          input: null,
        },
        { extra: [WAIT.blocked] },
      )
      ctx.log('info', `blocked by ${open.map((n) => `#${n}`).join(', ')}: ${b.reason.split('\n')[0]}`, {
        repo: slug,
        issue: issue.number,
      })
      return { to: 'wait', blockedBy: open }
    },
  }),
  { queue: Q.intake, running: false, about: 'Rests in q:intake with wait:blocked until every blockedBy issue closes.' },
)

const ObsIn = z.object({ reason: z.string(), log: z.string() })
const closeObsolete = declare(
  defineNode({
    name: 'close-obsolete',
    input: ObsIn,
    output: Empty,
    /** Out of every queue, closed as not planned with triage's evidence. @param {z.infer<typeof ObsIn>} d @param {DispatchCtx} ctx */
    run: async (d, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      await land(
        ctx,
        'close-obsolete',
        {
          ...withHistory(m, {
            at: iso(ctx.tick.now),
            attempt: m.attempt,
            outcome: 'obsolete',
            reason: d.reason,
            log: d.log,
          }),
          host: null,
          start: null,
          input: null,
        },
        { status: 'done' },
      )
      await ctx.github.close(slug, issue.number, `Obsolete: ${d.reason}\n\nClosed by cambium.`, {
        reason: 'not_planned',
      })
      issue.state = 'CLOSED'
      ctx.log('info', 'obsolete; closed as not planned', { repo: slug, issue: issue.number })
      return {}
    },
  }),
  { queue: null, running: false, about: 'Out of every queue, closed as not planned with the evidence triage found.' },
)

/** @param {unknown} err */
const errText = (err) => /** @type {Error} */ (err)?.message ?? String(err)

/** The Dispatch phase. Bump `version` when a node is removed or renamed. */
export const dispatch = defineGraph({
  name: 'dispatch',
  about: 'Triages a q:intake issue with a one-shot read-only worker, then routes it on its verdict.',
  version: 1,
  entry: { queue: Q.intake, node: 'start-triage', input: () => ({}) },
  nodes: [startTriage, triaging, retryTriage, toTask, toHuman, closeDuplicate, deferred, blockedNode, closeObsolete],
  edges: [
    ['start-triage', 'triaging', started, (o) => ({ attempt: o.attempt })],
    ['start-triage', 'to-human', budgetSpent],
    ['start-triage', 'retry-triage'],
    ['triaging', END, issueGone],
    ['triaging', 'retry-triage', leaseLost],
    ['triaging', 'to-task', actionable, (o) => ({ ...pick(o.result, ['reason', 'title', 'acceptance']), log: o.log })],
    ['triaging', 'close-duplicate', duplicate, (o) => ({ ...pick(o.result, ['duplicateOf', 'reason']), log: o.log })],
    ['triaging', 'deferred', defer, (o) => ({ ...pick(o.result, ['reason', 'recheckHours']), log: o.log })],
    ['triaging', 'blocked', blocked, (o) => ({ blockedBy: o.result.blockedBy, reason: o.result.reason, log: o.log })],
    ['triaging', 'close-obsolete', obsolete, (o) => ({ reason: o.result.reason, log: o.log })],
    [
      'triaging',
      'to-human',
      needsHuman,
      (o) => ({
        reason: o.result.reason,
        outcome: 'needs-human',
        log: o.log,
        ...(o.result.ask ? { ask: o.result.ask } : {}),
      }),
    ],
    ['triaging', 'to-human'],
    ['retry-triage', 'start-triage', attemptsLeft, () => ({})],
    ['retry-triage', 'to-human'],
    ['to-task', END],
    ['to-human', END],
    ['close-duplicate', END],
    ['deferred', 'to-human', budgetSpent],
    ['deferred', END],
    ['blocked', 'deferred', noneOpen, (o) => ({ reason: o.reason, log: o.log })],
    ['blocked', END],
    ['close-obsolete', END],
  ],
})

/** @param {Record<string, unknown>} o @param {string[]} keys */
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))

/** @param {string} name @returns {DispatchNode} */
export function nodeOf(name) {
  const node = dispatch.nodes.find((n) => n.name === name)
  if (!node) throw new Error(`dispatch graph has no node "${name}"`)
  return /** @type {DispatchNode} */ (node)
}
