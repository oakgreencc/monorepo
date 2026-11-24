// @ts-check
/**
 * The GitHub seam. The tick sees only {@link GitHub}; the default
 * implementation shells out to `graft` so the App identity, token cache and
 * auth are graft's (set `graft.app` in the config to act as the Clock's own
 * App via `GRAFT_APP`).
 */
import { spawn } from 'node:child_process'
import { parseMarker } from './marker.mjs'
import { Q, QUEUE_LABELS, RUNNING } from './labels.mjs'
import { BASE_FIELDS, baseHealthOf } from './base-health.mjs'

/**
 * @typedef {{
 *   number: number, title: string, url: string, state: 'OPEN' | 'CLOSED', createdAt: string, body: string,
 *   labels: string[], stateComment: { id: number, marker: import('./marker.mjs').Marker, author?: string | null } | null,
 *   blockedBy: Blocker[], comments?: Comment[], updatedAt?: string | null,
 * }} Issue
 *   `stateComment.author`: the login that wrote the state comment (cambium's). `comments`: the newest 20, oldest
 *   first, for human-reply detection (human-reply.mjs).
 * @typedef {{ id?: number, author: string | null, bot: boolean, createdAt: string, body: string }} Comment
 *   `bot`: GitHub says the author is a `Bot` (an App). `id`: GitHub's database id (triage-inputs.mjs).
 * @typedef {{ number: number, state: 'OPEN' | 'CLOSED', closedAt: string | null, title?: string, url?: string }} Blocker
 *   An issue GitHub records as blocking this one (the "blocked by" relationship).
 * @typedef {{ name: string, url: string | null, summary: string }} FailingCheck
 * @typedef {{
 *   number: number, url: string, branch: string, state: 'OPEN' | 'MERGED' | 'CLOSED', headSha: string | null,
 *   branchExists: boolean, inMergeQueue: boolean, autoMerge: boolean,
 *   checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null, failing: FailingCheck[], closes: number[],
 *   mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null,
 *   reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null, createdAt: string | null,
 *   updatedAt?: string | null, mergeState?: string | null, autoMergeAt?: string | null,
 *   title?: string, draft?: boolean, queue?: { position: number | null, state: string | null } | null,
 *   additions?: number | null, deletions?: number | null, files?: number | null, counts?: CheckCount[],
 * }} PullRequest
 *   `title`, `draft`, `queue` (its merge-queue entry), the size and `counts` (check runs and statuses by state) are
 *   for canopy's board only (queue-view.mjs).
 * @typedef {{ state: string, count: number }} CheckCount
 *   `mergeable`: GitHub's conflict check against the base (UNKNOWN while it computes). `mergeState`: GitHub's
 *   `mergeStateStatus` (BLOCKED: a rule holds it, whatever its checks say). `autoMergeAt`: when auto-merge was armed. `reviewDecision`: null
 *   when the base requires no review.
 * @typedef {{
 *   number: number, url: string, title: string, state: 'OPEN' | 'MERGED' | 'CLOSED', createdAt: string,
 *   head: string, base: string, headSha: string | null, labels: string[], approved: boolean, autoMerge: boolean,
 *   stateComment: { id: number, marker: import('./marker.mjs').Marker } | null,
 * }} PromotionPr
 *   A promotion PR (`from` → `to`, or labelled `q:promote`). Its state comment is a PR (issue) comment, so it
 *   goes through the same marker read/write path as an issue's. `approved`: `reviewDecision` is APPROVED, or
 *   (no decision against it) a latest review approves and none requests changes.
 * @typedef {{
 *   from: string, to: string, aheadBy: number | null, merged: { number: number, title: string }[],
 *   prs: PromotionPr[], fresh?: boolean,
 * }} Release
 *   The repo's promotion state (when its `release` is on): how far `from` is ahead of `to` (null: `to` does not
 *   exist), the PRs merged into `from` since `to` (oldest first, from the last 100 commits ahead), and the
 *   promotion PRs: open ones from `from` to `to` plus any (open, merged or closed) still labelled `q:promote`.
 *   `fresh`: false when this tick did not read it and it is the last read's answer, kept (`release.readEveryMinutes`).
 * @typedef {{
 *   issues: Map<number, Issue>, prs: PullRequest[], release?: Release | null,
 *   base?: import('./base-health.mjs').BaseHealth,
 *   rateLimit?: { cost: number, remaining: number, resetAt: string } | null, unqueued?: Issue[],
 *   closed?: ClosedPull[],
 * }} Snapshot
 *   `rateLimit`: the GraphQL budget after the snapshot read (tick.mjs `read` pauses before it runs out).
 *   `unqueued`: open issues in no queue and without a lease, oldest first, at most {@link UNQUEUED}; read while
 *   `intake.adopt` is on, for adoption into `q:intake` (adopt.mjs). Not in `issues`.
 *   `closed`: the newest PRs closed without merging and the issues they would have closed, for the stranded
 *   items on canopy's board (queue-view.mjs).
 * @typedef {{
 *   number: number, title: string, url: string, branch: string, closedAt: string | null,
 *   closes: { number: number, title: string, url: string, state: string, createdAt: string | null, updatedAt: string | null }[],
 * }} ClosedPull
 * @typedef {{ sha: string, behind: number, url: string | null }} GreenCommit
 *   `behind`: how many first-parent commits the ref's tip is past it. `url`: the green run.
 * @typedef {{
 *   status: 'ahead' | 'behind' | 'identical' | 'diverged', aheadBy: number, behindBy: number, files: number,
 *   commits: { sha: string, parents: string[], message: string }[],
 * }} Range
 *   `files`: how many files differ between the merge base and `head`. `commits`: oldest first, at most 250.
 *   `base`: the base branch's health, when the repo has a `requiredCheck`.
 * @typedef {{
 *   read(slug: string, opts?: { fresh?: boolean }): Promise<Snapshot>,
 *   label(slug: string, number: number, change: { add: string[], remove: string[] }): Promise<void>,
 *   writeState(slug: string, number: number, commentId: number | null, body: string): Promise<number>,
 *   close(slug: string, number: number, body: string, opts?: { reason?: 'completed' | 'not_planned' | 'duplicate' }): Promise<void>,
 *   comment(slug: string, number: number, body: string): Promise<void>,
 *   createIssue(slug: string, issue: { title: string, body: string, labels: string[] }): Promise<{ number: number, url: string }>,
 *   deleteBranch(slug: string, branch: string): Promise<void>,
 *   openPull(slug: string, pr: { head: string, base: string, title: string, body: string }): Promise<{ number: number, url: string }>,
 *   editPull(slug: string, number: number, change: { title: string, body: string }): Promise<void>,
 *   closePull(slug: string, number: number, comment: string): Promise<void>,
 *   greenCommit(slug: string, ref: string, check: string | null, depth: number): Promise<GreenCommit | null>,
 *   compareRange(slug: string, base: string, head: string): Promise<Range>,
 *   branches(slug: string, prefix: string): Promise<string[]>,
 *   createBranch(slug: string, name: string, sha: string): Promise<void>,
 *   mergePull(slug: string, number: number): Promise<void>,
 *   behindBase(slug: string, number: number): Promise<{ behind: number, base: string }>,
 *   updatePull(slug: string, number: number): Promise<void>,
 *   linkIssue(slug: string, pr: number, issue: number): Promise<void>,
 *   addBlockedBy(slug: string, number: number, blocker: number): Promise<{ state: 'OPEN' | 'CLOSED' }>,
 *   closedPulls(slug: string): Promise<PullRequest[]>,
 *   readIssues(slug: string, numbers: number[]): Promise<Map<number, Issue>>,
 *   workflowRuns(slug: string, workflow: string, branch: string): Promise<import('./watch.mjs').WorkflowRun[]>,
 *   mergeCommit(slug: string, number: number): Promise<string | null>,
 * }} GitHub
 *   `workflowRuns`: the newest completed push or schedule runs of `workflow` (file name or id) on `branch`, newest
 *   first (watch.mjs). `mergeCommit`: the commit a merged PR made on its base (null: not merged), for a workflow
 *   promotion signal (promotion.mjs).
 *   `greenCommit`: the newest commit on `ref`'s first-parent line, at most `depth` back, whose `check` concluded
 *   success (`check` null: the tip). `compareRange`: GitHub's compare of `base...head`. `branches`: the branch
 *   names starting with `prefix`. `createBranch`: a new branch at `sha`.
 *   `behindBase`: how many commits of its base the PR's head lacks, read live (not from the tick's snapshot), so a
 *   merge earlier in the same tick counts. `updatePull`: merge the base into the PR (`graft pr update`).
 *   `linkIssue`: put `Closes #<issue>` at the top of the PR's body, so the PR names the issue it closes.
 *   `addBlockedBy`: record GitHub's "blocked by" dependency of issue `number` on `blocker`; resolves the blocker's state.
 *   `closedPulls`: the newest {@link CLOSED_PULLS} `agent/*` PRs closed without merging (the rescue graph finds the
 *   issues they leave stranded). `readIssues`: these issues, whatever their labels or state; a number that is not
 *   an issue is left out.
 */

const PR_FIELDS = `number url title headRefName state headRefOid isDraft isInMergeQueue body mergeable mergeStateStatus reviewDecision createdAt updatedAt
  additions deletions changedFiles
  headRef { id }
  autoMergeRequest { enabledAt }
  mergeQueueEntry { position state }
  closingIssuesReferences(first: 5) { nodes { number } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) {
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
    nodes {
    __typename
    ... on CheckRun { name conclusion detailsUrl title summary }
    ... on StatusContext { context state targetUrl description }
  } } } } } }`

/** How many open issues in no queue one snapshot reads (oldest first): adoption takes them a page at a time. */
export const UNQUEUED = 20

/**
 * One query per repo per tick: the queued issues and the agent PRs with their checks; with `$release`, also the
 * promotion PRs and how far `$from` is ahead of `$to` (see {@link Release}). With `$tips`, the tips of `$from` and
 * `$to` (cheap): a change between release reads means a merge, and the next tick reads the release part.
 */
export const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $labels: [String!], $release: Boolean!, $tips: Boolean!, $from: String!, $to: String!, $health: Boolean!, $baseRef: String!, $check: String!, $adopt: Boolean!, $unqueued: String!) {
  unqueued: search(query: $unqueued, type: ISSUE, first: ${UNQUEUED}) @include(if: $adopt) { nodes { ... on Issue { ...I } } }
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(labels: $labels, states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) { pageInfo { hasNextPage endCursor } nodes { ...I } }
    open: pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
    promoteRef: pullRequests(headRefName: $from, baseRefName: $to, states: OPEN, first: 10) @include(if: $release) { nodes { ...P } }
    promoteLabelled: pullRequests(labels: ["${Q.promote}"], first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $release) { nodes { ...P } }
    awaiting: issues(labels: ["${Q.promote}"], states: CLOSED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $release) { nodes { ...I } }
    fromTip: ref(qualifiedName: $from) @include(if: $tips) { target { oid } }
    toTip: ref(qualifiedName: $to) @include(if: $tips) { target { oid } }
    toRef: ref(qualifiedName: $to) @include(if: $release) {
      compare(headRef: $from) {
        aheadBy
        commits(last: 100) { nodes { associatedPullRequests(first: 3) { nodes { number title baseRefName state } } } }
      }
    }
    stranding: pullRequests(states: CLOSED, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url headRefName closedAt closingIssuesReferences(first: 5) { nodes { number title url state createdAt updatedAt } } }
    }
    ${BASE_FIELDS}
  }
}
fragment I on Issue {
  number title url state createdAt updatedAt body
  labels(first: 30) { nodes { name } }
  blockedBy(first: 20) { nodes { number title url state closedAt } }
  comments(first: 100) { nodes { databaseId body author { login } } }
  recent: comments(last: 20) { nodes { databaseId createdAt body author { login __typename } } }
}
fragment P on PullRequest {
  number url title state createdAt headRefName baseRefName headRefOid reviewDecision
  autoMergeRequest { enabledAt }
  latestReviews(first: 20) { nodes { state } }
  labels(first: 30) { nodes { name } }
  comments(first: 100) { nodes { databaseId body author { login } } }
}`

/**
 * The search for open issues in no queue and without a lease, oldest first, minus those carrying `ignore` labels.
 * @param {string} slug @param {string[]} [ignore]
 */
export const unqueuedSearch = (slug, ignore = []) =>
  [
    `repo:${slug}`,
    'is:issue',
    'is:open',
    ...[...QUEUE_LABELS, RUNNING, ...ignore].map((l) => `-label:"${l}"`),
    'sort:created-asc',
  ].join(' ')

/** GitHub's closing keywords before a same-repo `#n` (graft's closing-refs.mjs, without cross-repo refs). */
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)\b/gi

/**
 * The issues a PR body says it closes. GitHub links these (`closingIssuesReferences`) only for a PR into the
 * DEFAULT branch, so a repo whose agents target another base (sektorapp: `develop`) gets nothing from GitHub;
 * cambium reads the body itself.
 * @param {string | null | undefined} body @returns {number[]}
 */
export function bodyCloses(body) {
  return [...new Set([...(body ?? '').matchAll(CLOSING)].map((m) => Number(m[1])))]
}

/** The issues `numbers`, by alias, for {@link addIssues}. @param {number[]} numbers */
export const issuesQuery = (numbers) =>
  `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${numbers
    .map((n) => `i${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { ...I } }`)
    .join(' ')} } }
${SNAPSHOT_QUERY.slice(SNAPSHOT_QUERY.indexOf('fragment I on Issue'), SNAPSHOT_QUERY.indexOf('fragment P on'))}`

/** The queued issues after `$after`: the snapshot's first page holds 100, a busy repo has more. */
export const ISSUES_PAGE_QUERY = `query($owner: String!, $name: String!, $labels: [String!], $after: String) { repository(owner: $owner, name: $name) {
    issues(labels: $labels, states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) { pageInfo { hasNextPage endCursor } nodes { ...I } }
} }
${SNAPSHOT_QUERY.slice(SNAPSHOT_QUERY.indexOf('fragment I on Issue'), SNAPSHOT_QUERY.indexOf('fragment P on'))}`

/** How many closed-unmerged PRs {@link CLOSED_PULLS_QUERY} reads, newest first. */
export const CLOSED_PULLS = 50

/** The newest closed (unmerged) PRs, for the rescue graph. */
export const CLOSED_PULLS_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    closed: pullRequests(states: CLOSED, first: ${CLOSED_PULLS}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
} }
`

/** Pages read past the first: 10 × 100 queued issues per repo is far past any real queue. */
const MAX_ISSUE_PAGES = 10

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/**
 * The first comment holding a marker (from `botLogin` only, when set). Issues and PRs alike.
 * @param {any} n an issue or PR node with `comments` @param {string | null} botLogin
 * @returns {{ id: number, marker: import('./marker.mjs').Marker, author: string | null } | null}
 */
function stateCommentOf(n, botLogin) {
  const comment = (n.comments?.nodes ?? []).find(
    (/** @type {any} */ c) => parseMarker(c.body) && (!botLogin || c.author?.login === botLogin),
  )
  return comment
    ? {
        id: comment.databaseId,
        marker: /** @type {any} */ (parseMarker(comment.body)),
        author: comment.author?.login ?? null,
      }
    : null
}

/** @param {any} n @returns {string[]} */
const labelsOf = (n) => (n.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name)

/**
 * The `$release` part of the answer → {@link Release}.
 * @param {any} repo @param {{ from: string, to: string }} branches @param {string | null} botLogin
 * @returns {Release}
 */
function normalizeRelease(repo, { from, to }, botLogin) {
  /** @type {Map<number, PromotionPr>} */
  const prs = new Map()
  for (const p of [...(repo.promoteRef?.nodes ?? []), ...(repo.promoteLabelled?.nodes ?? [])]) {
    if (!p || prs.has(p.number)) continue
    const reviews = (p.latestReviews?.nodes ?? []).map((/** @type {any} */ r) => r.state)
    prs.set(p.number, {
      number: p.number,
      url: p.url ?? '',
      title: p.title ?? '',
      state: p.state,
      createdAt: p.createdAt,
      head: p.headRefName,
      base: p.baseRefName,
      headSha: p.headRefOid ?? null,
      labels: labelsOf(p),
      approved:
        p.reviewDecision === 'APPROVED' ||
        (p.reviewDecision !== 'CHANGES_REQUESTED' &&
          reviews.includes('APPROVED') &&
          !reviews.includes('CHANGES_REQUESTED')),
      autoMerge: Boolean(p.autoMergeRequest),
      stateComment: stateCommentOf(p, botLogin),
    })
  }
  const compare = repo.toRef?.compare ?? null
  /** @type {Map<number, { number: number, title: string }>} */
  const merged = new Map()
  for (const c of compare?.commits?.nodes ?? [])
    for (const p of c?.associatedPullRequests?.nodes ?? [])
      if (p.baseRefName === from && p.state === 'MERGED' && !merged.has(p.number))
        merged.set(p.number, { number: p.number, title: p.title ?? '' })
  return {
    from,
    to,
    aheadBy: compare ? (compare.aheadBy ?? 0) : null,
    merged: [...merged.values()],
    prs: [...prs.values()],
    fresh: true,
  }
}

/** The fields of the snapshot's `$release` part, kept between release reads. */
const RELEASE_FIELDS = /** @type {const} */ (['promoteRef', 'promoteLabelled', 'awaiting', 'toRef'])

/** The tips of `from` and `to` in an answer, as one comparable string. @param {any} repo */
const tipsOf = (repo) => `${repo?.fromTip?.target?.oid ?? ''}:${repo?.toTip?.target?.oid ?? ''}`

/** An issue node → {@link Issue}. @param {any} n @param {string | null} botLogin @returns {Issue} */
function toIssue(n, botLogin) {
  return {
    number: n.number,
    title: n.title ?? '',
    url: n.url ?? '',
    state: n.state,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt ?? null,
    body: n.body ?? '',
    labels: labelsOf(n),
    stateComment: stateCommentOf(n, botLogin),
    blockedBy: (n.blockedBy?.nodes ?? []).filter(Boolean).map((/** @type {any} */ b) => ({
      number: b.number,
      state: b.state === 'OPEN' ? 'OPEN' : 'CLOSED',
      closedAt: b.closedAt ?? null,
      ...(b.title !== undefined ? { title: b.title ?? '' } : {}),
      ...(b.url !== undefined ? { url: b.url ?? '' } : {}),
    })),
    comments: (n.recent?.nodes ?? []).filter(Boolean).map((/** @type {any} */ c) => ({
      ...(c.databaseId ? { id: c.databaseId } : {}),
      author: c.author?.login ?? null,
      bot: c.author?.__typename === 'Bot',
      createdAt: c.createdAt ?? '',
      body: c.body ?? '',
    })),
  }
}

/** The issue an agent branch names: `agent/<n>-<slug>` or `agent/issue-<n>`. @param {string} branch */
export const branchIssue = (branch) => {
  const m = /^agent\/(?:issue-)?(\d+)(?:-|$)/.exec(branch)
  return m ? Number(m[1]) : null
}

/**
 * The issues the snapshot has not read that PRs name: the ones they close, and for an open PR that closes none, the
 * one its branch names (the reaper pairs those). @param {Snapshot} snap @returns {number[]}
 */
export const unreadCloses = (snap) => {
  const named = snap.prs.flatMap((p) =>
    p.closes.length || p.state !== 'OPEN' ? p.closes : [branchIssue(p.branch)].filter((n) => n !== null),
  )
  return [...new Set(named.filter((n) => !snap.issues.has(n)))]
}

/**
 * Add the answer to {@link issuesQuery} to the snapshot; a number that is not an issue (a PR, or gone) is dropped
 * from every PR's `closes`.
 * @param {Snapshot} snap @param {any} data @param {number[]} asked @param {string | null} [botLogin]
 */
export function addIssues(snap, data, asked, botLogin = null) {
  const repo = (data?.data ?? data)?.repository ?? {}
  for (const n of asked) {
    const node = repo[`i${n}`]
    if (node?.__typename === 'Issue') snap.issues.set(n, toIssue(node, botLogin))
  }
  for (const p of snap.prs) p.closes = p.closes.filter((n) => snap.issues.has(n))
  return snap
}

/** The `stranding` part of the answer → {@link ClosedPull}s. @param {any[]} nodes @returns {ClosedPull[]} */
const closedOf = (nodes) =>
  nodes.filter(Boolean).map((p) => ({
    number: p.number,
    title: p.title ?? '',
    url: p.url ?? '',
    branch: p.headRefName ?? '',
    closedAt: p.closedAt ?? null,
    closes: (p.closingIssuesReferences?.nodes ?? []).filter(Boolean).map((/** @type {any} */ i) => ({
      number: i.number,
      title: i.title ?? '',
      url: i.url ?? '',
      state: i.state,
      createdAt: i.createdAt ?? null,
      updatedAt: i.updatedAt ?? null,
    })),
  }))

/**
 * GraphQL `data` → {@link Snapshot}. Only `agent/*` PRs are kept.
 *
 * @param {any} data
 * @param {{ botLogin?: string | null, release?: { from: string, to: string } | null }} [opts]
 *   `botLogin`: when set, only that login's markers count. `release`: the branches the query asked about.
 * @returns {Snapshot}
 */
export function normalize(data, { botLogin = null, release = null, health = null } = {}) {
  const repo = (data?.data ?? data)?.repository
  if (!repo) throw new Error('snapshot: no repository in the answer')
  /** @type {Map<number, Issue>} */
  const issues = new Map()
  const addIssue = (/** @type {any} */ n) => {
    if (!issues.has(n.number)) issues.set(n.number, toIssue(n, botLogin))
    return n.number
  }
  for (const n of [...(repo.issues?.nodes ?? []), ...(repo.awaiting?.nodes ?? [])]) addIssue(n)
  /** @type {PullRequest[]} */
  const prs = []
  for (const p of [...(repo.open?.nodes ?? []), ...(repo.merged?.nodes ?? [])]) {
    if (!p?.headRefName?.startsWith('agent/')) continue
    const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null
    const failing = (rollup?.contexts?.nodes ?? [])
      .filter((/** @type {any} */ c) => FAILED.has(c.__typename === 'StatusContext' ? c.state : c.conclusion))
      .map((/** @type {any} */ c) => ({
        name: c.name ?? c.context,
        url: c.detailsUrl ?? c.targetUrl ?? null,
        summary: String(c.title ?? c.description ?? '') + (c.summary ? `\n${String(c.summary).slice(0, 800)}` : ''),
      }))
    prs.push({
      number: p.number,
      url: p.url,
      branch: p.headRefName,
      state: p.state,
      headSha: p.headRefOid ?? null,
      branchExists: Boolean(p.headRef),
      inMergeQueue: Boolean(p.isInMergeQueue),
      autoMerge: Boolean(p.autoMergeRequest),
      autoMergeAt: p.autoMergeRequest?.enabledAt ?? null,
      checks: rollup?.state ?? null,
      failing,
      closes: [
        ...new Set([
          ...(p.closingIssuesReferences?.nodes ?? []).map((/** @type {any} */ n) => n.number),
          ...bodyCloses(p.body),
        ]),
      ],
      mergeable: p.mergeable ?? null,
      mergeState: p.mergeStateStatus ?? null,
      reviewDecision: p.reviewDecision ?? null,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      title: p.title ?? '',
      draft: Boolean(p.isDraft),
      queue: p.mergeQueueEntry
        ? { position: p.mergeQueueEntry.position ?? null, state: p.mergeQueueEntry.state ?? null }
        : null,
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      files: p.changedFiles ?? null,
      counts: [
        ...(rollup?.contexts?.checkRunCountsByState ?? []),
        ...(rollup?.contexts?.statusContextCountsByState ?? []),
      ],
    })
  }
  const unqueued = repo.unqueued
    ? (repo.unqueued.nodes ?? [])
        .filter((/** @type {any} */ n) => n?.number && !issues.has(n.number))
        .map((/** @type {any} */ n) => toIssue(n, botLogin))
    : null
  return {
    issues,
    prs,
    ...(unqueued ? { unqueued } : {}),
    ...(repo.stranding ? { closed: closedOf(repo.stranding.nodes ?? []) } : {}),
    ...(release ? { release: normalizeRelease(repo, release, botLogin) } : {}),
    ...(health ? { base: baseHealthOf(repo, health) } : {}),
  }
}

/**
 * Run a command, resolve its stdout; reject with its stderr on a non-zero exit.
 *
 * @typedef {(cmd: string, args: string[], opts?: { input?: string, cwd?: string, env?: NodeJS.ProcessEnv }) => Promise<string>} Exec
 * @type {Exec}
 */
export function exec(cmd, args, { input, cwd, env } = {}) {
  return new Promise((resolveOut, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolveOut(out) : reject(new Error(`${cmd} ${args[0]} exited ${code}: ${err.trim() || out.trim()}`)),
    )
    // A child that exits without reading stdin (EPIPE) is judged by its exit code, not by the write.
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * The default {@link GitHub}: every call is one `graft` invocation.
 *
 * The `$release` part of a repo's snapshot (promotion: `from` ≠ `to`) is read every `release.readEveryMinutes`;
 * between reads the last answer is kept in memory and reused (its {@link Release} `fresh: false`). A read is
 * forced on the next tick when the tips of `from` or `to` moved (a merge), when cambium wrote to a promotion PR,
 * or by `read(slug, { fresh: true })`. A write to a kept `q:promote` issue drops it from the kept answer.
 *
 * @param {{ config: import('./config.mjs').Config, exec?: Exec, now?: () => number }} opts
 * @returns {GitHub}
 */
export function graftGitHub({ config, exec: run = exec, now = Date.now }) {
  const env = { ...process.env, ...(config.graft.app ? { GRAFT_APP: config.graft.app } : {}) }
  const cwdOf = (/** @type {string} */ slug) => config.repos.find((r) => r.slug === slug)?.path
  const graft = (/** @type {string} */ slug, /** @type {string[]} */ args, input = undefined) =>
    run(config.graft.command, [...args, '--repo', slug], { input, cwd: cwdOf(slug), env })
  const json = async (/** @type {Promise<string>} */ p) => JSON.parse(await p)
  /** @type {Map<string, { at: number, tips: string, part: Record<string, any>, dirty: boolean }>} */
  const kept = new Map()
  /** A write to issue or PR `number`: a kept promotion PR → read next tick; a kept awaiting issue → drop it. */
  const touch = (/** @type {string} */ slug, /** @type {number} */ number) => {
    const k = kept.get(slug)
    if (!k) return
    const has = (/** @type {any} */ field) => (field?.nodes ?? []).some((/** @type {any} */ n) => n?.number === number)
    if (has(k.part.promoteRef) || has(k.part.promoteLabelled)) k.dirty = true
    if (has(k.part.awaiting))
      k.part.awaiting = {
        ...k.part.awaiting,
        nodes: k.part.awaiting.nodes.filter((/** @type {any} */ n) => n?.number !== number),
      }
  }
  /** A write to the promotion (a PR opened, merged, closed, edited, a branch made): read next tick. */
  const dirty = (/** @type {string} */ slug) => {
    const k = kept.get(slug)
    if (k) k.dirty = true
  }

  return {
    async read(slug, { fresh = false } = {}) {
      const [owner, name] = slug.split('/')
      const r = config.repos.find((x) => x.slug === slug)?.release
      // Whenever there is a promotion (`from` ≠ `to`), on or off: the `q:promote` issues need the comparison
      // (promotion.mjs); the release graphs check `enabled` themselves. Read every `readEveryMinutes`, else kept.
      const release = r && r.from !== r.to ? { from: r.from, to: r.to } : null
      const k = release ? kept.get(slug) : undefined
      const due = Boolean(release && (fresh || !k || k.dirty || now() - k.at >= (r?.readEveryMinutes ?? 0) * 60_000))
      const branches = release ?? { from: '', to: '' }
      const repo = config.repos.find((x) => x.slug === slug)
      const health = repo?.requiredCheck ? { branch: repo.baseBranch, check: repo.requiredCheck } : null
      const vars = JSON.stringify({
        owner,
        name,
        labels: QUEUE_LABELS,
        release: due,
        tips: Boolean(release),
        ...branches,
        health: Boolean(health),
        baseRef: health ? `refs/heads/${health.branch}` : '',
        check: health?.check ?? '',
        adopt: config.intake.adopt,
        unqueued: config.intake.adopt ? unqueuedSearch(slug, config.intake.ignoreLabels) : '',
      })
      const data = await json(graft(slug, ['graphql', SNAPSHOT_QUERY, '--vars', vars]))
      const answered = (data?.data ?? data)?.repository
      if (release && answered) {
        const tips = tipsOf(answered)
        if (due) {
          const part = Object.fromEntries(RELEASE_FIELDS.map((f) => [f, structuredClone(answered[f] ?? null)]))
          kept.set(slug, { at: now(), tips, part, dirty: false })
        } else if (k) {
          // `from` or `to` moved since the kept read: a merge. Read the release part on the next tick.
          if (tips !== k.tips) k.dirty = true
          Object.assign(answered, structuredClone(k.part))
        }
      }
      // More than 100 queued issues: follow the cursor, or the newest ones are never scheduled or watched.
      const issues = (data?.data ?? data)?.repository?.issues
      for (let page = 0, info = issues?.pageInfo; info?.hasNextPage && page < MAX_ISSUE_PAGES; page++) {
        const pageVars = JSON.stringify({ owner, name, labels: QUEUE_LABELS, after: info.endCursor })
        const next = await json(graft(slug, ['graphql', ISSUES_PAGE_QUERY, '--vars', pageVars]))
        const more = (next?.data ?? next)?.repository?.issues
        issues.nodes.push(...(more?.nodes ?? []))
        info = more?.pageInfo
      }
      const snap = normalize(data, { botLogin: config.graft.botLogin, release, health })
      snap.rateLimit = (data?.data ?? data)?.rateLimit ?? null
      if (snap.release) snap.release.fresh = due
      const unread = unreadCloses(snap)
      if (!unread.length) return snap
      // Issues named only in PR bodies (in no queue): one more query, for those.
      const ask = (/** @type {number[]} */ ns) =>
        json(graft(slug, ['graphql', issuesQuery(ns), '--vars', JSON.stringify({ owner, name })]))
      // A number that resolves to nothing fails the whole query: then one at a time, skipping those.
      const more = await ask(unread).catch(async () => {
        const one = await Promise.all(unread.map((n) => ask([n]).catch(() => null)))
        return { repository: Object.assign({}, ...one.map((d) => d?.repository ?? {})) }
      })
      return addIssues(snap, more, unread, config.graft.botLogin)
    },
    async label(slug, number, { add, remove }) {
      if (!add.length && !remove.length) return
      touch(slug, number)
      await graft(slug, [
        'issue',
        'label',
        String(number),
        ...(add.length ? ['--add', add.join(',')] : []),
        ...(remove.length ? ['--remove', remove.join(',')] : []),
      ])
    },
    async writeState(slug, number, commentId, body) {
      touch(slug, number)
      if (commentId) {
        const path = `/repos/${slug}/issues/comments/${commentId}`
        await graft(slug, ['api', 'PATCH', path, '--body', JSON.stringify({ body })])
        return commentId
      }
      const made = await json(graft(slug, ['issue', 'comment', String(number), '--body-file', '-'], body))
      return made.id
    },
    async close(slug, number, body, { reason } = {}) {
      touch(slug, number)
      await graft(
        slug,
        ['issue', 'close', String(number), '--body-file', '-', ...(reason ? ['--reason', reason] : [])],
        body,
      )
    },
    async comment(slug, number, body) {
      touch(slug, number)
      await graft(slug, ['issue', 'comment', String(number), '--body-file', '-'], body)
    },
    async createIssue(slug, { title, body, labels }) {
      const args = [
        'issue',
        'create',
        '--title',
        title,
        '--body-file',
        '-',
        ...(labels.length ? ['--labels', labels.join(',')] : []),
      ]
      return json(graft(slug, args, body))
    },
    async deleteBranch(slug, branch) {
      await graft(slug, ['api', 'DELETE', `/repos/${slug}/git/refs/heads/${branch}`])
    },
    async openPull(slug, { head, base, title, body }) {
      dirty(slug)
      const path = `/repos/${slug}/pulls`
      const made = await json(graft(slug, ['api', 'POST', path, '--body', JSON.stringify({ head, base, title, body })]))
      return { number: made.number, url: made.html_url }
    },
    async greenCommit(slug, ref, check, depth) {
      let commit = await json(graft(slug, ['api', 'GET', `/repos/${slug}/commits/${encodeURIComponent(ref)}`]))
      for (let behind = 0; commit && behind < depth; behind++) {
        if (!check) return { sha: commit.sha, behind, url: null }
        const path = `/repos/${slug}/commits/${commit.sha}/check-runs?check_name=${encodeURIComponent(check)}&per_page=100`
        const runs = (await json(graft(slug, ['api', 'GET', path]))).check_runs ?? []
        const newest = runs
          .filter((/** @type {any} */ r) => r.name === check)
          .reduce((/** @type {any} */ a, /** @type {any} */ r) => (a && a.id >= r.id ? a : r), null)
        if (newest?.status === 'completed' && newest.conclusion === 'success')
          return { sha: commit.sha, behind, url: newest.html_url ?? null }
        const parent = commit.parents?.[0]?.sha
        commit = parent ? await json(graft(slug, ['api', 'GET', `/repos/${slug}/commits/${parent}`])) : null
      }
      return null
    },
    async compareRange(slug, base, head) {
      const path = `/repos/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
      const c = await json(graft(slug, ['api', 'GET', path]))
      return {
        status: c.status,
        aheadBy: Number(c.ahead_by ?? 0),
        behindBy: Number(c.behind_by ?? 0),
        files: (c.files ?? []).length,
        commits: (c.commits ?? []).map((/** @type {any} */ x) => ({
          sha: x.sha,
          parents: (x.parents ?? []).map((/** @type {any} */ p) => p.sha),
          message: x.commit?.message ?? '',
        })),
      }
    },
    async branches(slug, prefix) {
      const path = `/repos/${slug}/git/matching-refs/heads/${prefix}`
      const refs = await json(graft(slug, ['api', 'GET', path, '--paginate']))
      return refs.map((/** @type {any} */ r) => String(r.ref).replace(/^refs\/heads\//, ''))
    },
    async createBranch(slug, name, sha) {
      dirty(slug)
      const body = JSON.stringify({ ref: `refs/heads/${name}`, sha })
      await graft(slug, ['api', 'POST', `/repos/${slug}/git/refs`, '--body', body])
    },
    async editPull(slug, number, { title, body }) {
      dirty(slug)
      await graft(slug, ['api', 'PATCH', `/repos/${slug}/pulls/${number}`, '--body', JSON.stringify({ title, body })])
    },
    async closePull(slug, number, comment) {
      dirty(slug)
      await graft(slug, ['issue', 'comment', String(number), '--body-file', '-'], comment)
      await graft(slug, ['api', 'PATCH', `/repos/${slug}/pulls/${number}`, '--body', '{"state":"closed"}'])
    },
    // Through graft's merge policy, as an agent's merge would: auto-merge, or a merge now when the PR is clean.
    async mergePull(slug, number) {
      touch(slug, number)
      await graft(slug, ['pr', 'merge', String(number), '--auto'])
    },
    async behindBase(slug, number) {
      const pr = await json(graft(slug, ['api', 'GET', `/repos/${slug}/pulls/${number}`]))
      const base = pr.base.ref
      const cmp = await json(
        graft(slug, ['api', 'GET', `/repos/${slug}/compare/${encodeURIComponent(base)}...${pr.head.sha}`]),
      )
      return { behind: Number(cmp.behind_by ?? 0), base }
    },
    async updatePull(slug, number) {
      await graft(slug, ['pr', 'update', String(number)])
    },
    async workflowRuns(slug, workflow, branch) {
      const q = `branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=10`
      const path = `/repos/${slug}/actions/workflows/${encodeURIComponent(workflow)}/runs?${q}`
      const data = await json(graft(slug, ['api', 'GET', path]))
      return (data?.workflow_runs ?? [])
        .filter((/** @type {any} */ r) => r.event !== 'pull_request' && r.head_branch === branch)
        .map((/** @type {any} */ r) => ({
          id: r.id,
          url: r.html_url,
          sha: r.head_sha,
          conclusion: String(r.conclusion ?? ''),
          at: r.updated_at ?? r.created_at,
        }))
    },
    async mergeCommit(slug, number) {
      const pr = await json(graft(slug, ['api', 'GET', `/repos/${slug}/pulls/${number}`]))
      return pr?.merged_at && pr.merge_commit_sha ? String(pr.merge_commit_sha) : null
    },
    async linkIssue(slug, pr, issue) {
      const path = `/repos/${slug}/pulls/${pr}`
      const { body } = await json(graft(slug, ['api', 'GET', path]))
      if (bodyCloses(body).includes(issue)) return
      const linked = `Closes #${issue}${body ? `\n\n${body}` : ''}`
      await graft(slug, ['api', 'PATCH', path, '--body', JSON.stringify({ body: linked })])
    },
    async closedPulls(slug) {
      const [owner, name] = slug.split('/')
      const data = await json(graft(slug, ['graphql', CLOSED_PULLS_QUERY, '--vars', JSON.stringify({ owner, name })]))
      const closed = (data?.data ?? data)?.repository?.closed?.nodes ?? []
      return normalize({ repository: { open: { nodes: closed } } }).prs
    },
    async readIssues(slug, numbers) {
      if (!numbers.length) return new Map()
      const [owner, name] = slug.split('/')
      const ask = (/** @type {number[]} */ ns) =>
        json(graft(slug, ['graphql', issuesQuery(ns), '--vars', JSON.stringify({ owner, name })]))
      // A number that resolves to nothing fails the whole query: then one at a time, skipping those.
      const data = await ask(numbers).catch(async () => {
        const one = await Promise.all(numbers.map((n) => ask([n]).catch(() => null)))
        return { repository: Object.assign({}, ...one.map((d) => d?.repository ?? {})) }
      })
      return addIssues({ issues: new Map(), prs: [] }, data, numbers, config.graft.botLogin).issues
    },
    async addBlockedBy(slug, number, blocker) {
      // The dependencies API takes the blocker's database id, not its number.
      const b = await json(graft(slug, ['api', 'GET', `/repos/${slug}/issues/${blocker}`]))
      const path = `/repos/${slug}/issues/${number}/dependencies/blocked_by`
      await graft(slug, ['api', 'POST', path, '--body', JSON.stringify({ issue_id: b.id })])
      return { state: b.state === 'open' ? 'OPEN' : 'CLOSED' }
    },
  }
}
