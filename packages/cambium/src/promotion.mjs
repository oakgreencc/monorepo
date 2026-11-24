// @ts-check
/**
 * Merged, not yet promoted (`engine: "graph"`): for a repo whose `release.from` ≠ `release.to`, an issue whose
 * agent PR merged into `from` carries `q:promote` (the issue stays closed) until that PR is no longer ahead of
 * `to`. Runs at the end of Watch, after close-out, whether or not the repo's daily release is on.
 *
 * - **Label.** A merged agent PR among `release.merged` (the PRs on `from` not yet in `to`) → each closed,
 *   cambium-owned issue it closes gains `q:promote` (and leaves every other queue).
 * - **Unlabel.** A closed issue with `q:promote` whose PR (the marker's `pr`, else a merged PR closing it) is no
 *   longer among `release.merged` → `q:promote` off. Skipped while `to` is missing or `from` is more than 100
 *   commits ahead (the comparison lists only the last 100, so an older PR would look promoted).
 * - **Signal.** `release.signal` `"merged"` (the default) unlabels on the above alone. `{ workflow }` also wants a
 *   deploy: the newest completed run of that workflow on `to` (watch.mjs {@link verdictOf}) succeeded, on a commit
 *   that contains the PR's merge commit. A failed newest run, no run yet, a run on an older commit, or a read
 *   that fails leaves `q:promote` on. Checked on ticks that read the comparison (`release.fresh`), so at most
 *   every `release.readEveryMinutes`. The PR's merge commit is kept in the store (`promote.merge:<repo>#<pr>`).
 */
import { key, setLabels } from './issue-state.mjs'
import { move, Q } from './labels.mjs'
import { each } from './tick.mjs'
import { verdictOf } from './watch.mjs'

/** How many commits ahead the snapshot's comparison lists (github.mjs `commits(last: 100)`). */
export const COMPARE_WINDOW = 100

/**
 * The issue → PR pairs to label and the issues to unlabel, for one repo's snapshot. Pure.
 * @param {import('./github.mjs').Snapshot} snap
 * @returns {{ label: import('./github.mjs').Issue[], unlabel: import('./github.mjs').Issue[] }}
 */
export function promotionMoves(snap) {
  const release = snap.release
  /** @type {{ label: import('./github.mjs').Issue[], unlabel: import('./github.mjs').Issue[] }} */
  const out = { label: [], unlabel: [] }
  if (!release || release.aheadBy === null) return out
  const ahead = new Set(release.merged.map((p) => p.number))
  const mergedFor = mergedPrs(snap)
  const seen = new Set()
  for (const [n, pr] of mergedFor) {
    const issue = snap.issues.get(n)
    if (!issue?.stateComment || issue.state !== 'CLOSED' || issue.labels.includes(Q.promote)) continue
    if (ahead.has(pr) && !seen.has(n)) {
      seen.add(n)
      out.label.push(issue)
    }
  }
  if (release.aheadBy > COMPARE_WINDOW) return out
  for (const issue of snap.issues.values()) {
    if (issue.state !== 'CLOSED' || !issue.labels.includes(Q.promote)) continue
    const pr = prOf(issue, mergedFor)
    if (pr !== null && !ahead.has(pr)) out.unlabel.push(issue)
  }
  return out
}

/** issue → the merged agent PR that closes it. @param {import('./github.mjs').Snapshot} snap */
function mergedPrs(snap) {
  /** @type {Map<number, number>} */
  const out = new Map()
  for (const pr of snap.prs) if (pr.state === 'MERGED') for (const n of pr.closes) out.set(n, pr.number)
  return out
}

/** The issue's PR: the marker's `pr`, else a merged PR closing it. @param {import('./github.mjs').Issue} issue @param {Map<number, number>} mergedFor */
const prOf = (issue, mergedFor) => issue.stateComment?.marker.pr ?? mergedFor.get(issue.number) ?? null

/**
 * The unlabel candidates a `{ workflow }` signal lets go: those whose PR's merge commit the newest completed run
 * of the workflow on `to` contains, when that run succeeded. Reads fail closed (logged, nothing let go).
 * @param {import('./tick.mjs').Deps} deps @param {string} slug @param {import('./github.mjs').Snapshot} snap
 * @param {import('./github.mjs').Issue[]} unlabel @param {{ workflow: string }} signal
 * @returns {Promise<import('./github.mjs').Issue[]>}
 */
export async function deployed(deps, slug, snap, unlabel, signal) {
  const release = /** @type {import('./github.mjs').Release} */ (snap.release)
  if (!unlabel.length || release.fresh === false) return []
  const name = `\`${signal.workflow}\` on \`${release.to}\``
  /** @param {unknown} err */
  const fail = (err, /** @type {number | undefined} */ issue) => {
    deps.log('error', `promotion signal ${name}: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: slug, issue })
  }
  let v
  try {
    v = verdictOf(await deps.github.workflowRuns(slug, signal.workflow, release.to))
  } catch (err) {
    fail(err)
    return []
  }
  if (v?.state !== 'green') return []
  const run = v.run
  const mergedFor = mergedPrs(snap)
  /** @type {import('./github.mjs').Issue[]} */
  const out = []
  for (const issue of unlabel) {
    const pr = /** @type {number} */ (prOf(issue, mergedFor))
    try {
      const sha = await mergeSha(deps, slug, pr)
      if (sha === null) continue
      const cmp = await deps.github.compareRange(slug, sha, run.sha)
      if (cmp.status === 'ahead' || cmp.status === 'identical') out.push(issue)
    } catch (err) {
      fail(err, issue.number)
    }
  }
  return out
}

/** A merged PR's merge commit, kept in the store once read. @param {import('./tick.mjs').Deps} deps @param {string} slug @param {number} pr */
async function mergeSha(deps, slug, pr) {
  const k = `promote.merge:${slug}#${pr}`
  const kept = deps.store.get(k)
  if (kept) return kept
  const sha = await deps.github.mergeCommit(slug, pr)
  if (sha !== null) deps.store.set(k, sha)
  return sha
}

/** @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx */
export async function trackPromotion(deps, ctx) {
  for (const [slug, snap] of ctx.snaps) {
    const moves = promotionMoves(snap)
    const { label } = moves
    const signal = deps.config.repos.find((r) => r.slug === slug)?.release.signal ?? 'merged'
    const unlabel = signal === 'merged' ? moves.unlabel : await deployed(deps, slug, snap, moves.unlabel, signal)
    const to = snap.release?.to
    await each(
      deps,
      label,
      async (issue) => {
        await setLabels(deps, slug, issue, move(issue.labels, Q.promote))
        ctx.touched.add(key(slug, issue.number))
        deps.log('info', `merged into \`${snap.release?.from}\`; waiting for promotion to \`${to}\``, {
          repo: slug,
          issue: issue.number,
        })
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
    await each(
      deps,
      unlabel,
      async (issue) => {
        await setLabels(deps, slug, issue, { add: [], remove: [Q.promote] })
        const how = signal === 'merged' ? '' : `; \`${signal.workflow}\` succeeded`
        deps.log('info', `promoted to \`${to}\`${how}`, { repo: slug, issue: issue.number })
      },
      (issue) => ({ repo: slug, issue: issue.number }),
    )
  }
}
