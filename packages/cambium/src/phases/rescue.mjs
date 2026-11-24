// @ts-check
/**
 * The rescue graph's parts (graphs/rescue.mjs): what counts as stuck ({@link findStuck}), the rescue worker's prompt,
 * its typed result and the checks cambium runs on it before acting, and the comments and root-cause tickets it
 * writes.
 *
 * An item is stuck when its labels break the queue rules (more than one `q:*`, `running` without a queue, `why:*` or
 * `ask:*` outside `q:human`, `wait:*` outside `q:intake`, cambium labels left on a closed issue), when its agent PR closed
 * or merged and left it open in no queue, or when it has waited in a queue, or its PR has sat untouched, far longer
 * than cambium ever takes to move it.
 */
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { branchIssue } from '../github.mjs'
import { MIN } from '../issue-state.mjs'
import { Q, RUNNING } from '../labels.mjs'
import { LenientAsk } from '../ask.mjs'
import { finalJson, formatZodIssue } from './dispatch.mjs'

/**
 * @typedef {import('../github.mjs').Issue} Issue
 * @typedef {import('../github.mjs').PullRequest} PullRequest
 * @typedef {import('../github.mjs').Snapshot} Snapshot
 * @typedef {{ code: string, detail: string }} Symptom
 * @typedef {{ slug: string, number: number, pr: number | null, symptoms: Symptom[] }} Stuck
 *   One stuck item: always an issue (a stuck PR is reported on the issue it closes); `pr` is the PR involved, if any.
 */

const HOUR = 60 * MIN

/** The labels cambium owns, which only cambium moves. @param {string} l */
export const cambiumLabel = (l) =>
  l.startsWith('q:') || l === RUNNING || l.startsWith('why:') || l.startsWith('ask:') || l.startsWith('wait:')

/** The issue an agent PR is for: the first one it closes that the snapshot has, else the one its branch names. @param {PullRequest} pr */
const issueOfPr = (pr) => pr.closes[0] ?? branchIssue(pr.branch)

/** @param {PullRequest} pr @param {number} n */
const isFor = (pr, n) => pr.closes.includes(n) || (!pr.closes.length && branchIssue(pr.branch) === n)

/** @param {number} ms */
const hours = (ms) => `${Math.round(ms / HOUR)}h`

/**
 * Every stuck item in one repo's snapshot. Pure: the caller reads, filters and acts.
 *
 * `recheck` asks only whether an item is still in its stuck condition (a diagnosis is about to act on it): the
 * time and capacity gates are skipped.
 *
 * @param {Snapshot} snap
 * @param {{
 *   slug: string, now: number, host: string, running: boolean, staleHours: number, graceMinutes: number,
 *   free: { task: number, dispatch: number }, busy: (n: number) => boolean, closed?: PullRequest[], recheck?: boolean,
 * }} o
 *   `running`: the daemon's mode is `running` (Schedule ran this tick). `free`: the slots Schedule left open this tick;
 *   a waiting issue counts as stale only when one was free for it. `busy`: a live worker holds it, or the tick already
 *   moved it. `closed`: the newest closed-unmerged agent PRs ({@link import('../github.mjs').GitHub} `closedPulls`).
 * @returns {Stuck[]}
 */
export function findStuck(snap, o) {
  const { now, recheck = false } = o
  const open = snap.prs.filter((p) => p.state === 'OPEN')
  const merged = snap.prs.filter((p) => p.state === 'MERGED')
  const closed = [...(o.closed ?? []), ...snap.prs.filter((p) => p.state === 'CLOSED')]
  /** @type {Map<number, Stuck>} */
  const out = new Map()
  const add = (/** @type {number} */ n, /** @type {Symptom} */ s, pr = /** @type {number | null} */ (null)) => {
    const item = out.get(n) ?? { slug: o.slug, number: n, pr: null, symptoms: [] }
    item.symptoms.push(s)
    if (pr !== null && item.pr === null) item.pr = pr
    out.set(n, item)
  }
  for (const issue of snap.issues.values()) {
    if (o.busy(issue.number)) continue
    const n = issue.number
    const labels = issue.labels
    const m = issue.stateComment?.marker
    const age = now - (Date.parse(m?.enteredAt ?? issue.createdAt) || now)
    const graced = recheck || age >= o.graceMinutes * MIN
    const stale = recheck || age >= o.staleHours * HOUR
    const queues = labels.filter((l) => l.startsWith('q:'))
    const running = labels.includes(RUNNING)
    if (issue.state !== 'OPEN') {
      const left = labels.filter((l) => cambiumLabel(l) && l !== Q.promote)
      if (left.length && graced)
        add(n, { code: 'closed-labelled', detail: `closed, still labelled ${left.join(', ')}` })
      continue
    }
    if (!graced) continue
    // Another host's lease may be live: its own sweep owns it.
    const foreign = running && !!m?.host && m.host !== o.host
    if (queues.length > 1)
      add(n, { code: 'many-queues', detail: `in ${queues.length} queues at once: ${queues.join(', ')}` })
    if (running && !foreign && !queues.some((q) => q === Q.task || q === Q.intake))
      add(n, {
        code: 'running-unqueued',
        detail: `labelled \`${RUNNING}\` ${queues.length ? `in ${queues.join(', ')}` : 'in no queue'}`,
      })
    const why = labels.filter((l) => l.startsWith('why:') || l.startsWith('ask:'))
    if (why.length && !labels.includes(Q.human))
      add(n, { code: 'why-outside-human', detail: `${why.join(', ')} without ${Q.human}` })
    const wait = labels.filter((l) => l.startsWith('wait:'))
    if (wait.length && !labels.includes(Q.intake))
      add(n, { code: 'wait-outside-intake', detail: `${wait.join(', ')} without ${Q.intake}` })
    if (!queues.length && !running) {
      if (open.some((p) => isFor(p, n))) continue
      const done = merged.find((p) => isFor(p, n))
      const gone = closed.find((p) => isFor(p, n))
      // Watch closes out a merged PR's issue, and a rework requeues a closed one's: give them the grace too.
      const last = done ?? gone
      if (!recheck && last && now - (Date.parse(last.updatedAt ?? '') || 0) < o.graceMinutes * MIN) continue
      if (done)
        add(
          n,
          { code: 'merged-open', detail: `its PR #${done.number} merged, but the issue is open in no queue` },
          done.number,
        )
      else if (gone || m?.pr)
        add(
          n,
          {
            code: 'stranded',
            detail: `open in no queue with no open agent PR${gone ? `: its PR #${gone.number} closed unmerged` : m?.pr ? ` (its marker names PR #${m.pr})` : ''}`,
          },
          gone?.number ?? m?.pr ?? null,
        )
      continue
    }
    if (!stale || running || queues.length !== 1) continue
    const since = `waiting ${hours(age)} since ${m?.enteredAt ? `it entered ${m.node}` : 'it was opened'}`
    if (queues[0] === Q.task && (recheck || (o.running && o.free.task > 0 && snap.base?.state !== 'red')))
      add(n, { code: 'stale-task', detail: `${Q.task}, ${since}, with a task slot free` })
    if (queues[0] === Q.intake && (recheck || (o.running && o.free.dispatch > 0)) && !parked(issue, now))
      add(n, { code: 'stale-intake', detail: `${Q.intake}, ${since}, with a triage slot free` })
  }
  for (const pr of open) {
    const touched = Date.parse(pr.updatedAt ?? pr.createdAt ?? '') || now
    if (!recheck && now - touched < o.staleHours * HOUR) continue
    const n = issueOfPr(pr)
    const issue = n === null ? undefined : snap.issues.get(n)
    // No issue, or a closed one: the reaper's. The Human Queue's PRs are the human's. A queued issue (a rework
    // waiting for a slot, a re-triage) is the queue's: a long wait there is `stale-task` / `stale-intake`.
    if (issue?.state !== 'OPEN' || o.busy(issue.number)) continue
    if (issue.labels.some((l) => l === Q.human || l === Q.task || l === Q.intake)) continue
    const state = [
      `checks ${pr.checks ?? 'none'}`,
      `mergeable ${pr.mergeable ?? 'unknown'}`,
      ...(pr.reviewDecision ? [`review ${pr.reviewDecision}`] : []),
      ...(pr.inMergeQueue ? ['in the merge queue'] : []),
    ].join(', ')
    add(
      issue.number,
      { code: 'pr-stale', detail: `PR #${pr.number} untouched for ${hours(now - touched)}: ${state}` },
      pr.number,
    )
  }
  return [...out.values()].sort((a, b) => a.number - b.number)
}

/** Parked by triage: deferred until later, or blocked by an open issue. @param {Issue} issue @param {number} now */
const parked = (issue, now) => {
  const m = issue.stateComment?.marker
  const deferred = m?.graph === 'dispatch' && m.node === 'deferred' && !!m.deferUntil && Date.parse(m.deferUntil) > now
  return deferred || (issue.blockedBy ?? []).some((b) => b.state === 'OPEN')
}

// ---- Rescue history (local: when cambium last rescued an item, to bound how often it tries)

const WEEK = 7 * 24 * HOUR

/** @param {string} slug @param {number} n */
const rescueKey = (slug, n) => `rescue:${slug}#${n}`

/**
 * When cambium started a rescue of this item, newest last, within the last week.
 * @param {{ get: (key: string) => string | null }} store @param {string} slug @param {number} n @param {number} now
 * @returns {number[]}
 */
export function rescuesOf(store, slug, n, now) {
  try {
    const at = JSON.parse(store.get(rescueKey(slug, n)) ?? '[]')
    return Array.isArray(at) ? at.filter((t) => typeof t === 'number' && now - t < WEEK) : []
  } catch {
    return []
  }
}

/** @param {{ get: (key: string) => string | null, set: (key: string, value: string) => void }} store @param {string} slug @param {number} n @param {number} now */
export function recordRescue(store, slug, n, now) {
  store.set(rescueKey(slug, n), JSON.stringify([...rescuesOf(store, slug, n, now), now]))
}

/** @param {string} slug @param {number} n */
const codesKey = (slug, n) => `rescue-codes:${slug}#${n}`

/**
 * Remember which symptoms a diagnosis started from, so its verdict is applied only while one of them still holds.
 * @param {{ set: (key: string, value: string) => void }} store @param {Stuck} stuck
 */
export function recordSymptoms(store, stuck) {
  store.set(codesKey(stuck.slug, stuck.number), JSON.stringify(stuck.symptoms.map((s) => s.code)))
}

/**
 * The item as it is now, narrowed to the symptoms its diagnosis started from: null when none of them holds any more
 * (a recheck finds every condition, so a fresh one, e.g. a stale wait after the labels were fixed, does not count).
 * @param {{ get: (key: string) => string | null }} store @param {Stuck | undefined} now
 * @returns {Stuck | null}
 */
export function stillStuck(store, now) {
  if (!now) return null
  /** @type {unknown} */
  let codes = null
  try {
    codes = JSON.parse(store.get(codesKey(now.slug, now.number)) ?? 'null')
  } catch {}
  if (!Array.isArray(codes)) return now
  const symptoms = now.symptoms.filter((s) => codes.includes(s.code))
  return symptoms.length ? { ...now, symptoms } : null
}

// ---- The rescue worker's result

const text = z.string().trim().min(1)

export const RescueAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('requeue'), queue: z.enum(['task', 'intake']), reason: text }),
  z.object({ do: z.literal('to-human'), reason: text, ask: LenientAsk }),
  z.object({
    do: z.literal('close-issue'),
    as: z.enum(['completed', 'not_planned']).default('completed'),
    reason: text,
  }),
  z.object({ do: z.literal('adopt-pr'), pr: z.number().int().positive(), reason: text.optional() }),
  z.object({ do: z.literal('close-pr'), pr: z.number().int().positive(), reason: text }),
  z.object({ do: z.literal('clear-labels'), labels: z.array(text).min(1), reason: text.optional() }),
])

/** A ticket for a root cause: `fingerprint` names the cause, so the same cause found again is one ticket. */
export const RootCause = z.object({
  title: text,
  body: text,
  fingerprint: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'kebab-case, 3-64 characters'),
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/)
    .optional(),
})

/** What a rescue worker ends with, as the last JSON block of its final message. */
export const RescueResult = z.object({
  stuck: z.boolean(),
  how: text,
  actions: z.array(RescueAction).max(4).default([]),
  rootCauses: z.array(RootCause).max(3).default([]),
})

/** @typedef {z.infer<typeof RescueResult>} Rescue @typedef {z.infer<typeof RescueAction>} Action */

/**
 * The rescue verdict from a worker's stdout log, validated by {@link RescueResult}.
 * @param {string} log @returns {{ ok: true, result: Rescue } | { ok: false, error: string }}
 */
export function readRescue(log) {
  const read = finalJson(log)
  if (!read.ok) return read
  const parsed = RescueResult.safeParse(read.json)
  if (!parsed.success)
    return { ok: false, error: `invalid rescue result: ${parsed.error.issues.map(formatZodIssue).join('; ')}` }
  return { ok: true, result: parsed.data }
}

/** Actions that put the issue somewhere: at most one, and nothing after it. */
const MOVES = new Set(['requeue', 'to-human', 'close-issue', 'adopt-pr'])

/**
 * Whether cambium can carry out this verdict on this item, before it touches anything: an error naming the first
 * problem, or null.
 * @param {Rescue} r @param {{ issue: Issue, snap: Snapshot, repos: string[] }} at
 *   `repos`: where root-cause tickets may be filed.
 * @returns {string | null}
 */
export function checkPlan(r, { issue, snap, repos }) {
  const moves = r.actions.filter((a) => MOVES.has(a.do))
  if (moves.length > 1) return `more than one move (${moves.map((a) => a.do).join(', ')}); give at most one`
  if (moves.length && r.actions.at(-1) !== moves[0]) return `${moves[0].do} must be the last action`
  if (!r.stuck && r.actions.length) return 'actions on an item that is not stuck'
  for (const a of r.actions) {
    if ((a.do === 'adopt-pr' || a.do === 'close-pr') && !snap.prs.some((p) => p.number === a.pr && p.state === 'OPEN'))
      return `${a.do}: #${a.pr} is not an open agent PR`
    if (a.do === 'adopt-pr' && r.actions.some((b) => b.do === 'close-pr' && b.pr === a.pr))
      return `adopt-pr and close-pr name the same PR #${a.pr}`
    if (a.do === 'clear-labels') {
      const foreign = a.labels.filter((l) => !cambiumLabel(l))
      if (foreign.length) return `clear-labels: ${foreign.join(', ')} are not cambium labels`
    }
    if (issue.state !== 'OPEN' && a.do !== 'clear-labels') return `${a.do}: #${issue.number} is closed`
  }
  for (const c of r.rootCauses)
    if (c.repo && !repos.includes(c.repo))
      return `root cause "${c.fingerprint}": ${c.repo} is not one of ${repos.join(', ')}`
  return null
}

/** What an action did, for the report. @param {Action} a */
export function describe(a) {
  switch (a.do) {
    case 'requeue':
      return `Requeued to \`${a.queue === 'task' ? Q.task : Q.intake}\` at attempt 1: ${a.reason}`
    case 'to-human':
      return `Handed to \`${Q.human}\`: ${a.reason}`
    case 'close-issue':
      return `Closed as ${a.as === 'completed' ? 'completed' : 'not planned'}: ${a.reason}`
    case 'adopt-pr':
      return `Handed PR #${a.pr} to the PR graph, which merges it when green or reworks it${a.reason ? `: ${a.reason}` : ''}`
    case 'close-pr':
      return `Closed PR #${a.pr}: ${a.reason}`
    case 'clear-labels':
      return `Removed ${a.labels.map((l) => `\`${l}\``).join(', ')}${a.reason ? `: ${a.reason}` : ''}`
  }
}

// ---- Root-cause tickets

/** The hidden line that names a root cause in its ticket's body. @param {string} fingerprint */
export const causeMarker = (fingerprint) => `<!-- cambium:rescue-cause ${fingerprint} -->`

/**
 * A root-cause ticket's body: the worker's, then where it was found.
 * @param {z.infer<typeof RootCause>} c @param {{ slug: string, number: number, how: string }} from
 */
export function causeBody(c, from) {
  return [
    c.body,
    '',
    '## Found by',
    '',
    `cambium's rescue graph, unsticking ${from.slug}#${from.number}. How that item got stuck:`,
    '',
    ...from.how.split('\n').map((l) => `> ${l}`),
    '',
    causeMarker(c.fingerprint),
  ].join('\n')
}

/** The comment on an existing root-cause ticket when the cause is found again. @param {{ slug: string, number: number, how: string }} from */
export const seenAgain = (from) =>
  `**Rescue:** this cause struck again, on ${from.slug}#${from.number}.\n\n${from.how
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}`

// ---- The rescue worker's prompt and the reports

/** @param {Symptom[]} symptoms */
const symptomList = (symptoms) => symptoms.map((s) => `- \`${s.code}\`: ${s.detail}`).join('\n')

/** cambium's own source, for the worker to read when the cause is cambium's. */
export const CAMBIUM_SRC = fileURLToPath(new URL('..', import.meta.url))

/**
 * The rescue worker's prompt: one stuck item, one verdict.
 * @param {{
 *   repo: string, baseBranch: string, stuck: Stuck, issue: Issue, pr: PullRequest | null, agentsMd: string | null,
 *   logs: string, repos: string[], previous: number,
 * }} input
 *   `logs`: cambium's log directory. `repos`: where root-cause tickets may go. `previous`: rescues of this item this week.
 */
export function rescuePrompt({ repo, baseBranch, stuck, issue, pr, agentsMd, logs, repos, previous }) {
  const marker = issue.stateComment?.marker
  return `You are a rescue worker started by cambium, the scheduler, in a read-only checkout of ${repo} at origin/${baseBranch}.
Nobody is watching this session and nobody will answer a question: never ask one and wait.

GitHub issue #${issue.number} looks stuck: cambium's queues are not moving it. Your job has three parts:
1. How did it get stuck? Reconstruct the sequence of events with evidence: who or what changed its labels and when, what cambium did, what failed.
2. What gets it moving again? Choose the actions cambium should take now.
3. What would stop this happening again? Each root cause that needs a change (to code, config or process) becomes a ticket.
You do not do any of it yourself. You do not edit files, commit, publish, comment, label or close anything; cambium carries out your verdict.

What cambium found:
${symptomList(stuck.symptoms)}${previous ? `\n\ncambium has rescued this item ${previous} time${previous === 1 ? '' : 's'} this week already. If you cannot see a fix that lasts, hand it to a human.` : ''}

How cambium's queues work (labels are the queue; only cambium moves them):
- Exactly one queue label: \`${Q.intake}\` (triage decides what it is), \`${Q.task}\` (a task worker turns it into a PR), \`${Q.human}\` (waits for a person, with a \`why:*\` label saying why), \`${Q.promote}\` (merged, awaiting the release promotion).
- \`${RUNNING}\`: a worker holds a lease on it right now. Without a live worker it is a lost lease.
- \`why:*\` and \`ask:*\` (what the person is asked to do) only with \`${Q.human}\`; \`wait:deferred\` / \`wait:blocked\` only with \`${Q.intake}\` (triage parked it).
- Once a task worker publishes its PR, the issue leaves every queue and the PR graph owns it: it merges a green PR (or waits for a merge queue or a human), reworks a red or conflicting one back through \`${Q.task}\`, and closes the issue when the PR merges.
- cambium's state comment on the issue holds a hidden JSON marker: the graph and node the issue rests at, and its history. It is below.

How to look:
- The issue's timeline: \`graft api GET '/repos/${repo}/issues/${issue.number}/timeline?per_page=100'\`: labeled/unlabeled events with their actor and time, cross-referenced and closed PRs. Comments: \`graft api GET /repos/${repo}/issues/${issue.number}/comments\`.
- A PR: \`graft api GET /repos/${repo}/pulls/<n>\`, its checks: \`graft api GET /repos/${repo}/commits/<sha>/check-runs\`.
- cambium's logs are under ${logs}: the daemon's log, and each worker's \`<owner>__<repo>/issue-<n>/a<attempt>-<time>.{prompt.md,out.log,err.log}\`. cambium's source is at ${CAMBIUM_SRC}: read it when the cause may be cambium's own.
- Never \`gh\`. Be quick: a verdict with evidence, not an essay.

Actions, in order (cambium checks them before it does anything; an invalid list sends the issue to a human):
- \`{ "do": "clear-labels", "labels": ["…"], "reason": "…" }\`: remove stray cambium labels (\`q:*\`, \`${RUNNING}\`, \`why:*\`, \`ask:*\`, \`wait:*\`) and nothing else.
- \`{ "do": "close-pr", "pr": 123, "reason": "…" }\`: close an open agent PR that is superseded or abandoned.
- At most one of these, last:
  - \`{ "do": "requeue", "queue": "task" | "intake", "reason": "…" }\`: back to a queue at its start, attempt 1: \`task\` when the work is still clear, \`intake\` when it needs triage again.
  - \`{ "do": "adopt-pr", "pr": 123 }\`: hand an open agent PR that holds the work to the PR graph.
  - \`{ "do": "close-issue", "as": "completed" | "not_planned", "reason": "…" }\`: the work is done (say where) or no longer applies.
  - \`{ "do": "to-human", "reason": "…", "ask": { … } }\`: only a person can unstick it; \`reason\` says exactly what they must decide or do. Where you can, add \`ask\` so they can answer with one comment: \`{ "kind": "decide" | "verify" | "chore" | "approve", "question": "…", "options": [{ "label": "…", "detail": "…" }], "recommendation": "…", "interactive": false }\` (\`options\`, two or more, only for decide; \`interactive\` true only when a live session with the code would help; an interactive decide also needs \`"lens": "product" | "technical"\`: product when it is about what users get, technical when it is about how it is built).
If it is not actually stuck (cambium's check was wrong), say so with \`"stuck": false\` and no actions; a wrong check is itself a root cause worth a ticket.

Root causes: only ones that need a change and that you can name with evidence (a cambium bug, a missing guard, a config gap, a process that keeps mislabelling). A one-off human relabel needs none. Each ticket's \`body\` is a task a worker could do unattended: the evidence, the change, and acceptance checks. \`fingerprint\` names the cause in a few kebab-case words, the same every time it recurs (e.g. \`sweep-skips-foreign-host-lease\`). \`repo\` is where the change belongs, one of: ${repos.join(', ')} (default ${repo}).

End your final message with exactly one fenced JSON block, and nothing after it:
\`\`\`json
{ "stuck": true, "how": "…", "actions": [ { "do": "…" } ], "rootCauses": [ { "title": "…", "body": "…", "fingerprint": "…", "repo": "${repo}" } ] }
\`\`\`
\`how\` is the sequence of events, with times and evidence; cambium posts it on the issue.

--- Issue #${issue.number}: ${issue.title} (${issue.url})
State: ${issue.state} · labels: ${issue.labels.join(', ') || '(none)'}
${issue.body}
${marker ? `\n--- cambium's marker\n${JSON.stringify(marker, null, 2)}\n` : '\n(no cambium state comment)\n'}${pr ? `\n--- PR #${pr.number} (${pr.url})\n${JSON.stringify({ state: pr.state, branch: pr.branch, headSha: pr.headSha, checks: pr.checks, failing: pr.failing, mergeable: pr.mergeable, reviewDecision: pr.reviewDecision, inMergeQueue: pr.inMergeQueue, autoMerge: pr.autoMerge, updatedAt: pr.updatedAt ?? null }, null, 2)}\n` : ''}${agentsMd ? `\n--- AGENTS.md\n${agentsMd}` : ''}`
}

/**
 * The comment that documents a rescue on the item.
 * @param {{ stuck: Stuck, result: Rescue, done: string[], filed: { slug: string, number: number, title: string, again: boolean }[] }} r
 */
export function rescueReport({ stuck, result, done, filed }) {
  return [
    result.stuck ? '**Rescue: this issue was stuck.**' : '**Rescue: checked; not stuck after all.**',
    '',
    '**What cambium saw**',
    symptomList(stuck.symptoms),
    '',
    `**${result.stuck ? 'How it got stuck' : 'Why it looked stuck'}**`,
    result.how,
    ...(done.length ? ['', '**What rescue did**', ...done.map((d) => `- ${d}`)] : []),
    ...(filed.length
      ? [
          '',
          '**Root causes**',
          ...filed.map(
            (f) => `- ${f.slug}#${f.number} ${f.title}${f.again ? ' (already open; noted this recurrence)' : ''}`,
          ),
        ]
      : []),
    '',
    "_Rescued by cambium's rescue graph._",
  ].join('\n')
}
