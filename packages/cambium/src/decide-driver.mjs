// @ts-check
/**
 * The hosted `decide` driver: cambium's tick advances `q:human` + `ask:decide` + `ask:session` issues through the
 * `decide` graph (graphs/decide.mjs) over a channel, so a person can decide without a terminal. The CLI/plugin
 * driver is the other one; both share the graph and the `cambium:decide` marker.
 *
 * Which issues: a repo's `decide.channel` (config.mjs) turns it on. An issue whose marker is `done`, or is live on
 * another channel (a terminal session holds it), is left alone.
 *
 * One turn per issue per tick, from the marker alone ({@link positionOf}), or from the start seeded by the issue's
 * `ask`. A turn advances until a wait holds, the graph ends, or an agent step is still running, then writes the marker
 * when it changed.
 *
 * Agent steps ({@link workerAgent}): each is a one-shot read-only `claude -p` worker whose prompt is the node and the
 * whole state from the marker; it ends with the next state as JSON. The first call starts it and the turn stops
 * there ({@link Pending}, not an error); a later tick's call reads its result once it has exited. A worker for a node
 * the decision has left is dropped.
 *
 * Channels: `github` ({@link githubChannel}) posts rounds and drafts as issue comments and reads replies from the
 * issue's comments. Only a login on the channel's allowlist (`decide.answerers.<channel>`) answers; anyone else's
 * comment is ignored and noted in the marker (`input.ignored`).
 */
import { Ask } from './ask.mjs'
import { capsFor } from './config.mjs'
import { advance } from './graph/index.mjs'
import {
  decide,
  markerAt,
  parseDecideMarker,
  positionOf,
  renderDecideMarker,
  startOf,
  State,
} from './graphs/decide.mjs'
import { parseAnswer } from './human-reply.mjs'
import { Q, WHY } from './labels.mjs'
import { parseMarker } from './marker.mjs'
import { finalJson, formatZodIssue } from './phases/dispatch.mjs'
import { iso } from './issue-state.mjs'
import { each } from './tick.mjs'
import { stopOverdue } from './workers.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./graphs/decide.mjs').DecideState} DecideState
 * @typedef {import('./graphs/decide.mjs').DecideMarker} DecideMarker
 * @typedef {import('./graphs/decide.mjs').DecideReply} DecideReply
 * @typedef {{ author: string, at: string, id: string | null }} Noted
 */

export const PHASE = 'decide'
/** The channels a hosted decision can run on. */
export const CHANNELS = /** @type {const} */ (['github'])
/** The labels of a decision to work through in a session (as briefs.mjs). */
const DECIDE_SESSION = ['ask:decide', 'ask:session']

/** An agent step still running: the turn stops at its node without an error. */
export class Pending extends Error {
  /** @param {string} node */
  constructor(node) {
    super(`${node}: agent step running`)
    this.name = 'Pending'
  }
}

/** The branch (and so the checkout directory) of a decide worker, naming the node it runs. @param {number} n @param {string} node */
export const decideBranch = (n, node) => `cambium/decide-${n}-${node}`
/** @param {number} n @param {string} branch */
const nodeOfBranch = (n, branch) => branch.slice(`cambium/decide-${n}-`.length)

// ---- which issues

/**
 * A repo's hosted decide settings: its `decide`, else the top-level one.
 * @param {import('./config.mjs').Config} config @param {string} slug
 */
export const decideFor = (config, slug) => config.repos.find((r) => r.slug === slug)?.decide ?? config.decide

/**
 * Whether the hosted driver on `channel` drives this issue now.
 * @param {Issue} issue @param {string} channel
 */
export function hosted(issue, channel) {
  if (issue.state !== 'OPEN' || !issue.labels.includes(Q.human) || issue.labels.includes(WHY.budget)) return false
  if (!DECIDE_SESSION.every((l) => issue.labels.includes(l))) return false
  const m = issue.decideComment?.marker
  return !m || (m.status !== 'done' && m.input.channel === channel)
}

/**
 * The seed of a new decision: the question, options and lens from the ask in the issue's state comment.
 * @param {string} slug @param {Issue} issue @param {string} channel
 */
export function seedOf(slug, issue, channel) {
  const ask = Ask.safeParse(issue.stateComment?.marker?.ask)
  const a = ask.success ? ask.data : null
  return {
    issue: {
      repo: slug,
      number: issue.number,
      question: a?.question ?? issue.title,
      options: (a?.options ?? []).map((o) => ({ label: o.label, detail: o.detail, cost: '' })),
    },
    lens: a?.lens ?? /** @type {const} */ ('product'),
    channel,
  }
}

// ---- the tick step

/**
 * The tick's `decide` step: one turn for every hosted decision in every repo whose `decide.channel` is set.
 * @param {Deps} deps @param {Ctx} ctx
 */
export async function driveDecisions(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    const conf = decideFor(deps.config, slug)
    if (!conf?.channel) continue
    const channel = conf.channel
    const issues = [...snap.issues.values()].filter((i) => hosted(i, channel))
    await each(
      deps,
      issues,
      (issue) => decideTurn(deps, ctx, slug, issue),
      (issue) => ({ repo: slug, issue: issue.number }),
    )
  }
}

/**
 * One turn of one hosted decision. Returns what advance did and the marker written (null: unchanged, not written).
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue
 */
export async function decideTurn(deps, ctx, slug, issue) {
  const conf = /** @type {import('./config.mjs').DecideConfig} */ (decideFor(deps.config, slug))
  const channel = /** @type {string} */ (conf.channel)
  const prev = issue.decideComment?.marker ?? null
  const at = prev ? positionOf(prev) : startOf(seedOf(slug, issue, channel))
  /** @type {Noted[]} */
  const ignored = []
  const dctx = {
    agent: workerAgent(deps, ctx, slug, issue),
    channel: githubChannel(deps, slug, issue, { answerers: conf.answerers[channel] ?? [], ignored }),
    commit: githubCommit(deps, slug, issue, ctx.snaps.get(slug)),
    now: () => deps.clock.now(),
    holder: `cambium@${channel}`,
    idleMs: conf.idleHours * 60 * 60 * 1000,
  }
  const r = await advance(decide, at, /** @type {any} */ (dctx), { maxTransitions: 32 })
  const pending = r.error?.cause instanceof Pending || r.error instanceof Pending
  const m = markerAt({ node: r.node, input: r.input, error: pending ? undefined : r.error }, dctx)
  const notes = [...m.input.ignored]
  for (const n of ignored) if (!notes.some((x) => sameNote(x, n))) notes.push(n)
  const marker = { ...m, input: { ...m.input, ignored: notes } }
  if (r.error && !pending)
    deps.log('warn', `decide: ${r.node}: ${r.error.message}`, { repo: slug, issue: issue.number })
  if (prev && same(prev, marker)) return { ...r, marker: null }
  await deps.github.writeState(slug, issue.number, issue.decideComment?.id ?? null, renderDecideMarker(marker))
  return { ...r, marker }
}

/** @param {Noted} a @param {Noted} b */
const sameNote = (a, b) => (a.id && b.id ? a.id === b.id : a.author === b.author && a.at === b.at)

/** The same marker, apart from when it was written. @param {DecideMarker} a @param {DecideMarker} b */
const same = (a, b) => JSON.stringify({ ...a, at: null }) === JSON.stringify({ ...b, at: null })

// ---- agent steps: one-shot workers

/** What each agent node asks the worker for; read-confirm is the confirm wait's read of the reply. */
const STEP = /** @type {Record<string, string>} */ ({
  open: 'Seed the decision from the issue and the state: set `frontier` to the open questions (short ids), `needFacts` to what must be looked up first, and `visual` when the options differ in what users see.',
  orient:
    'Look up every fact the open questions depend on, in the sources the lens names (product: the issue, the app, its docs; technical: the code, its interfaces and dependencies). Add each to `facts` with a source (file:line, URL, API route). Re-cost the options (`cost`). Clear `needFacts`.',
  mock: 'Hosted decisions have nowhere to serve HTML yet: leave `mocks` as it is and say in `notes` what each option would look like.',
  'ask-round':
    'Append one round to `rounds`: `n` one past the last, up to 5 questions from `frontier`, each with `id`, `title`, `text`, optional `choices`, and `rec`, a recommendation worded so that "yes" accepts it.',
  'apply-answers':
    'Map `reply.body` onto the last round\'s questions as `answers` ({ id, text }; "yes" accepts the recommendation). Move every answered id from `frontier` to `decided`, add new open questions to `frontier`, and anything that needs looking up to `needFacts`.',
  draft:
    'Write `draft`: `choice`, `inScope`, `outOfScope`, `acceptance` (checkable, at least one) and `followUps` (issues to file, { title, body }), from the decided answers and the facts.',
  'read-confirm':
    'Read `reply.body` as the answer to the draft: set `confirm` to "yes" (accept), "abandon" (stop without deciding) or "edit" (anything else; put the change asked for in `notes`).',
})

/**
 * The prompt of one decide step: the node, what it asks for, and the whole state from the marker.
 * @param {{ url: string, node: string, state: DecideState, agentsMd: string | null }} a
 */
export function decidePrompt({ url, node, state, agentsMd }) {
  const about = decide.nodes.find((n) => n.name === node)?.about ?? 'Reads the reply to the draft.'
  return [
    `You are one step of a decision cambium, the scheduler, is walking a person through on ${url}, over the`,
    `\`${state.channel}\` channel. Nobody is watching this session: never ask, never wait. You only decide; never build.`,
    '',
    `## Step: \`${node}\``,
    '',
    about,
    '',
    STEP[node] ?? '',
    '',
    'Read the code and the issue as the step needs (read-only). Do only this step: cambium posts to the channel and',
    'moves the graph on.',
    '',
    '## The decision so far',
    '',
    'The whole state, from the `cambium:decide` marker. It is all there is: nothing else carries over between steps.',
    '',
    '<state>',
    JSON.stringify(state, null, 2),
    '</state>',
    '',
    '## Output',
    '',
    'End your final message with one JSON object in a ```json block: the next state, the same shape. A field you',
    "leave out keeps its value. `lease`, `reply`, `cursor`, `ignored` and `channel` are cambium's: yours are ignored.",
    ...(agentsMd ? ['', '## AGENTS.md (the repository)', '', agentsMd] : []),
  ].join('\n')
}

/** The state fields a worker may not change. @param {DecideState} s */
const kept = (s) => ({ lease: s.lease, reply: s.reply, cursor: s.cursor, ignored: s.ignored, channel: s.channel })

/**
 * `ctx.agent` for a hosted decision: a one-shot read-only worker per step, under the `decide` phase caps. Throws
 * {@link Pending} while it runs, and an error (the marker records it; the next tick retries) on a bad result or
 * once the step's attempts are spent.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue
 */
export function workerAgent(deps, ctx, slug, issue) {
  const { config, store, spawner } = deps
  const n = issue.number
  const caps = capsFor(config, slug, PHASE)
  const tries = (/** @type {string} */ node) => `decide.${slug}#${n}.${node}.attempts`
  /** @param {string} node @param {DecideState} state */
  return async (node, state) => {
    let w = store.worker(slug, n)
    if (w && (w.phase !== PHASE || nodeOfBranch(n, w.branch) !== node)) {
      if (w.phase !== PHASE) throw new Error(`a ${w.phase} worker holds #${n}`)
      // A worker for a node the decision has left: drop it.
      deps.procs.kill(w.pid)
      await release(deps, slug, w)
      w = null
    }
    if (w) {
      if (stopOverdue({ procs: deps.procs, store, log: deps.log }, w, caps.wallClockMinutes, ctx.now) !== 'gone')
        throw new Pending(node)
      const read = w.killedReason ? { ok: false, error: w.killedReason } : finalJson(spawner.readLog(w.stdout))
      await release(deps, slug, w)
      if (!read.ok || !('json' in read))
        throw new Error(`${node} worker: ${'error' in read ? read.error : 'no result'}`)
      const next = State.safeParse({ ...state, .../** @type {object} */ (read.json), ...kept(state) })
      if (!next.success)
        throw new Error(`${node} worker: invalid state: ${next.error.issues.map(formatZodIssue).join('; ')}`)
      store.set(tries(node), '0')
      return next.data
    }
    const attempt = Number(store.get(tries(node)) ?? 0) + 1
    if (attempt > caps.maxAttempts) throw new Error(`${node}: ${caps.maxAttempts} worker attempts spent`)
    const live = store.workers().filter((x) => x.phase === PHASE).length
    if (live >= caps.cap) throw new Pending(node)
    const repo = config.repos.find((r) => r.slug === slug)
    if (!repo) throw new Error(`${slug} is not in the config`)
    const branch = decideBranch(n, node)
    const s = await spawner.start({
      repo,
      convention: spawner.convention(repo),
      issue: n,
      attempt,
      branch,
      phase: PHASE,
      maxTurns: caps.maxTurns,
      readOnly: true,
      buildPrompt: (agentsMd) => decidePrompt({ url: issue.url, node, state, agentsMd }),
    })
    store.set(tries(node), String(attempt))
    store.addWorker({
      repo: slug,
      issue: n,
      phase: PHASE,
      pid: s.pid,
      worktree: s.worktree,
      branch,
      attempt,
      startedAt: ctx.now,
      host: config.host,
      stdout: s.stdout,
      stderr: s.stderr,
      traceparent: null,
    })
    deps.log('info', `started decide worker pid ${s.pid} at ${node} (attempt ${attempt})`, { repo: slug, issue: n })
    throw new Pending(node)
  }
}

/** @param {Deps} deps @param {string} slug @param {import('./store.mjs').Worker} w */
async function release(deps, slug, w) {
  deps.store.removeWorker(slug, w.issue)
  const repo = deps.config.repos.find((r) => r.slug === slug)
  if (!repo) return
  const t = await deps.spawner.cleanup({ repo, worktree: w.worktree, branch: w.branch, readOnly: true })
  if (!t.removed) deps.log('warn', `kept worktree ${w.worktree}: ${t.reason}`, { repo: slug, issue: w.issue })
}

// ---- the GitHub-comment channel

const POST_RE = /<!-- cambium:decide-post (.*?) -->/s

/** A post's tag: its kind and the reply it follows, so a re-run step does not post twice. @param {string | null | undefined} body */
export function parsePostTag(body) {
  const m = POST_RE.exec(body ?? '')
  if (!m) return null
  try {
    const t = JSON.parse(m[1])
    return typeof t?.kind === 'string' && typeof t?.after === 'string' ? { kind: t.kind, after: t.after } : null
  } catch {
    return null
  }
}

/** What a post follows: the reply consumed last, or the decision's start. @param {DecideState} s */
const afterOf = (s) => (s.cursor ? (s.cursor.id ?? `${s.cursor.author}@${s.cursor.at}`) : `start@${s.lease?.at ?? ''}`)

/** @param {{ id: string, title: string, text: string, choices?: string[], rec: string }} q @param {number} i */
const question = (q, i) =>
  [
    `**${i + 1}. ${q.title}**`,
    '',
    q.text,
    ...(q.choices?.length ? ['', ...q.choices.map((c) => `- ${c}`)] : []),
    '',
    `Recommended: ${q.rec}`,
  ].join('\n')

/**
 * A post's comment body: a round of questions or a draft, how to reply, and the hidden tag.
 * @param {any} msg `{ round }` or `{ draft }` @param {DecideState} s
 */
export function renderPost(msg, s) {
  const kind = msg.round ? 'round' : 'draft'
  const tag = `<!-- cambium:decide-post ${JSON.stringify({ kind, after: afterOf(s) }).replace(/--/g, '-\\u002d')} -->`
  if (msg.round)
    return [
      `### Decision, round ${msg.round.n}: ${s.issue.question}`,
      '',
      ...msg.round.questions.flatMap((/** @type {any} */ q, /** @type {number} */ i) => [question(q, i), '']),
      'Reply in one comment, by number (`1 yes`, `2 the second option, because…`); "yes" alone accepts every',
      'recommendation. `stop` abandons the decision.',
      '',
      tag,
    ].join('\n')
  const d = msg.draft
  const list = (/** @type {string[]} */ xs) => (xs.length ? xs.map((x) => `- ${x}`) : ['- (none)'])
  return [
    `### Decision draft: ${s.issue.question}`,
    '',
    `**Choice:** ${d.choice}`,
    '',
    '**In scope**',
    ...list(d.inScope),
    '',
    '**Out of scope**',
    ...list(d.outOfScope),
    '',
    '**Acceptance checks**',
    ...d.acceptance.map((/** @type {string} */ a) => `- [ ] ${a}`),
    '',
    '**Follow-up issues**',
    ...list(d.followUps.map((/** @type {any} */ f) => f.title)),
    '',
    'Reply `yes` to commit it, say what to change to redraft, or `abandon`.',
    '',
    tag,
  ].join('\n')
}

/** cambium's own comments on a decision: markers, posts, answers. They are never replies. @param {string} body */
const ours = (body) => !!(parseDecideMarker(body) || parsePostTag(body) || parseMarker(body) || parseAnswer(body))

/** Comment order: time, then id. @param {{ at: string, id: string | null }} a @param {{ at: string, id: string | null }} b */
const after = (a, b) => {
  const d = Date.parse(a.at) - Date.parse(b.at)
  return d !== 0 ? d > 0 : Number(a.id ?? 0) > Number(b.id ?? 0)
}

/**
 * The GitHub-comment channel of one issue, over the tick's snapshot (its newest 20 comments).
 *
 * - `post(msg, s)`: a round or a draft as an issue comment, tagged with the reply it follows; skipped when the
 *   snapshot already holds a post of that kind after that reply (a step re-run after a lost marker write).
 * - `poll(s)`: the first comment after `s.cursor` (or the lease's start) by a login on `answerers`, as a reply. A
 *   comment by anyone else is skipped and pushed to `ignored` (once; the driver notes it in the marker). cambium's
 *   own comments and the bot's are skipped silently.
 *
 * @param {Deps} deps @param {string} slug @param {Issue} issue
 * @param {{ answerers: string[], ignored: Noted[] }} opts
 */
export function githubChannel(deps, slug, issue, { answerers, ignored }) {
  const comments = issue.comments ?? []
  const allowed = new Set(answerers.map((a) => a.toLowerCase()))
  const bot = deps.config.graft.botLogin?.toLowerCase() ?? null
  return {
    /** @param {unknown} msg @param {DecideState} s */
    async post(msg, s) {
      const body = renderPost(msg, s)
      const tag = parsePostTag(body)
      if (
        comments.some((c) => {
          const t = parsePostTag(c.body)
          return t?.kind === tag?.kind && t?.after === tag?.after
        })
      )
        return
      await deps.github.comment(slug, issue.number, body)
    },
    /** @param {DecideState} s @returns {Promise<DecideReply | null>} */
    async poll(s) {
      const since = s.cursor ?? { at: s.lease?.at ?? new Date(0).toISOString(), id: null }
      for (const c of comments) {
        const id = c.id === undefined ? null : String(c.id)
        if (!c.author || ours(c.body) || !after({ at: c.createdAt, id }, since)) continue
        if (bot && c.author.toLowerCase() === bot) continue
        if (allowed.has(c.author.toLowerCase()))
          return { author: c.author, at: c.createdAt, channel: 'github', body: c.body, ...(id ? { id } : {}) }
        const note = { author: c.author, at: c.createdAt, id }
        if (!s.ignored.some((x) => sameNote(x, note)) && !ignored.some((x) => sameNote(x, note))) {
          ignored.push(note)
          deps.log('info', `decide: ignored a reply from ${c.author} (not an answerer)`, {
            repo: slug,
            issue: issue.number,
          })
        }
      }
      return null
    },
  }
}

/**
 * `ctx.commit` on GitHub: files the follow-ups as `q:intake` (one already open under the same title is not filed
 * again), then posts the answer comment (`cambium:answer`, which wakes the issue back into triage once the marker is
 * done). Re-run after a lost marker write, it posts no second answer.
 * @param {Deps} deps @param {string} slug @param {Issue} issue
 * @param {import('./github.mjs').Snapshot | undefined} snap
 */
export function githubCommit(deps, slug, issue, snap) {
  /** @param {DecideState} s */
  return async (s) => {
    const d = s.draft
    if (!d) throw new Error('commit: no draft')
    const since = Date.parse(s.lease?.at ?? '1970-01-01T00:00:00Z')
    const answered = (issue.comments ?? []).some(
      (c) => parseAnswer(c.body)?.graph === 'decide' && Date.parse(c.createdAt) >= since,
    )
    if (answered) return { ...s, answerUrl: issue.url }
    const open = new Map([...(snap?.issues.values() ?? [])].filter((i) => i.state === 'OPEN').map((i) => [i.title, i]))
    /** @type {{ title: string, url: string }[]} */
    const filed = []
    for (const f of d.followUps) {
      const there = open.get(f.title)
      if (there) {
        filed.push({ title: f.title, url: there.url })
        continue
      }
      const made = await deps.github.createIssue(slug, {
        title: f.title,
        body: `${f.body}\n\nFrom the decision on #${issue.number}.`,
        labels: [Q.intake],
      })
      filed.push({ title: f.title, url: made.url })
    }
    const answerer = s.cursor?.author ?? 'unknown'
    const payload = JSON.stringify({ graph: 'decide', decideAt: iso(deps.clock.now()), answerer })
    const body = [
      `**Decided** by ${answerer} (${s.channel}): ${d.choice}`,
      '',
      '**In scope**',
      ...d.inScope.map((x) => `- ${x}`),
      '',
      '**Out of scope**',
      ...d.outOfScope.map((x) => `- ${x}`),
      '',
      '**Acceptance checks**',
      ...d.acceptance.map((x) => `- [ ] ${x}`),
      ...(filed.length ? ['', '**Follow-ups**', ...filed.map((f) => `- ${f.url}`)] : []),
      '',
      `<!-- cambium:answer ${payload} -->`,
    ].join('\n')
    await deps.github.comment(slug, issue.number, body)
    return { ...s, answerUrl: issue.url }
  }
}
