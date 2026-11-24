// @ts-check
/**
 * The `decide` graph: an interactive decision for a `q:human` issue carrying `ask:decide` + `ask:session`. It walks
 * a person to a decision and writes it back. It only decides: it never builds.
 *
 * Channel-agnostic: step nodes are agent work, waits are the person's turns on whatever channel hosts the session
 * (Claude Code terminal, GitHub comments, Discord, web chat). Nodes call only what the driver injects:
 *
 *   ctx.agent(node, state)   a schema-checked agent turn; returns the next state
 *   ctx.channel.post(msg, s) posts to the channel (`s`: the state after the step, for the channel's idempotence)
 *   ctx.channel.poll(state)  the next reply from an allowed answerer after `state.cursor`, or null
 *   ctx.commit(state)        deterministic: files follow-ups as `q:intake`, posts the `cambium:answer` comment
 *   ctx.now()                ms clock (default `Date.now`)
 *   ctx.holder, ctx.idleMs   who takes the lease at `open`, and its idle timeout (default {@link IDLE_MS})
 *
 * No driver lives here: the hosted one (the tick, over a channel) is decide-driver.mjs; the CLI/plugin one is its own.
 *
 * The checkpoint after every stop is the `cambium:decide` marker: one comment on the issue, edited in place, holding
 * the whole state, the node and a status (`leased` | `paused` | `done`). {@link driveDecide} writes it before any
 * label change, and a fresh driver resumes from it alone ({@link positionOf}). While the marker is live (not
 * `done`) dispatch leaves the issue alone: no human-reply wake and no stall re-triage ({@link isLiveDecision}).
 *
 * Lease: `open` records who holds the decision and when the channel was last active. A wait that sees no reply for
 * `lease.idleMs` moves to `paused`, which holds until the next reply and then resumes the wait it left.
 *
 * `lens` (`product` | `technical`) says what kind of decision it is. It changes what `orient` researches and the
 * template `draft` writes; it never changes the graph. `mock` runs only when the ask has visual aspects.
 */
import { z } from 'zod'
import { advance, defineGraph, defineNode, defineWait, END } from '../graph/index.mjs'

/** Default idle timeout of a lease: a day without a reply pauses the decision. */
export const IDLE_MS = 24 * 60 * 60 * 1000

// ---- schemas: the state is the union of these, carried whole in the marker ----

export const Fact = z.object({ claim: z.string(), source: z.string() }) // source: file:line, URL, API route
export const Option = z.object({ label: z.string(), detail: z.string(), cost: z.string() })
export const Question = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  choices: z.array(z.string()).optional(),
  rec: z.string(), // worded so "yes" accepts
})
const Round = z.object({ n: z.number(), questions: z.array(Question).min(1).max(5) })
export const Answer = z.object({ id: z.string(), text: z.string() })
const Reply = z.object({
  author: z.string(),
  at: z.string(),
  channel: z.string(),
  body: z.string(),
  id: z.string().optional(),
})
/** Where a channel's replies were last consumed up to: the reply's author, time and channel id (if it has one). */
const Cursor = z.object({ author: z.string(), at: z.string(), id: z.string().nullable() })
export const Decision = z.object({
  choice: z.string(),
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  acceptance: z.array(z.string()).min(1),
  followUps: z.array(z.object({ title: z.string(), body: z.string() })),
})
const Lease = z.object({ holder: z.string(), at: z.string(), activeAt: z.string(), idleMs: z.number().positive() })

/**
 * Every node's input and output: the whole decision, what a fresh driver needs to resume without asking anything
 * already answered.
 */
export const State = z.object({
  issue: z.object({ repo: z.string(), number: z.number(), question: z.string(), options: z.array(Option) }),
  lens: z.enum(['product', 'technical']),
  channel: z.string(),
  lease: Lease.nullable().default(null),
  paused: z.enum(['await-answers', 'confirm']).nullable().default(null),
  facts: z.array(Fact).default([]),
  visual: z.boolean().default(false),
  mocks: z.array(z.object({ option: z.string(), url: z.string() })).default([]),
  rounds: z.array(Round.extend({ answers: z.array(Answer).default([]) })).default([]),
  decided: z.array(z.string()).default([]),
  frontier: z.array(z.string()).default([]),
  needFacts: z.array(z.string()).default([]),
  draft: Decision.nullable().default(null),
  confirm: z.enum(['pending', 'yes', 'edit', 'abandon']).default('pending'),
  notes: z.string().default(''),
  reply: Reply.nullable().default(null),
  cursor: Cursor.nullable().default(null),
  ignored: z.array(Cursor).default([]),
  answerUrl: z.string().nullable().default(null),
})

/** @typedef {z.infer<typeof State>} DecideState */
/**
 * @typedef {{ author: string, at: string, channel: string, body: string, id?: string }} DecideReply
 * @typedef {{
 *   agent: (node: string, state: DecideState) => Promise<unknown>,
 *   channel: {
 *     post: (msg: unknown, state: DecideState) => Promise<unknown>,
 *     poll: (state: DecideState) => Promise<DecideReply | null>,
 *   },
 *   commit: (state: DecideState) => Promise<unknown>,
 *   now?: () => number, holder?: string, idleMs?: number,
 * }} DecideCtx
 */

/** @param {DecideCtx} ctx */
const nowIso = (ctx) => new Date((ctx.now ?? Date.now)()).toISOString()

/** The lease with `activeAt` moved to now. @param {DecideState} s @param {DecideCtx} ctx */
const touched = (s, ctx) => (s.lease ? { ...s, lease: { ...s.lease, activeAt: nowIso(ctx) } } : s)

/**
 * A reply taken from the channel: the state carries it, and the cursor moves past it, so the channel's next poll
 * starts after it. @param {DecideState} s @param {DecideReply} reply @returns {DecideState}
 */
const consumed = (s, reply) => ({ ...s, reply, cursor: { author: reply.author, at: reply.at, id: reply.id ?? null } })

/** No channel activity for the lease's idle timeout. @param {DecideState} s @param {DecideCtx} ctx */
const idleFor = (s, ctx) => !!s.lease && (ctx.now ?? Date.now)() - Date.parse(s.lease.activeAt) >= s.lease.idleMs

/**
 * @template N @param {N} node @param {string} text @returns {N & { about: string }}
 */
const about = (node, text) => Object.freeze({ ...node, about: text })

/**
 * A step: agent work (or plain code). Every step is channel activity, so it refreshes the lease.
 * @param {string} name @param {(s: DecideState, ctx: DecideCtx) => Promise<any>} run
 */
const step = (name, run) =>
  defineNode({
    name,
    input: State,
    output: State,
    run: async (/** @type {DecideState} */ s, /** @type {DecideCtx} */ ctx) =>
      touched(State.parse(await run(s, ctx)), ctx),
  })

/**
 * A person's turn: ready on a reply (one carried in from `paused` first), or idle past the lease → `paused`.
 * @param {'await-answers' | 'confirm'} name
 * @param {(s: DecideState, reply: DecideReply, ctx: DecideCtx) => Promise<any>} onReply
 */
const turn = (name, onReply) =>
  defineWait({
    name,
    input: State,
    output: State,
    poll: async (/** @type {DecideState} */ s, /** @type {DecideCtx} */ ctx) => {
      const reply = s.reply ?? (await ctx.channel.poll(s))
      if (reply)
        return { ready: true, output: touched(State.parse(await onReply(consumed(s, reply), reply, ctx)), ctx) }
      if (idleFor(s, ctx)) return { ready: true, output: { ...s, paused: name } }
      return { ready: false }
    },
  })

// ---- nodes ----

const open = step('open', async (s, ctx) => {
  const next = State.parse(await ctx.agent('open', s))
  const at = nowIso(ctx)
  return { ...next, lease: { holder: ctx.holder ?? 'cambium', at, activeAt: at, idleMs: ctx.idleMs ?? IDLE_MS } }
})
const orient = step('orient', async (s, ctx) => ctx.agent('orient', s))
const mock = step('mock', async (s, ctx) => ctx.agent('mock', s))
const askRound = step('ask-round', async (s, ctx) => {
  const next = State.parse(await ctx.agent('ask-round', s))
  await ctx.channel.post({ round: next.rounds.at(-1) }, next)
  return next
})
const awaitAnswers = turn('await-answers', async (s, reply) => ({ ...s, reply }))
const applyAnswers = step('apply-answers', async (s, ctx) => ({
  ...State.parse(await ctx.agent('apply-answers', s)),
  reply: null,
}))
const draft = step('draft', async (s, ctx) => {
  const next = State.parse(await ctx.agent('draft', s))
  await ctx.channel.post({ draft: next.draft }, next)
  return { ...next, confirm: 'pending' }
})
const confirm = turn('confirm', async (s, reply, ctx) => ({
  ...State.parse(await ctx.agent('read-confirm', { ...s, reply })),
  reply: null,
}))
const commit = step('commit', async (s, ctx) => ctx.commit(s))
const abandon = step('abandon', async (s) => ({ ...s, confirm: 'abandon' }))
const paused = defineWait({
  name: 'paused',
  input: State,
  output: State,
  poll: async (/** @type {DecideState} */ s, /** @type {DecideCtx} */ ctx) => {
    const reply = await ctx.channel.poll(s)
    return reply ? { ready: true, output: touched(consumed(s, reply), ctx) } : { ready: false }
  },
})

// ---- edge conditions (named: toMermaid and describeGraph label edges with the function name) ----

/** @param {DecideState} s */
const visual = (s) => s.visual
/** @param {DecideState} s */
const idle = (s) => s.paused !== null
/** @param {DecideState} s */
const needsFacts = (s) => s.needFacts.length > 0
/** @param {DecideState} s */
const settled = (s) => s.frontier.length === 0
/** @param {DecideState} s */
const accepted = (s) => s.confirm === 'yes'
/** @param {DecideState} s */
const edited = (s) => s.confirm === 'edit'
/** @param {DecideState} s */
const abandoned = (s) => s.confirm === 'abandon' || /^\s*(stop|abandon)\b/i.test(s.reply?.body ?? '')
/** @param {DecideState} s */
const atConfirm = (s) => s.paused === 'confirm'
/** Back to the wait it left, with the reply that woke it. @param {DecideState} s */
const resume = (s) => ({ ...s, paused: null })

export const decide = defineGraph({
  name: 'decide',
  version: 1,
  about: 'Walks a person to a decision on a q:human ask:decide + ask:session issue, on any channel; never builds.',
  entry: { queue: 'q:human', node: 'open' },
  nodes: [
    about(open, 'Takes the lease and seeds the decision from the issue and its session brief.'),
    about(orient, 'Facts the ask depends on, from the sources the lens names, each with a source; re-costs options.'),
    about(mock, 'Static HTML for each option; only when the ask is visual.'),
    about(askRound, 'Up to 5 numbered questions, each with a recommendation worded so "yes" accepts; posts them.'),
    about(awaitAnswers, 'Holds for the next reply on the channel; idle past the lease, pauses.'),
    about(applyAnswers, 'Maps the reply onto the questions and recomputes what is decided and what is left.'),
    about(draft, 'Writes the decision: choice, in and out of scope, acceptance checks, follow-up issues.'),
    about(confirm, 'Holds for yes, edit or abandon on the draft; idle past the lease, pauses.'),
    about(commit, 'Files the follow-ups as q:intake and posts the answer comment.'),
    about(abandon, 'Ends without an answer; the issue stays in q:human.'),
    about(paused, 'An idle decision: holds until the next reply, then resumes the wait it left.'),
  ],
  edges: [
    ['open', 'orient'],
    ['orient', 'mock', visual],
    ['orient', 'ask-round'],
    ['mock', 'ask-round'],
    ['ask-round', 'await-answers'],
    ['await-answers', 'paused', idle],
    ['await-answers', 'abandon', abandoned],
    ['await-answers', 'apply-answers'],
    ['apply-answers', 'orient', needsFacts],
    ['apply-answers', 'draft', settled],
    ['apply-answers', 'ask-round'],
    ['draft', 'confirm'],
    ['confirm', 'paused', idle],
    ['confirm', 'commit', accepted],
    ['confirm', 'abandon', abandoned],
    ['confirm', 'draft', edited],
    ['confirm', 'draft'],
    ['paused', 'confirm', atConfirm, resume],
    ['paused', 'await-answers', null, resume],
    ['commit', END],
    ['abandon', END],
  ],
})

// ---- the marker: the checkpoint after every stop ----

/**
 * @typedef {'leased' | 'paused' | 'done'} DecideStatus
 * @typedef {{
 *   v: 1, graph: 'decide', graphVersion: number, node: string, status: DecideStatus,
 *   outcome: 'answered' | 'abandoned' | null, at: string, error: string | null, input: DecideState,
 * }} DecideMarker
 *   `node`/`input`: the position to resume from (`node` is END once done). `outcome`: set once done. `error`: the
 *   node error the last turn stopped on, if any; resuming retries that node.
 */

const PREFIX = '<!-- cambium:decide '
const RE = /<!-- cambium:decide (.*?) -->/s

/**
 * The position a fresh driver starts a decision at.
 * @param {{ issue: DecideState['issue'], lens: DecideState['lens'], channel: string }} seed
 * @returns {{ node: string, input: DecideState }}
 */
export const startOf = (seed) => ({ node: decide.entry.node, input: State.parse(seed) })

/**
 * The marker for where a turn stopped.
 * @param {{ node: string, input: unknown, error?: { message: string } }} stopped @param {DecideCtx} ctx
 * @returns {DecideMarker}
 */
export function markerAt(stopped, ctx) {
  const input = State.parse(stopped.input)
  const done = stopped.node === END
  return {
    v: 1,
    graph: 'decide',
    graphVersion: decide.version,
    node: stopped.node,
    status: done ? 'done' : stopped.node === 'paused' ? 'paused' : 'leased',
    outcome: done ? (input.confirm === 'abandon' ? 'abandoned' : 'answered') : null,
    at: nowIso(ctx),
    error: stopped.error?.message ?? null,
    input,
  }
}

const SAYS = /** @type {const} */ ({
  leased: 'Decision in progress',
  paused: 'Decision paused (idle); a reply resumes it',
  done: 'Decision done',
})

/**
 * The comment body: one readable line, then the hidden JSON. `--` inside the JSON would end the HTML comment early,
 * so it is written as a JSON escape.
 * @param {DecideMarker} m
 */
export function renderDecideMarker(m) {
  const json = JSON.stringify(m).replace(/--/g, '-\\u002d')
  const where = m.status === 'done' ? (m.outcome ?? 'done') : `at \`${m.node}\``
  return `**${SAYS[m.status]}** (${m.input.lens}): ${where}.\n\n${PREFIX}${json} -->`
}

/**
 * The marker in a comment body, or null when there is none or it does not parse as a decide marker.
 * @param {string | null | undefined} body @returns {DecideMarker | null}
 */
export function parseDecideMarker(body) {
  const m = RE.exec(body ?? '')
  if (!m) return null
  try {
    const raw = JSON.parse(m[1])
    if (raw?.v !== 1 || raw.graph !== 'decide' || typeof raw.node !== 'string') return null
    if (!['leased', 'paused', 'done'].includes(raw.status)) return null
    const input = State.safeParse(raw.input)
    if (!input.success) return null
    return { ...raw, outcome: raw.outcome ?? null, error: raw.error ?? null, input: input.data }
  } catch {
    return null
  }
}

/** Where to resume: the marker alone. @param {DecideMarker} m */
export const positionOf = (m) => ({ node: m.node, input: m.input })

/** A decision is live while it is leased or paused; dispatch leaves its issue alone. @param {DecideMarker | null | undefined} m */
export const isLiveDecision = (m) => !!m && m.status !== 'done'

/**
 * One turn of a decision: advance from `at` until a wait holds or the graph ends, then write the marker, and only
 * then the labels (when the driver changes any). A node error is not thrown: the marker records it at the failed
 * node, so the next turn retries from there.
 * @param {{ node: string, input: unknown }} at
 * @param {DecideCtx} ctx
 * @param {{ writeMarker: (m: DecideMarker) => Promise<unknown>, setLabels?: (m: DecideMarker) => Promise<unknown> }} io
 * @param {{ maxTransitions?: number }} [opts]
 */
export async function driveDecide(at, ctx, io, { maxTransitions = 32 } = {}) {
  const r = await advance(decide, at, /** @type {any} */ (ctx), { maxTransitions })
  const marker = markerAt(r, ctx)
  await io.writeMarker(marker)
  if (io.setLabels) await io.setLabels(marker)
  return { ...r, marker }
}
