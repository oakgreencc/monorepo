// @ts-check
/**
 * Stalled merges: a PR with auto-merge armed and green checks that GitHub still reports `BLOCKED`
 * `mergeStallMinutes` after arming. A rule holds it that its checks do not show: a review a ruleset or the branch
 * protection requires, a code owner's review, a required check that never reported on the head.
 *
 * - An agent PR goes to `q:human` from the PR graph's `assess` (graphs/pr.mjs).
 * - Any other open PR (a human's) gets one warn event and an entry in the heartbeat (`repos[].stalls`) from the
 *   {@link watchStalls} step. cambium does not own it: no labels, no queue moves, no comments.
 *
 * Either way the reason names the blocker where GitHub says what it is ({@link stallBlockers}): the base's rules
 * are read (`GitHub.mergeRules`) only for a PR already past the threshold, once. `mergeStallMinutes` 0 turns both
 * off.
 */
import { iso, MIN } from './issue-state.mjs'

/**
 * @typedef {import('./github.mjs').PullRequest} PullRequest
 * @typedef {import('./github.mjs').MergeRules} MergeRules
 * @typedef {{
 *   number: number, url: string, title: string, branch: string, base: string | null, armedAt: string,
 *   since: string, minutes: number, reason: string,
 * }} Stall
 *   A non-agent PR stalled as of the last tick. `since`: the tick that first saw it past the threshold.
 */

/**
 * Minutes a PR has been armed, green and BLOCKED, or null when it is not all three. Green: checks pass, no
 * conflict, no changes requested.
 * @param {PullRequest} pr @param {number} now
 */
export function blockedMinutes(pr, now) {
  const green = pr.checks === 'SUCCESS' && pr.mergeable !== 'CONFLICTING' && pr.reviewDecision !== 'CHANGES_REQUESTED'
  const armedAt = Date.parse(pr.autoMergeAt ?? '') || null
  if (!green || !pr.autoMerge || pr.mergeState !== 'BLOCKED' || armedAt === null) return null
  return Math.floor((now - armedAt) / MIN)
}

/** @param {string[]} xs */
const list = (xs) => xs.map((x) => `\`${x}\``).join(', ')

/**
 * What GitHub says holds the PR, as phrases; empty when nothing can be read. Pure.
 * @param {PullRequest} pr @param {MergeRules | null} rules
 * @returns {string[]}
 */
export function stallBlockers(pr, rules) {
  /** @type {string[]} */
  const out = []
  if (rules && pr.checkNames) {
    const missing = rules.requiredChecks.filter((c) => !pr.checkNames?.includes(c))
    if (missing.length)
      out.push(`required check${missing.length === 1 ? '' : 's'} ${list(missing)} not reported on the head`)
  }
  const owners = pr.codeOwnerRequests ?? []
  if (owners.length && (rules?.codeOwners || pr.reviewDecision === 'REVIEW_REQUIRED'))
    out.push(`a code-owner review, still requested from ${owners.join(', ')}`)
  else if (rules?.codeOwners && pr.reviewDecision === 'REVIEW_REQUIRED')
    out.push('a code-owner review the base requires')
  const given = pr.approvals ?? 0
  if (rules && rules.approvals > given)
    out.push(`${rules.approvals} approving review${rules.approvals === 1 ? '' : 's'} required, ${given} given`)
  else if (!out.length && pr.reviewDecision === 'REVIEW_REQUIRED') out.push('a review GitHub reports as required')
  return out
}

/**
 * The stall reason: the blockers and the rulesets on the base when any can be read, else the generic wording.
 * @param {PullRequest} pr @param {number} mins @param {MergeRules | null} rules
 */
export function stallReason(pr, mins, rules) {
  const head = `PR #${pr.number}: auto-merge armed ${mins} min ago and its checks are green, but GitHub reports it BLOCKED.`
  const blockers = stallBlockers(pr, rules)
  const sets = rules?.rulesets.length
    ? ` Ruleset${rules.rulesets.length === 1 ? '' : 's'} on \`${pr.base ?? 'its base'}\`: ${rules.rulesets.map((r) => r.name).join(', ')}.`
    : ''
  if (blockers.length) return `${head} Held by ${blockers.join('; ')}.${sets}`
  if (sets) return `${head}${sets} One of them holds it; the PR's merge box names the rule.`
  return `${head} A rule cambium cannot see holds it: a ruleset's review or its approval for unattributed changes, or a required check that has not reported. The PR's merge box names it.`
}

/**
 * The base's rules, or null when the PR names no base or the read fails (the reason falls back).
 * @param {import('./github.mjs').GitHub} github @param {string} slug @param {PullRequest} pr
 * @param {(msg: string) => void} [onError]
 * @returns {Promise<MergeRules | null>}
 */
export async function readRules(github, slug, pr, onError) {
  if (!pr.base) return null
  try {
    return await github.mergeRules(slug, pr.base)
  } catch (err) {
    onError?.(`reading the rules on ${pr.base}: ${/** @type {Error} */ (err)?.message ?? err}`)
    return null
  }
}

/** @param {string} slug */
export const stallKey = (slug) => `stalls:${slug}`

/** The non-agent stalls the heartbeat shows. @param {import('./store.mjs').Store} store @param {string} slug @returns {Stall[]} */
export function stallStates(store, slug) {
  try {
    const v = JSON.parse(store.get(stallKey(slug)) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * The step: each repo's armed non-agent PRs (snapshot `armed`). One past `mergeStallMinutes` and new (or re-armed)
 * since the last tick: its base's rules are read, one warn event names the blocker, and it is stored for the
 * heartbeat. One still stalled keeps its reason, with no read and no event. One no longer stalled is dropped.
 * A repo not read this tick keeps what it had.
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx
 */
export async function watchStalls(deps, ctx) {
  const stall = deps.config.mergeStallMinutes
  for (const repo of deps.config.repos) {
    const key = stallKey(repo.slug)
    if (stall <= 0) {
      if (deps.store.get(key) !== null) deps.store.set(key, '[]')
      continue
    }
    const snap = ctx.snaps.get(repo.slug)
    if (!snap) continue
    const prev = new Map(stallStates(deps.store, repo.slug).map((s) => [s.number, s]))
    /** @type {Stall[]} */
    const next = []
    for (const pr of snap.armed ?? []) {
      const mins = blockedMinutes(pr, ctx.now)
      if (mins === null || mins < stall) continue
      const armedAt = /** @type {string} */ (pr.autoMergeAt)
      const known = prev.get(pr.number)
      if (known && known.armedAt === armedAt) {
        next.push({ ...known, minutes: mins })
        continue
      }
      const where = { repo: repo.slug }
      const rules = await readRules(deps.github, repo.slug, pr, (msg) =>
        deps.log('error', `stalled PR #${pr.number}: ${msg}`, where),
      )
      const reason = stallReason(pr, mins, rules)
      deps.log('warn', `stalled merge (not cambium's, ${pr.branch}): ${reason}`, where)
      next.push({
        number: pr.number,
        url: pr.url,
        title: pr.title ?? '',
        branch: pr.branch,
        base: pr.base ?? null,
        armedAt,
        since: iso(ctx.now),
        minutes: mins,
        reason,
      })
    }
    deps.store.set(key, JSON.stringify(next))
  }
}
