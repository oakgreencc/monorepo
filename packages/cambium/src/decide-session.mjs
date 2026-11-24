// @ts-check
/**
 * The terminal driver of the `decide` graph (graphs/decide.mjs): `cambium decide advance|show`, which the
 * `/oakgreen:decide` plugin skill runs from a live Claude Code session. The session does the agent steps and
 * talks to the person; cambium enforces the schemas, the edges and the `cambium:decide` marker.
 *
 * One `advance` takes the session's output for the node the marker is at ({@link sessionNode}), checks it against
 * that node's output schema ({@link OUTPUTS}) and the state ({@link checkOutput}), and refuses it with every issue
 * listed, leaving the marker as it was. An accepted output runs that node, follows the edges through the nodes
 * cambium runs itself (`commit`, `abandon`) and stops at the next node that needs the session: an agent step, or a
 * person's turn with no reply yet. Then it writes the marker, and the next `advance` resumes from the marker alone.
 *
 * Each decision has a folder, `<paths.home>/decide/<owner>__<repo>/issue-<n>/`: a copy of the last checkpoint
 * (`checkpoint.md`) and, for a visual ask, the option mocks as static HTML (`mocks/<option>.html`), which the round
 * links ({@link describePosition}).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ASK_LENSES } from './ask.mjs'
import { advance, END } from './graph/index.mjs'
import {
  Answer,
  Decision,
  decide,
  Fact,
  markerAt,
  Option,
  positionOf,
  Question,
  renderDecideMarker,
  startOf,
} from './graphs/decide.mjs'
import { renderAnswerMarker } from './human-reply.mjs'

/**
 * @typedef {import('./graphs/decide.mjs').DecideState} DecideState
 * @typedef {import('./graphs/decide.mjs').DecideMarker} DecideMarker
 * @typedef {{ node: string, input: DecideState }} DecidePosition
 */

const text = z.string().trim().min(1)
const Reply = z.object({ reply: text, author: text.optional() })
const Asked = Question.extend({ id: text, title: text, text: text, rec: text })

/**
 * What the session hands `advance` at each node it works: only the fields that node sets; cambium merges them
 * into the state ({@link merge}). Unknown keys are refused, so a misspelt field is not silently dropped.
 */
export const OUTPUTS = Object.freeze({
  open: z
    .object({
      question: text.optional(),
      options: z.array(Option).optional(),
      lens: z.enum(ASK_LENSES).optional(),
      visual: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .strict(),
  orient: z
    .object({
      facts: z.array(Fact.extend({ claim: text, source: text })),
      frontier: z.array(text).min(1),
      options: z.array(Option).optional(),
      visual: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .strict(),
  mock: z.object({ mocks: z.array(z.object({ option: text, html: text }).strict()).min(1) }).strict(),
  'ask-round': z.object({ questions: z.array(Asked).min(1).max(5) }).strict(),
  'await-answers': Reply.strict(),
  'apply-answers': z
    .object({
      answers: z.array(Answer.extend({ id: text, text: text })).min(1),
      decided: z.array(text),
      frontier: z.array(text),
      needFacts: z.array(text).optional(),
      notes: z.string().optional(),
    })
    .strict(),
  draft: z.object({ draft: Decision.extend({ choice: text }) }).strict(),
  confirm: Reply.extend({ confirm: z.enum(['yes', 'edit', 'abandon']), notes: z.string().optional() }).strict(),
})

/** @typedef {keyof typeof OUTPUTS} SessionNode */

/**
 * The node whose output the session gives next, or null when cambium runs the position itself (`commit`/`abandon`
 * after an error) or the decision is done. `paused` takes the output of the wait it left.
 * @param {DecidePosition} pos @returns {SessionNode | null}
 */
export function sessionNode(pos) {
  const name = pos.node === 'paused' ? (pos.input.paused ?? 'await-answers') : pos.node
  return Object.hasOwn(OUTPUTS, name) ? /** @type {SessionNode} */ (name) : null
}

/** The open questions of every round: asked, not answered and not decided. @param {DecideState} s */
const unanswered = (s) =>
  s.rounds.flatMap((r) =>
    r.questions
      .filter((q) => !r.answers.some((a) => a.id === q.id) && !s.decided.includes(q.id))
      .map((q) => `round ${r.n} question ${q.id} ("${q.title}") has no answer`),
  )

/**
 * What still stops the decision from being committed; empty when it is complete. Checked before `commit`: a
 * `yes` at `confirm` on an incomplete decision is refused.
 * @param {DecideState} s @returns {string[]}
 */
export function completeness(s) {
  const gaps = []
  if (!s.draft) gaps.push('no draft yet')
  if (s.frontier.length) gaps.push(`still open: ${s.frontier.join(', ')}`)
  if (s.needFacts.length) gaps.push(`facts still needed: ${s.needFacts.join(', ')}`)
  gaps.push(...unanswered(s))
  if (s.draft && !s.draft.inScope.length) gaps.push('the draft puts nothing in scope')
  for (const [i, f] of (s.draft?.followUps ?? []).entries())
    if (!f.title.trim() || !f.body.trim()) gaps.push(`follow-up ${i + 1} needs a title and a body`)
  if (s.visual && !s.mocks.length) gaps.push('a visual ask with no mocks')
  return gaps
}

/**
 * Checks of an output against the state it lands on, past its schema. @param {SessionNode} node
 * @param {DecideState} s @param {any} out @returns {string[]}
 */
export function checkOutput(node, s, out) {
  if (node === 'ask-round') {
    const ids = out.questions.map((/** @type {{ id: string }} */ q) => q.id)
    const dup = ids.filter((/** @type {string} */ id, /** @type {number} */ i) => ids.indexOf(id) !== i)
    return dup.length ? [`questions: ids must be unique (${[...new Set(dup)].join(', ')})`] : []
  }
  if (node === 'apply-answers') {
    const asked = new Set(s.rounds.at(-1)?.questions.map((q) => q.id) ?? [])
    return out.answers
      .filter((/** @type {{ id: string }} */ a) => !asked.has(a.id))
      .map((/** @type {{ id: string }} */ a) => `answers: ${a.id} is not a question of the last round`)
  }
  if (node === 'confirm' && out.confirm === 'yes') return completeness(s).map((g) => `completeness: ${g}`)
  return []
}

/** @param {z.ZodError} err @returns {string[]} */
const zodIssues = (err) => err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))

/** @param {string[]} xs @param {string[]} ys */
const union = (xs, ys) => [...new Set([...xs, ...ys])]

/** A file name for an option's mock. @param {string} label */
const slugOf = (label) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'option'

/**
 * The state after the session's output for `node` (the agent node: `read-confirm` for `confirm`).
 * @param {string} node @param {DecideState} s @param {any} out @param {{ saveMock: (option: string, html: string) => string }} env
 * @returns {DecideState}
 */
function merge(node, s, out, env) {
  const notes = out.notes !== undefined ? { notes: out.notes } : {}
  switch (node) {
    case 'open':
      return {
        ...s,
        issue: { ...s.issue, question: out.question ?? s.issue.question, options: out.options ?? s.issue.options },
        lens: out.lens ?? s.lens,
        visual: out.visual ?? s.visual,
        ...notes,
      }
    case 'orient': {
      const seen = new Set(s.facts.map((f) => f.claim))
      return {
        ...s,
        issue: { ...s.issue, options: out.options ?? s.issue.options },
        facts: [...s.facts, ...out.facts.filter((/** @type {{ claim: string }} */ f) => !seen.has(f.claim))],
        frontier: out.frontier,
        needFacts: [],
        visual: out.visual ?? s.visual,
        ...notes,
      }
    }
    case 'mock':
      return {
        ...s,
        mocks: out.mocks.map((/** @type {{ option: string, html: string }} */ m) => ({
          option: m.option,
          url: env.saveMock(m.option, m.html),
        })),
      }
    case 'ask-round':
      return { ...s, rounds: [...s.rounds, { n: s.rounds.length + 1, questions: out.questions, answers: [] }] }
    case 'apply-answers': {
      const last = s.rounds.at(-1)
      if (!last) return s
      const given = new Map(out.answers.map((/** @type {{ id: string, text: string }} */ a) => [a.id, a]))
      const answers = [...last.answers.filter((a) => !given.has(a.id)), ...given.values()]
      return {
        ...s,
        rounds: [...s.rounds.slice(0, -1), { ...last, answers }],
        decided: union(s.decided, out.decided),
        frontier: out.frontier,
        needFacts: out.needFacts ?? [],
        ...notes,
      }
    }
    case 'draft':
      return { ...s, draft: out.draft }
    case 'read-confirm':
      return { ...s, confirm: out.confirm, ...notes }
  }
  throw new Error(`${node} is not a session node`)
}

/**
 * The decision's folder: the checkpoint copy and the mocks.
 * @param {string} home @param {string} slug @param {number} number
 */
export const decisionDir = (home, slug, number) => join(home, 'decide', slug.replace('/', '__'), `issue-${number}`)

/**
 * @typedef {{
 *   github: Pick<import('./github.mjs').GitHub, 'readIssues' | 'writeState' | 'createIssue'>,
 *   slug: string, number: number, home: string, holder: string, now?: () => number, lens?: string,
 * }} DecideDeps
 *   `holder`: the person's GitHub login: the lease holder, the default reply author and the answer's `answerer`.
 *   `lens`: when the issue's ask names none, for a decision not started yet.
 */

/**
 * The issue and where its decision stands: the marker's position, or the start seeded from the issue's ask.
 * @param {DecideDeps} d
 */
export async function load(d) {
  const issue = (await d.github.readIssues(d.slug, [d.number])).get(d.number)
  if (!issue) return { ok: /** @type {const} */ (false), error: `${d.slug}#${d.number}: no such issue` }
  const comment = issue.decideComment ?? null
  if (comment)
    return { ok: /** @type {const} */ (true), issue, comment, marker: comment.marker, pos: positionOf(comment.marker) }
  const ask = /** @type {any} */ (issue.stateComment?.marker)?.ask ?? null
  const lens = ASK_LENSES.find((l) => l === (d.lens ?? ask?.lens))
  if (!lens)
    return {
      ok: /** @type {const} */ (false),
      error: `${d.slug}#${d.number}: its ask names no lens; pass --lens ${ASK_LENSES.join('|')}`,
    }
  const seed = {
    issue: {
      repo: d.slug,
      number: d.number,
      question: ask?.question ?? issue.title,
      options: (ask?.options ?? []).map((/** @type {{ label: string, detail?: string }} */ o) => ({
        label: o.label,
        detail: o.detail ?? '',
        cost: '',
      })),
    },
    lens,
    channel: 'terminal',
  }
  return { ok: /** @type {const} */ (true), issue, comment: null, marker: null, pos: startOf(seed) }
}

/**
 * The `commit` node: files each follow-up as `q:intake`, then posts the decision as the `cambium:answer` comment
 * (human-reply.mjs), which sends the issue back to triage once the marker is done.
 * @param {DecideDeps} d @param {{ url: string }} issue @param {DecideState} s
 */
async function commitDecision(d, issue, s) {
  const draft = /** @type {NonNullable<DecideState['draft']>} */ (s.draft)
  const at = new Date((d.now ?? Date.now)()).toISOString()
  const filed = []
  for (const f of draft.followUps) {
    const body = `${f.body}\n\nFollow-up of the decision on ${d.slug}#${d.number}.`
    filed.push({ ...f, ...(await d.github.createIssue(d.slug, { title: f.title, body, labels: ['q:intake'] })) })
  }
  const list = (/** @type {string[]} */ xs) => (xs.length ? xs.map((x) => `- ${x}`) : ['- none'])
  const body = [
    `**Decision** (${s.lens}): ${draft.choice}`,
    '',
    '**In scope**',
    ...list(draft.inScope),
    '',
    '**Out of scope**',
    ...list(draft.outOfScope),
    '',
    '**Acceptance checks**',
    ...draft.acceptance.map((a) => `- [ ] ${a}`),
    ...(filed.length
      ? ['', '**Follow-ups** (filed to `q:intake`)', ...filed.map((f) => `- #${f.number} ${f.title}`)]
      : []),
    '',
    `Decided by @${d.holder} in a decide session.`,
    '',
    renderAnswerMarker({ graph: 'decide', decideAt: at, answerer: d.holder }),
  ].join('\n')
  const id = await d.github.writeState(d.slug, d.number, null, body)
  return { ...s, answerUrl: `${issue.url}#issuecomment-${id}` }
}

/**
 * `cambium decide advance`: take `raw` (the session's JSON output) for the node the marker is at; refuse it with
 * the issues listed, or advance to the next node that needs the session and write the marker.
 * @param {DecideDeps} d @param {string | null} raw
 * @returns {Promise<
 *   | { ok: false, error: string, issues?: string[], node?: string }
 *   | { ok: true, marker: DecideMarker, path: string[], dir: string }
 * >}
 */
export async function advanceDecision(d, raw) {
  const loaded = await load(d)
  if (!loaded.ok) return loaded
  const { issue, comment, marker, pos } = loaded
  if (marker?.status === 'done')
    return { ok: false, error: `${d.slug}#${d.number}: the decision is done (${marker.outcome ?? 'done'})` }
  const node = sessionNode(pos)
  /** @type {any} */
  let out = null
  if (node) {
    if (raw === null) return { ok: false, node, error: `${node} needs the session's output: --output <file|->` }
    let json
    try {
      json = JSON.parse(raw)
    } catch (err) {
      return { ok: false, node, error: 'refused', issues: [`not JSON: ${/** @type {Error} */ (err).message}`] }
    }
    const parsed = OUTPUTS[node].safeParse(json)
    if (!parsed.success) return { ok: false, node, error: 'refused', issues: zodIssues(parsed.error) }
    const issues = checkOutput(node, pos.input, parsed.data)
    if (issues.length) return { ok: false, node, error: 'refused', issues }
    out = parsed.data
  }

  const dir = decisionDir(d.home, d.slug, d.number)
  const now = d.now ?? Date.now
  const agentNode = node === 'confirm' ? 'read-confirm' : node
  let fed = false
  let replied = false
  const ctx = {
    now,
    holder: d.holder,
    agent: async (/** @type {string} */ name, /** @type {DecideState} */ s) => {
      if (fed || name !== agentNode) throw new Error(`${name} needs the session's output`)
      fed = true
      return merge(name, s, out, {
        saveMock: (option, html) => {
          const file = join(dir, 'mocks', `${slugOf(option)}.html`)
          mkdirSync(join(dir, 'mocks'), { recursive: true })
          writeFileSync(file, html)
          return pathToFileURL(file).href
        },
      })
    },
    channel: {
      post: async () => {},
      poll: async (/** @type {DecideState} */ s) => {
        if (replied || !out?.reply) return null
        replied = true
        return {
          author: out.author ?? d.holder,
          at: new Date(now()).toISOString(),
          channel: s.channel,
          body: out.reply,
        }
      },
    },
    commit: (/** @type {DecideState} */ s) => commitDecision(d, issue, s),
  }

  /** @type {string[]} */
  const path = []
  /** @type {{ node: string, input: unknown, error?: { message: string } }} */
  let at = pos
  for (let i = 0; i < 32 && at.node !== END; i++) {
    // Stop before a node that needs the session: an agent step, or a turn with no reply carried in.
    const p = /** @type {DecidePosition} */ (at)
    const turn = p.node === 'await-answers' || p.node === 'confirm'
    if (i > 0 && sessionNode(p) && !(turn && p.input.reply)) break
    const r = await advance(decide, p, /** @type {any} */ (ctx), { maxTransitions: 1 })
    path.push(...r.transitions.map((t) => t.from))
    at = { node: r.node, input: r.input, ...(r.error ? { error: r.error } : {}) }
    if (r.reason !== 'limit') break
  }
  const next = markerAt(at, ctx)
  const body = renderDecideMarker(next)
  await d.github.writeState(d.slug, d.number, comment?.id ?? null, body)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'checkpoint.md'), `${body}\n`)
  return { ok: true, marker: next, path, dir }
}

/** @param {DecideState['rounds'][number]} r @param {DecideState} s */
function roundLines(r, s) {
  const lines = [`Round ${r.n}:`]
  for (const [i, q] of r.questions.entries()) {
    lines.push(`  ${i + 1}. ${q.title} [${q.id}]: ${q.text}`)
    if (q.choices?.length) lines.push(`     choices: ${q.choices.join(' | ')}`)
    lines.push(`     recommendation: ${q.rec}`)
  }
  if (s.mocks.length) lines.push('  Mocks:', ...s.mocks.map((m) => `    ${m.option}: ${m.url}`))
  return lines
}

/** @param {NonNullable<DecideState['draft']>} d */
const draftLines = (d) => [
  `Draft: ${d.choice}`,
  `  in scope: ${d.inScope.join('; ') || 'none'}`,
  `  out of scope: ${d.outOfScope.join('; ') || 'none'}`,
  ...d.acceptance.map((a) => `  [ ] ${a}`),
  ...d.followUps.map((f) => `  follow-up: ${f.title}`),
]

/** What the session must hand `advance` at each node, as one line. */
const ASKS = /** @type {Record<SessionNode, string>} */ ({
  open: 'Read the issue and its session brief. Output {"question"?, "options"?: [{label, detail, cost}], "lens"?, "visual"?, "notes"?}.',
  orient:
    'Gather the facts the ask depends on, each with a source (file:line, URL). Output {"facts": [{claim, source}], "frontier": ["<open sub-decision>", …], "options"?, "visual"?, "notes"?}.',
  mock: 'Write one static HTML mock per option. Output {"mocks": [{option, html}]}; cambium saves them next to the checkpoint.',
  'ask-round':
    'Ask at most 5 numbered questions on the frontier, each with a recommendation worded so "yes" accepts. Output {"questions": [{id, title, text, choices?, rec}]}.',
  'await-answers':
    'Show the round to the person and wait for their reply. Output {"reply": "<their words>", "author"?}. A reply starting "stop" or "abandon" ends the decision.',
  'apply-answers':
    'Map the reply onto the round. Output {"answers": [{id, text}], "decided": [ids], "frontier": [still open], "needFacts"?: [facts to look up], "notes"?}.',
  draft:
    'Write the decision. Output {"draft": {choice, inScope: [], outOfScope: [], acceptance: [≥1], followUps: [{title, body}]}}.',
  confirm:
    'Show the draft and ask the person to accept, edit or abandon it. Output {"reply": "<their words>", "confirm": "yes"|"edit"|"abandon", "notes"?}. "yes" is refused until the decision is complete.',
})

/**
 * The position as the session reads it: where the decision is, what the person has before them (the round's
 * questions and mocks, the draft) and the output the next `advance` takes.
 * @param {string} ref @param {DecidePosition} pos @param {DecideMarker | null} marker
 */
export function describePosition(ref, pos, marker) {
  const s = pos.input
  const status = marker ? marker.status : 'not started'
  const lines = [`${ref} · decide (${s.lens}) · ${status} · at ${pos.node === END ? 'the end' : pos.node}`]
  if (marker?.error) lines.push(`Last turn failed at ${pos.node}: ${marker.error}. The next advance retries it.`)
  if (pos.node === END) {
    lines.push(`Outcome: ${marker?.outcome ?? 'done'}${s.answerUrl ? ` · ${s.answerUrl}` : ''}`)
    return lines.join('\n')
  }
  lines.push(`Question: ${s.issue.question}`)
  const about = decide.nodes.find((n) => n.name === pos.node)
  if (about && 'about' in about) lines.push(`${pos.node}: ${about.about}`)
  if (s.lease) lines.push(`Lease: ${s.lease.holder}`)
  if (s.decided.length) lines.push(`Decided: ${s.decided.join(', ')}`)
  if (s.frontier.length) lines.push(`Open: ${s.frontier.join(', ')}`)
  const node = sessionNode(pos)
  const round = s.rounds.at(-1)
  if ((node === 'await-answers' || node === 'apply-answers') && round) lines.push('', ...roundLines(round, s))
  if (node === 'apply-answers' && s.reply) lines.push(`Reply from ${s.reply.author}: ${s.reply.body}`)
  if (node === 'confirm' && s.draft) {
    lines.push('', ...draftLines(s.draft))
    const gaps = completeness(s)
    if (gaps.length) lines.push('Not complete yet:', ...gaps.map((g) => `  - ${g}`))
  }
  lines.push(
    '',
    node
      ? `Next: ${ASKS[node]}\nThen: cambium decide advance ${ref} --output <file|->`
      : `Next: cambium decide advance ${ref} (cambium runs ${pos.node} itself)`,
  )
  return lines.join('\n')
}
