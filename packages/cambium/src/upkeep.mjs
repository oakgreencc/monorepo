// @ts-check
/**
 * Clock-driven upkeep for the graph engine, run after Watch:
 *
 * - **Reap** (every `reaper.everyMinutes`, default 60): an open `agent/*` PR left alone `reaper.staleMinutes`
 *   (default 30) that cambium is not tracking — a worker killed at its wall-clock cap whose publish still landed, a
 *   PR whose body never said `Closes #n` — is adopted. Its issue (from `Closes #n`, else the branch `agent/<n>-…`) is
 *   handed to the PR graph exactly as a worker's submit would (`submit`: marker `pr`, out of every queue), so Watch
 *   merges it when green or reworks it when red, instead of a fresh Task redoing the work. A PR whose issue is closed
 *   is closed; one with no issue at all is closed after `reaper.orphanDays` (default 3). The branch stays.
 * - **Stall** (stall.mjs, every `stall.everyMinutes`): the fallback for a queue that stops moving. Unparks an orphan
 *   blocker or an overdue defer back to triage, reports a blocked-by cycle (or a chain ending in `q:human`) once as a
 *   `q:human` issue, warns once when the repo starves, and re-triages only the `q:human` issues involved whose triage
 *   inputs changed. It replaces the daily re-triage of every `q:human` issue.
 * - **Rescue** (rescue-engine.mjs, while `phases.rescue.cap > 0`): rescue workers every tick, and every
 *   `rescue.everyMinutes` a sweep for stuck items, each diagnosed and unstuck by the rescue graph.
 */
import { drive } from './graph-engine.mjs'
import { branchIssue } from './github.mjs'
import { MIN } from './issue-state.mjs'
import { RUNNING } from './labels.mjs'
import { rescueStep } from './rescue-engine.mjs'
import { stall } from './stall.mjs'
import { each } from './tick.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./github.mjs').PullRequest} PullRequest
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 */

const DAY = 24 * 60 * MIN

/**
 * What the reaper does with one open agent PR. Pure: the caller acts.
 *
 * @param {PullRequest} pr @param {Snapshot} snap @param {{ now: number, staleMinutes: number, orphanDays: number,
 *   busy: (issue: Issue) => boolean }} o
 * @returns {{ act: 'adopt', issue: Issue, link: boolean } | { act: 'close', reason: string } | { act: 'leave', why: string }}
 */
export function reapVerdict(pr, snap, { now, staleMinutes, orphanDays, busy }) {
  if (pr.state !== 'OPEN') return { act: 'leave', why: 'not open' }
  const touched = Date.parse(pr.updatedAt ?? pr.createdAt ?? '') || now
  if (now - touched < staleMinutes * MIN) return { act: 'leave', why: 'recently updated' }
  const linked = pr.closes.find((n) => snap.issues.has(n))
  const n = linked ?? branchIssue(pr.branch)
  const issue = n === null ? undefined : snap.issues.get(n)
  if (!issue) {
    if (now - touched < orphanDays * DAY) return { act: 'leave', why: 'no issue yet; within orphanDays' }
    return {
      act: 'close',
      reason: `Abandoned: no issue names this PR${n ? ` (#${n} is not readable)` : ''} and nothing has touched it for ${orphanDays} days. The branch stays, so it can be reopened.`,
    }
  }
  if (issue.state !== 'OPEN')
    return { act: 'close', reason: `Issue #${issue.number} is closed, so this PR has nothing to do.` }
  if (busy(issue)) return { act: 'leave', why: `#${issue.number} has a worker` }
  const m = issue.stateComment?.marker
  // Tracked: the PR graph (or a rework queued for this very PR) already owns it.
  if (m?.pr === pr.number) return { act: 'leave', why: `#${issue.number} already tracks it` }
  // A newer agent PR for the same issue is the live one; the PR graph closes this one once it is tracked.
  return { act: 'adopt', issue, link: linked === undefined }
}

/**
 * The clocks, in order: adopt first, so an issue whose PR the reaper takes is not re-triaged; rescue last, so it sees
 * what the others left. @param {Deps} deps @param {Ctx} ctx
 */
export async function upkeep(deps, ctx) {
  await reap(deps, ctx)
  await stall(deps, ctx)
  await rescueStep(deps, ctx)
}

/** @param {Deps} deps @param {Ctx} ctx */
export async function reap(deps, ctx) {
  const { everyMinutes, staleMinutes, orphanDays } = deps.config.reaper
  const last = Number(deps.store.get('reaper.lastRun') ?? 0)
  if (!everyMinutes || ctx.now - last < everyMinutes * MIN) return
  deps.store.set('reaper.lastRun', String(ctx.now))
  for (const [slug, snap] of ctx.snaps) {
    const busy = (/** @type {Issue} */ i) => i.labels.includes(RUNNING) || Boolean(deps.store.worker(slug, i.number))
    await each(
      deps,
      snap.prs.filter((p) => p.state === 'OPEN'),
      async (pr) => {
        const v = reapVerdict(pr, snap, { now: ctx.now, staleMinutes, orphanDays, busy })
        if (v.act === 'leave') return
        if (v.act === 'close') {
          await deps.github.closePull(slug, pr.number, `${v.reason}\n\nClosed by cambium's reaper.`)
          pr.state = 'CLOSED'
          deps.log('info', `reaper: closed PR #${pr.number}: ${v.reason}`, { repo: slug })
          return
        }
        const { issue } = v
        if (v.link) await deps.github.linkIssue(slug, pr.number, issue.number)
        if (!pr.closes.includes(issue.number)) pr.closes.push(issue.number)
        const from = issue.labels.find((l) => l.startsWith('q:')) ?? 'no queue'
        // The task graph's `submit`: marker `pr`, out of every queue; the PR graph takes it from the next tick.
        await drive(
          deps,
          ctx,
          { slug, number: issue.number, snap, issue },
          { node: 'submit', input: { pr: pr.number, branch: pr.branch } },
        )
        await deps.github.comment(
          slug,
          issue.number,
          `**Reaper:** adopted PR #${pr.number}, which nothing was tracking (was ${from}). cambium merges it when green, or reworks it.`,
        )
        deps.log('info', `reaper: adopted PR #${pr.number} (was ${from})`, { repo: slug, issue: issue.number })
      },
      (pr) => ({ repo: slug, issue: pr.number }),
    )
  }
}
