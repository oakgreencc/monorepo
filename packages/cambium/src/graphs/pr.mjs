// @ts-check
/**
 * The PR graph: what happens to an agent PR once its task graph has ended. Every tick, Watch (graph-engine.mjs)
 * starts one turn at `assess` for each open agent PR whose CI has settled and whose issue has no Task queued or
 * running; `assess` decides, one step acts, and the turn ends. No waits: the next tick assesses again.
 *
 * - merge: green and clean. Behind its base → update the branch (the new head's CI is the next tick's question);
 *   otherwise `graft pr merge --auto`. A refusal a human must clear → `q:human` + `why:approve`.
 * - rework: red CI, a conflict, or changes requested → back to the task graph through `q:task`, with the PR's
 *   state as the reason (a fresh attempt budget, at most `phases.task.maxReworks` reworks). Red CI while the base
 *   is red (base-health.mjs) holds instead, except on the repair issue.
 * - close: the issue is closed, or a newer agent PR closes the same issue → the PR is closed with a comment.
 * - human: reworks spent, a merge only a human may make, auto-merge armed and green but BLOCKED for
 *   `mergeStallMinutes` (the reason names the blocker where GitHub says, merge-stall.mjs), or not merged within
 *   `mergeQueueMinutes`.
 * - hold: nothing to do this tick (a refusal waiting out its retry window, a repo cambium does not merge).
 *
 * A merged PR (its issue still open) goes to `close-out`: the issue is closed and the branch deleted. The PR graph's state is the issue's
 * marker (graph `pr`), like the task graph's.
 *
 * An issue already in `q:human` is the human's: the PR graph only takes it back to merge a PR that is green and
 * clean (a worker's PR that landed after its issue was handed over), never to rework or close it.
 */
import { z } from 'zod'
import { defineGraph, defineNode, END } from '../graph/index.mjs'
import { failureSummary, iso, markerOf, MIN, setMarker } from '../issue-state.mjs'
import { Q, WHY } from '../labels.mjs'
import { withHistory } from '../marker.mjs'
import { baseRed, isRepair } from '../base-health.mjs'
import { blockedMinutes, readRules, stallReason } from '../merge-stall.mjs'
import { declare, failure, issueOf, landAt, nodeAt, snapOf, task } from './task.mjs'

/**
 * @typedef {import('./task.mjs').TaskCtx} TaskCtx
 * @typedef {import('../github.mjs').PullRequest} PullRequest
 * @typedef {import('../marker.mjs').Marker} Marker
 */

/** How long a refused merge holds before cambium asks again on the same head (a red base clears without a push). */
export const MERGE_RETRY_MINUTES = 10

/** graft's words for a refusal no retry clears (pr-policy.mjs): a human merges, approves, or fixes the policy. */
const NEEDS_HUMAN =
  /a human merges it|hand the PR over|code owners' to approve|agents merge only into|lets no agent merge|does not parse/i

const Empty = z.object({})
const PrRef = z.object({ pr: z.number().int(), branch: z.string() })
const Human = z.object({ ...failure, why: z.string() })

/** The PR this turn is about. @param {TaskCtx} ctx */
function prOf(ctx) {
  const { pr } = ctx.subject
  if (!pr) throw new Error(`${ctx.subject.slug}#${ctx.subject.number}: the PR graph runs with a PR`)
  return pr
}

/** @param {TaskCtx} ctx */
const repoOf = (ctx) => ctx.config.repos.find((r) => r.slug === ctx.subject.slug)

/** When the PR was submitted: the marker's `submittedAt`, else the PR's creation. @param {PullRequest} pr @param {Marker} m */
const submittedAt = (pr, m) => Date.parse(m.submittedAt ?? pr.createdAt ?? '') || null

/** A newer open agent PR that closes the same issue makes this one obsolete. @param {TaskCtx} ctx @param {PullRequest} pr */
function supersededBy(ctx, pr) {
  const newer = snapOf(ctx).prs.filter(
    (p) => p.state === 'OPEN' && p.number > pr.number && p.closes.includes(ctx.subject.number),
  )
  return newer.at(-1) ?? null
}

/** Why this PR needs a worker again, or null. @param {PullRequest} pr */
function reworkReason(pr) {
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return { outcome: 'ci-red', reason: failureSummary(pr) }
  if (pr.mergeable === 'CONFLICTING')
    return {
      outcome: 'conflict',
      reason: `PR #${pr.number} conflicts with its base: bring the base in (\`graft advance ${pr.branch}\`, resolve, publish again).`,
    }
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    return {
      outcome: 'changes-requested',
      reason: `A reviewer requested changes on PR #${pr.number}: read the reviews (\`graft pr view ${pr.number} --comments\`) and address them.`,
    }
  return null
}

// ---- Edge predicates (their names label the Mermaid edges)

const merged = (/** @type {{ to: string }} */ o) => o.to === 'merged'
const toMerge = (/** @type {{ to: string }} */ o) => o.to === 'merge'
const toRework = (/** @type {{ to: string }} */ o) => o.to === 'rework'
const toClose = (/** @type {{ to: string }} */ o) => o.to === 'close'
const toHumanInbox = (/** @type {{ to: string }} */ o) => o.to === 'human'
const needsApproval = (/** @type {{ to: string }} */ o) => o.to === 'human'
const reworksSpent = (/** @type {{ to: string }} */ o) => o.to === 'human'

// ---- Nodes

const Assessed = z.discriminatedUnion('to', [
  z.object({ to: z.literal('merged'), pr: z.number().int() }),
  z.object({ to: z.literal('merge'), pr: z.number().int(), branch: z.string() }),
  z.object({ to: z.literal('rework'), ...failure, pr: z.number().int(), failedSha: z.string().nullable() }),
  z.object({ to: z.literal('close'), pr: z.number().int(), reason: z.string() }),
  z.object({ to: z.literal('human'), ...failure, why: z.string() }),
  z.object({ to: z.literal('hold') }),
])

const assess = declare(
  defineNode({
    name: 'assess',
    input: Empty,
    output: Assessed,
    /** Decide, in order: merged, close, rework, merge, stall, hold. Reads only; the next node writes. @param {{}} _ @param {TaskCtx} ctx */
    run: async (_, ctx) => {
      const issue = issueOf(ctx)
      const pr = prOf(ctx)
      const m = markerOf(issue)
      const human = issue.labels.includes(Q.human)
      const hold = /** @type {const} */ ({ to: 'hold' })
      const ref = { pr: pr.number, branch: pr.branch }
      if (pr.state === 'MERGED') return { to: 'merged', pr: pr.number }

      if (issue.state !== 'OPEN')
        return { to: 'close', pr: pr.number, reason: `Issue #${issue.number} is closed, so this PR has nothing to do.` }
      if (!human) {
        const newer = supersededBy(ctx, pr)
        if (newer) return { to: 'close', pr: pr.number, reason: `Superseded by #${newer.number} for #${issue.number}.` }
        const why = reworkReason(pr)
        // Red CI on a red base is most likely the base's (base-health.mjs): no rework is charged for it, and the PR
        // is assessed again once the base is green. The repair issue's own PR is reworked as usual.
        if (why?.outcome === 'ci-red' && baseRed(snapOf(ctx)) && !isRepair(issue)) return hold
        if (why) return { to: 'rework', ...why, pr: pr.number, failedSha: pr.headSha }
      }

      const green =
        pr.checks === 'SUCCESS' && pr.mergeable !== 'CONFLICTING' && pr.reviewDecision !== 'CHANGES_REQUESTED'
      const r = m.mergeRefusal
      const refusedHere = Boolean(r && r.sha === pr.headSha)
      // In q:human because of a refusal on this head: the human's, until the head changes.
      if (human && (!green || (refusedHere && m.graph === prGraph.name))) return hold
      const merges = repoOf(ctx)?.merge === 'green'
      if (green && merges && !pr.autoMerge && !pr.inMergeQueue) {
        if (!refusedHere || !r || ctx.tick.now - Date.parse(r.at) > MERGE_RETRY_MINUTES * MIN)
          return { to: 'merge', ...ref }
      }
      if (human) return hold

      // Armed, green, and still BLOCKED: a rule its checks do not show (a ruleset review, a code owner's review, a
      // required check that never reports) holds it, and nothing on cambium's side will change that. The base's
      // rules are read only now, past the threshold, to name the blocker (merge-stall.mjs).
      const stall = ctx.config.mergeStallMinutes
      const mins = blockedMinutes(pr, ctx.tick.now)
      if (stall > 0 && green && mins !== null && mins >= stall) {
        const where = { repo: ctx.subject.slug, issue: issue.number }
        const rules = await readRules(ctx.github, ctx.subject.slug, pr, (msg) =>
          ctx.log('error', `PR #${pr.number}: ${msg}`, where),
        )
        return {
          to: 'human',
          reason: stallReason(pr, mins, rules),
          outcome: 'merge-blocked',
          pr: pr.number,
          why: WHY.approve,
        }
      }

      const since = submittedAt(pr, m)
      const cap = ctx.config.mergeQueueMinutes
      if (since !== null && ctx.tick.now - since > cap * MIN)
        return {
          to: 'human',
          reason: `PR #${pr.number} not merged within ${cap} min of submission${r ? `. Last refusal: ${r.reason}` : ''}`,
          outcome: 'stalled',
          pr: pr.number,
          why: WHY.approve,
        }
      return hold
    },
  }),
  {
    queue: null,
    running: false,
    about: 'Reads the PR and decides, in order: merged, close, rework, merge, stall or hold. Writes nothing.',
  },
)

const merge = declare(
  defineNode({
    name: 'merge',
    input: PrRef,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('done') }),
      z.object({ to: z.literal('human'), ...failure, why: z.string() }),
    ]),
    /**
     * Behind its base (read live, so a merge earlier in this tick counts): update the branch instead; its green was
     * earned on an older base, and two PRs green on the same base can be red together. Otherwise merge through
     * `graft pr merge --auto`, so graft's merge policy decides. A refusal is recorded on the marker and asked
     * again on a new head or after {@link MERGE_RETRY_MINUTES}; one only a human can clear goes to `q:human`.
     * @param {z.infer<typeof PrRef>} input @param {TaskCtx} ctx
     */
    run: async (input, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      const pr = prOf(ctx)
      const m = markerOf(issue)
      const at = iso(ctx.tick.now)
      /** @type {string} */
      let outcome
      /** @type {string | null} */
      let note = null
      /** @type {string | null} */
      let refused = null
      try {
        const { behind, base } = await ctx.github.behindBase(slug, input.pr)
        if (behind > 0) {
          await ctx.github.updatePull(slug, input.pr)
          outcome = 'branch-updated'
          note = `PR #${input.pr} was ${behind} commit${behind === 1 ? '' : 's'} behind ${base}; updated it, merging once CI is green on the new head`
        } else {
          await ctx.github.mergePull(slug, input.pr)
          outcome = 'merge-armed'
        }
      } catch (err) {
        refused = `merge refused: ${/** @type {Error} */ (err)?.message ?? err}`
        outcome = 'merge-refused'
      }
      const hold = refused ?? note
      await landAt(prGraph, ctx, 'merge', {
        ...withHistory(m, { at, attempt: m.attempt, outcome, pr: input.pr, ...(hold ? { reason: hold } : {}) }),
        phase: 'task',
        pr: input.pr,
        branch: input.branch,
        // An update holds like a refusal on the head it replaced: the new head is due as soon as it is green.
        mergeRefusal: hold ? { sha: pr.headSha ?? null, at, reason: hold } : null,
        lastFailure: refused ?? m.lastFailure ?? null,
        input: null,
      })
      const where = { repo: slug, issue: issue.number }
      if (refused && NEEDS_HUMAN.test(refused))
        return { to: 'human', reason: refused, outcome: 'needs-approval', pr: input.pr, why: WHY.approve }
      if (refused) ctx.log('warn', refused.split('\n')[0], where)
      else if (note) ctx.log('info', note, where)
      else ctx.log('info', `merging PR #${input.pr}`, where)
      return { to: 'done' }
    },
  }),
  {
    queue: null,
    running: false,
    about: 'Updates a branch that is behind its base; otherwise merges through graft pr merge --auto.',
  },
)

const ReworkIn = z.object({ ...failure, pr: z.number().int(), failedSha: z.string().nullable() })

const rework = declare(
  defineNode({
    name: 'rework',
    input: ReworkIn,
    output: z.discriminatedUnion('to', [
      z.object({ to: z.literal('task') }),
      z.object({ to: z.literal('human'), ...failure, why: z.string() }),
    ]),
    /**
     * Back to the task graph at its entry, in `q:task`: attempt 1 of a fresh budget, `reworks` + 1, the PR and its
     * branch kept, the reason as `lastFailure` (the worker's prompt shows it), the head as `failedSha` (a worker
     * that pushes nothing new has not reworked it). Reworks spent → `q:human`.
     * @param {z.infer<typeof ReworkIn>} what @param {TaskCtx} ctx
     */
    run: async (what, ctx) => {
      const issue = issueOf(ctx)
      const pr = prOf(ctx)
      const m = markerOf(issue)
      const max = ctx.config.phases.task.maxReworks
      const done = m.reworks ?? 0
      if (done >= max)
        return {
          to: 'human',
          reason: `${max} rework${max === 1 ? '' : 's'} spent on PR #${pr.number}. Last: ${what.reason}`,
          outcome: 'reworks-spent',
          pr: pr.number,
          why: WHY.budget,
        }
      const at = iso(ctx.tick.now)
      await landAt(task, ctx, task.entry.node, {
        ...withHistory(m, {
          node: 'rework',
          at,
          attempt: m.attempt,
          outcome: what.outcome,
          reason: what.reason,
          pr: pr.number,
        }),
        phase: 'task',
        attempt: 1,
        reworks: done + 1,
        pr: pr.number,
        branch: pr.branch,
        lastFailure: what.reason,
        failedSha: what.failedSha,
        mergeRefusal: null,
        host: null,
        start: null,
        input: null,
      })
      ctx.log('info', `rework ${done + 1}/${max} of PR #${pr.number}: ${what.reason.split('\n')[0]}`, {
        repo: ctx.subject.slug,
        issue: issue.number,
      })
      return { to: 'task' }
    },
  }),
  {
    queue: Q.task,
    running: false,
    about: 'Back to the task graph in q:task with the PR kept and the reason as lastFailure. Reworks spent: q:human.',
  },
)

const CloseIn = z.object({ pr: z.number().int(), reason: z.string() })

const closePr = declare(
  defineNode({
    name: 'close-pr',
    input: CloseIn,
    output: Empty,
    /** Close the PR with the reason. The issue stays where it is; an open one gets a history entry. @param {z.infer<typeof CloseIn>} input @param {TaskCtx} ctx */
    run: async (input, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      await ctx.github.closePull(slug, input.pr, `${input.reason} Closed by cambium.`)
      prOf(ctx).state = 'CLOSED'
      if (issue.state === 'OPEN') {
        const m = markerOf(issue)
        await setMarker(
          ctx,
          slug,
          issue,
          withHistory(m, {
            node: 'close-pr',
            at: iso(ctx.tick.now),
            attempt: m.attempt,
            outcome: 'pr-closed',
            reason: input.reason,
            pr: input.pr,
          }),
        )
      }
      ctx.log('info', `closed PR #${input.pr}: ${input.reason}`, { repo: slug, issue: issue.number })
      return {}
    },
  }),
  { queue: null, running: false, about: 'Closes the PR with the reason. The issue stays where it is.' },
)

/** Delete a merged PR's branch once per tick. @param {TaskCtx} ctx @param {PullRequest} pr */
export async function deleteMergedBranch(ctx, pr) {
  const deleted = ctx.subject.deleted ?? new Set()
  if (!pr.branchExists || deleted.has(pr.branch)) return
  deleted.add(pr.branch)
  await ctx.github.deleteBranch(ctx.subject.slug, pr.branch)
}

const closeOut = declare(
  defineNode({
    name: 'close-out',
    input: z.object({ pr: z.number().int() }),
    output: Empty,
    /** Merged: done, out of every queue, issue closed, branch deleted. @param {{ pr: number }} input @param {TaskCtx} ctx */
    run: async (input, ctx) => {
      const { slug } = ctx.subject
      const issue = issueOf(ctx)
      if (issue.state === 'OPEN') {
        const m = markerOf(issue)
        await landAt(
          prGraph,
          ctx,
          'close-out',
          {
            ...withHistory(m, { at: iso(ctx.tick.now), attempt: m.attempt, outcome: 'merged', pr: input.pr }),
            phase: 'task',
            pr: input.pr,
            host: null,
            start: null,
            input: null,
          },
          { status: 'done' },
        )
        await ctx.github.close(slug, issue.number, `Merged in #${input.pr}. Closed by cambium.`)
        issue.state = 'CLOSED'
        ctx.log('info', `PR #${input.pr} merged; closed`, { repo: slug, issue: issue.number })
      }
      const pr = ctx.subject.pr ?? snapOf(ctx).prs.find((p) => p.number === input.pr)
      if (pr) await deleteMergedBranch(ctx, pr)
      return {}
    },
  }),
  {
    queue: null,
    running: false,
    about: 'Merged: the issue is closed and leaves every queue, and the branch is deleted.',
  },
)

const toHuman = declare(
  defineNode({
    name: 'to-human',
    input: Human,
    output: Empty,
    /** Into the Human Queue with a reason label. @param {z.infer<typeof Human>} what @param {TaskCtx} ctx */
    run: async (what, ctx) => {
      const { reason, outcome, pr, why } = what
      const issue = issueOf(ctx)
      const m = markerOf(issue)
      await landAt(
        prGraph,
        ctx,
        'to-human',
        {
          ...withHistory(m, { ...nodeAt(what), at: iso(ctx.tick.now), attempt: m.attempt, outcome, reason, pr }),
          phase: 'task',
          lastFailure: reason,
          ...(m.ask ? { ask: null } : {}),
          host: null,
          start: null,
          input: null,
        },
        { extra: [why] },
      )
      ctx.log('warn', `→ q:human (${why}): ${reason.split('\n')[0]}`, { repo: ctx.subject.slug, issue: issue.number })
      return {}
    },
  }),
  { queue: Q.human, running: false, about: 'Into q:human with a why:* reason label.' },
)

/** The PR graph. Bump `version` when a node is removed or renamed. */
export const prGraph = defineGraph({
  name: 'pr',
  about: 'Takes an agent PR whose CI has settled to merged, reworked, closed or a human.',
  version: 1,
  entry: { node: 'assess', input: () => ({}) },
  nodes: [assess, merge, rework, closePr, closeOut, toHuman],
  edges: [
    ['assess', 'close-out', merged],
    ['assess', 'merge', toMerge],
    ['assess', 'rework', toRework],
    ['assess', 'close-pr', toClose],
    ['assess', 'to-human', toHumanInbox],
    ['assess', END],
    ['merge', 'to-human', needsApproval],
    ['merge', END],
    ['rework', 'to-human', reworksSpent],
    ['rework', END],
    ['close-pr', END],
    ['close-out', END],
    ['to-human', END],
  ],
})
