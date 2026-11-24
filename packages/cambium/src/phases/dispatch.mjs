// @ts-check
/**
 * The Dispatch phase's parts: the triage worker's prompt, its typed result and how cambium reads it from the
 * worker's stream-json log. The `dispatch` graph (graphs/dispatch.mjs) runs them; the legacy engine keeps the
 * stub below and leaves `q:intake` alone.
 */
import { z } from 'zod'
import { askError, LenientAsk } from '../ask.mjs'

/**
 * @typedef {{ repo: string, intake: import('../github.mjs').Issue[], capacity: number, now: number }} DispatchInput
 * @typedef {(input: DispatchInput) => Promise<{ started: number[] }>} Dispatch
 */

/** @type {Dispatch} */
export async function dispatchNotBuilt() {
  return { started: [] }
}

export const DISPATCH_NOT_BUILT = 'dispatch phase is not built yet; q:intake issues wait'

/** The verdict a triage worker ends with, as the last JSON block of its final message. */
export const TriageResult = z
  .object({
    verdict: z.enum(['actionable', 'needs-human', 'duplicate', 'defer', 'blocked', 'obsolete']),
    duplicateOf: z.number().int().positive().optional(),
    blockedBy: z.array(z.number().int().positive()).min(1).optional(),
    recheckHours: z.number().positive().max(168).optional(),
    reason: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    acceptance: z.array(z.string().trim().min(1)).optional(),
    /** For needs-human: what the person is asked to do (ask.mjs). An invalid one is dropped, not fatal. */
    ask: LenientAsk,
  })
  .refine((r) => r.verdict !== 'duplicate' || r.duplicateOf !== undefined, {
    message: 'a duplicate verdict needs duplicateOf',
    path: ['duplicateOf'],
  })
  .refine((r) => r.verdict !== 'blocked' || r.blockedBy !== undefined, {
    message: 'a blocked verdict needs blockedBy',
    path: ['blockedBy'],
  })

/** @typedef {z.infer<typeof TriageResult>} Triage */

/**
 * The JSON in a final message: its last fenced block, else the whole text, else its outermost `{…}`.
 * @param {string} text @returns {unknown} throws a SyntaxError-like Error when there is none
 */
function jsonIn(text) {
  const fenced = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const candidates = fenced.length
    ? [fenced[fenced.length - 1]]
    : [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  /** @type {unknown} */
  let last
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim())
    } catch (err) {
      last = err
    }
  }
  throw new Error(
    `no JSON result in the final message (${/** @type {Error} */ (last)?.message ?? 'empty'}): ${clip(text)}`,
  )
}

/** @param {string} s */
const clip = (s, n = 300) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one || '(empty)'
}

/**
 * The JSON a one-shot worker ends with, from its stdout (`claude -p --output-format stream-json`): the last `result`
 * event's `result` text, its JSON ({@link jsonIn}). Anything else is an error saying what was wrong.
 * @param {string} log the stdout log text
 * @returns {{ ok: true, json: unknown } | { ok: false, error: string }}
 */
export function finalJson(log) {
  /** @type {any} */
  let result = null
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e?.type === 'result') result = e
    } catch {}
  }
  if (!result) return { ok: false, error: 'no result event in the worker log (killed, crashed or truncated)' }
  if (typeof result.result !== 'string')
    return { ok: false, error: `the worker ended without a final message (${result.subtype ?? 'no subtype'})` }
  try {
    return { ok: true, json: jsonIn(result.result) }
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message }
  }
}

/** @param {z.core.$ZodIssue} i */
export const formatZodIssue = (i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)

/**
 * The triage verdict from a worker's stdout (`claude -p --output-format stream-json`): the last `result` event's
 * `result` text, its JSON, validated by {@link TriageResult}. Anything else is an error saying what was wrong.
 *
 * @param {string} log the stdout log text
 * @param {number} issue the triaged issue, which cannot be its own duplicate
 * @returns {{ ok: true, result: Triage } | { ok: false, error: string }}
 */
export function readTriage(log, issue) {
  const read = finalJson(log)
  if (!read.ok) return read
  const parsed = TriageResult.safeParse(read.json)
  if (!parsed.success)
    return { ok: false, error: `invalid triage result: ${parsed.error.issues.map(formatZodIssue).join('; ')}` }
  if (parsed.data.verdict === 'duplicate' && parsed.data.duplicateOf === issue)
    return { ok: false, error: `invalid triage result: duplicateOf: #${issue} cannot duplicate itself` }
  if (parsed.data.verdict === 'blocked' && parsed.data.blockedBy?.includes(issue))
    return { ok: false, error: `invalid triage result: blockedBy: #${issue} cannot block itself` }
  const { ask, ...rest } = parsed.data
  if (rest.verdict !== 'needs-human') return { ok: true, result: rest }
  const bad = askError(/** @type {any} */ (read.json)?.ask)
  if (bad)
    return {
      ok: true,
      result: { ...rest, reason: `${rest.reason}\n\n(triage's ask was invalid and was dropped: ${bad})` },
    }
  return { ok: true, result: ask ? { ...rest, ask } : rest }
}

/**
 * The triage worker's prompt: one issue, one verdict. Adapted from the OpenRig seed's `inbox` and `intent-lead`
 * roles and its culture (unattended, never ask and wait, CI is the acceptance gate, never `gh`).
 *
 * @param {{
 *   repo: string, baseBranch: string, issue: import('../github.mjs').Issue,
 *   queued: { number: number, title: string, labels: string[] }[], agentsMd: string | null,
 *   deferred?: { count: number, reason: string } | null, deferHours?: number,
 *   blocked?: { by: number[], reason: string } | null,
 *   replied?: { question: string | null, replies: { author: string, at: string, body: string }[] } | null,
 * }} input
 *   `blocked`: an earlier triage parked it on these issues, all closed now. `replied`: a human commented since the
 *   issue last waited; `question` is what it waited on (the needs-human, defer or blocked reason).
 *   A change to how triage judges an issue bumps `TRIAGE_RUBRIC` (triage-inputs.mjs), so the stall fallback looks again at the issues it finds stalled.
 */
export function triagePrompt({
  repo,
  baseBranch,
  issue,
  queued,
  agentsMd,
  deferred = null,
  deferHours = 6,
  blocked = null,
  replied = null,
}) {
  const others = queued
    .filter((q) => q.number !== issue.number)
    .map((q) => `- #${q.number} ${q.title} (${q.labels.filter((l) => l.startsWith('q:')).join(', ') || 'no queue'})`)
    .join('\n')
  return `You are a triage worker started by cambium, the scheduler, in a read-only checkout of ${repo} at origin/${baseBranch}.
Nobody is watching this session and nobody will answer a question: never ask one and wait. Where you would ask a human about a decision only a human can make, that is your verdict (needs-human). Where you would ask a human to check something, check it yourself, or defer until it can be checked: a human is never the way to verify what a machine can.

Your one job: decide what happens to GitHub issue #${issue.number} (below), which is waiting in the intake queue. You do not do the work. You do not edit files, commit, publish, comment, label or close anything; cambium makes every move on your verdict.

Verdicts:
- actionable: a worker could do it unattended from what is written (plus what you add), and would know when it is done. It goes to the task queue. When the issue lacks a clear task or checkable acceptance criteria, give \`title\` (an imperative task title) and \`acceptance\` (checks a reviewer can verify; CI green is always required, so do not list only that). cambium posts them on the issue and hands them to the task worker.
- needs-human: too foggy to ticket; a decision only a human can make (direction, priority, money, access, policy); information no one but a human has; or work that is not a code change in this repository. \`reason\` says exactly what the human must decide or supply. Never for something a machine can check, now or later. Fill \`ask\` so the person can answer with one comment:
  - \`kind\`: \`decide\` (a choice only a person can make), \`verify\` (a check only a person can make: a physical device, an account no machine can reach), \`chore\` (offline work: a store listing, paperwork, a console setting) or \`approve\` (a yes or no on something already written).
  - \`question\`: the one question, answerable in a comment. For \`decide\`, \`options\` (two or more, each a \`label\` and the tradeoff in \`detail\`) and, where you have one, \`recommendation\`.
  - \`interactive\`: true only when a live session with the code would help the person answer (a design choice to explore); false for chores, checks and plain choices.
  If the issue waits on another open issue that is itself a human chore or check, it is blocked by that issue, not needs-human: do not ask again what that issue already asks.
- duplicate: the same work as another issue, open or closed. \`duplicateOf\` is that issue's number (never #${issue.number}); \`reason\` says why they are the same.
- obsolete: the work no longer applies, and you verified it: the code path is gone, the bug is already fixed on ${baseBranch}, or its verification already passed. cambium closes it as not planned. \`reason\` gives the evidence (commit, file, run).
- defer: the verdict hangs on something a machine can check later but not yet: a CI or CD run that has not happened, a release, a PR still merging, a deploy, an upstream fix. cambium triages it again after \`recheckHours\` (default ${deferHours}). \`reason\` says exactly what to check next time and what each answer means (e.g. "next main cd run green → obsolete; red → actionable"). Not for waiting on another issue: that is blocked.
- blocked: it cannot start until other issues in ${repo} are done (including an open issue waiting on a person for a chore or check). \`blockedBy\` lists their numbers (never #${issue.number}); cambium records each as a GitHub "blocked by" link on this issue and triages it again as soon as the last of them closes, not on a timer. \`reason\` says what each blocker must deliver.

How to look:
- Read the code here (Read, Glob, Grep) to judge what the change touches and whether it already exists.
- First, has it already been done? Its comments (\`graft api GET /repos/${repo}/issues/${issue.number}/comments\`) and its timeline (\`graft api GET '/repos/${repo}/issues/${issue.number}/timeline?per_page=100'\`: cross-referenced PRs, and whether they merged) often say so. A merged PR whose change is on ${baseBranch}, and nothing left of the issue, is obsolete; a PR still open or in CI is defer.
- Does it already wait on other issues? Its GitHub "blocked by" links: \`graft api GET /repos/${repo}/issues/${issue.number}/dependencies/blocked_by\`. An open one, or prose naming an open issue it needs first, is blocked.
- Read an issue with \`graft issue read <n>\`; search with \`graft api GET '/search/issues?q=repo:${repo}+is:issue+<words>'\`. Never \`gh\`.
- A human reply (quoted below, when there is one) answering the open question usually makes the issue actionable: fold the answer into \`title\` and \`acceptance\` so the task worker gets it with the issue. If the reply leaves the question open, the verdict is needs-human again, and \`reason\` says what is still missing. A reply carrying a \`cambium:answer\` marker is a decision a person made in a decide session, posted for them: when it gives a decision and acceptance checks, the verdict is normally actionable, with the decision in \`title\` and those checks in \`acceptance\`, not another needs-human.
- Be quick: a verdict, not an investigation. When in doubt whether the work is clear enough to do, choose needs-human; when in doubt whether something is true, check it, or defer until it can be checked.

End your final message with exactly one fenced JSON block, and nothing after it:
\`\`\`json
{ "verdict": "actionable" | "needs-human" | "duplicate" | "obsolete" | "defer" | "blocked", "duplicateOf": 123, "blockedBy": [124], "recheckHours": 6, "reason": "…", "title": "…", "acceptance": ["…"], "ask": { "kind": "decide" | "verify" | "chore" | "approve", "question": "…", "options": [{ "label": "…", "detail": "…" }], "recommendation": "…", "interactive": false } }
\`\`\`
\`duplicateOf\` only for duplicate; \`blockedBy\` only for blocked; \`recheckHours\` only for defer, and optional; \`title\` and \`acceptance\` only for actionable, and optional; \`ask\` only for needs-human (\`options\` only for decide, \`recommendation\` optional). A missing or malformed block sends the issue to a human with the error.
${deferred ? `\nThis is re-triage ${deferred.count + 1}: an earlier triage deferred it to check this:\n${deferred.reason}\nCheck it now. If it still cannot be checked, defer again.\n` : ''}${blocked ? `\nAn earlier triage found it blocked by ${blocked.by.map((n) => `#${n}`).join(', ')}, now closed:\n${blocked.reason}\nJudge it again now that they are done.\n` : ''}${replied ? repliedNote(replied) : ''}${others ? `\nOther issues in cambium's queues right now:\n${others}\n` : ''}
--- Issue #${issue.number}: ${issue.title} (${issue.url})
${issue.body}
${agentsMd ? `\n--- AGENTS.md (the contract a task worker will follow)\n${agentsMd}` : ''}`
}

/**
 * The prompt's section quoting the human replies as the answer to what the issue waited on.
 * @param {NonNullable<Parameters<typeof triagePrompt>[0]['replied']>} r
 */
function repliedNote({ question, replies }) {
  const quote = (/** @type {string} */ s) =>
    s
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
  return `\nAn earlier triage or step left it waiting on this:\n${quote(question ?? '(no reason recorded)')}\nA human has since replied on the issue. Read the reply as the answer to that:\n${replies
    .map((r) => `\n@${r.author} at ${r.at}:\n${quote(r.body)}\n`)
    .join('')}`
}

/**
 * The comment triage leaves on an actionable issue.
 * @param {{ reason: string, title?: string, acceptance?: string[] }} t
 */
export function triageComment({ reason, title, acceptance }) {
  return [
    `**Triage: actionable.** ${reason}`,
    ...(title ? ['', `**Task:** ${title}`] : []),
    ...(acceptance?.length ? ['', '**Acceptance checks**', ...acceptance.map((a) => `- [ ] ${a}`)] : []),
    '',
    '_Triaged by cambium; the task worker gets these with the issue body._',
  ].join('\n')
}
