// @ts-check
/**
 * Adopt: an open issue filed without a queue label is triage's, not invisible. Each tick, an issue in the
 * snapshot's `unqueued` (github.mjs) that cambium has never touched gains `q:intake`, and triage takes it from
 * there: a task, a question for a person, a duplicate, a deferral. Forgetting the label costs one tick, not the
 * issue.
 *
 * Left alone:
 * - an issue with a state comment: cambium has handled it, and its fate is another graph's (a PR in flight, the
 *   rescue graph's stranded check);
 * - an issue an agent PR names (it closes it, or its branch names it): submitted;
 * - an issue cambium filed for its own reasons (`watch`, `red-base`, `rescue`, `stall`), or one carrying a label in
 *   `intake.ignoreLabels`.
 *
 * Off with `intake.adopt: false`. The search reads {@link import('./github.mjs').UNQUEUED} issues a tick, oldest
 * first, so a backlog drains a page per tick.
 */
import { REPAIR_LABEL } from './base-health.mjs'
import { branchIssue } from './github.mjs'
import { setLabels } from './issue-state.mjs'
import { move, Q, queueOf, RESCUE_LABEL, RUNNING, STALL_LABEL } from './labels.mjs'
import { each } from './tick.mjs'
import { WATCH_LABEL } from './watch.mjs'

/** Labels cambium puts on issues it files itself: never adopted. */
const OWN = new Set([WATCH_LABEL, REPAIR_LABEL, RESCUE_LABEL, STALL_LABEL])

/**
 * The issues in one repo's snapshot to adopt into `q:intake`. Pure.
 * @param {import('./github.mjs').Snapshot} snap @param {string[]} ignore
 * @returns {import('./github.mjs').Issue[]}
 */
export function adoptable(snap, ignore) {
  const named = new Set(snap.prs.flatMap((p) => [...p.closes, ...[branchIssue(p.branch)].filter((n) => n !== null)]))
  return (snap.unqueued ?? []).filter(
    (i) =>
      i.state === 'OPEN' &&
      !queueOf(i.labels) &&
      !i.labels.includes(RUNNING) &&
      !i.stateComment &&
      !named.has(i.number) &&
      !snap.issues.has(i.number) &&
      !i.labels.some((l) => OWN.has(l) || ignore.includes(l)),
  )
}

/**
 * The tick step: label each adoptable issue `q:intake` and put it in the snapshot, so triage can take it this tick.
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx
 */
export async function adopt(deps, ctx) {
  const { adopt: on, ignoreLabels } = deps.config.intake
  if (!on) return
  for (const [slug, snap] of ctx.snaps)
    await each(
      deps,
      adoptable(snap, ignoreLabels),
      async (issue) => {
        await setLabels(deps, slug, issue, move(issue.labels, Q.intake))
        snap.issues.set(issue.number, issue)
        deps.log('info', `adopted into ${Q.intake}: filed without a queue label`, { repo: slug, issue: issue.number })
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
}
