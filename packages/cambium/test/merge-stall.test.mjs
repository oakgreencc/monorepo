// @ts-check
/**
 * Stalled merges (merge-stall.mjs): an armed, green PR GitHub still reports BLOCKED. An agent PR goes to q:human
 * from the PR graph; anyone else's gets one warn and a heartbeat entry. The reason names the blocker it can read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRulesOf, normalize } from '../src/github.mjs'
import { stallBlockers, stallReason } from '../src/merge-stall.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000

/** @param {Partial<import('../src/github.mjs').MergeRules>} [r] @returns {import('../src/github.mjs').MergeRules} */
const rulesOf = (r = {}) => ({
  requiredChecks: [],
  approvals: 0,
  codeOwners: false,
  rulesets: [],
  ...r,
})

/** A green, armed, BLOCKED PR. @param {object} [o] @returns {import('../src/github.mjs').PullRequest} */
const blocked = (o = {}) => ({
  number: 7,
  url: 'u',
  branch: 'feature/x',
  state: 'OPEN',
  headSha: 'h',
  branchExists: true,
  inMergeQueue: false,
  autoMerge: true,
  checks: 'SUCCESS',
  failing: [],
  closes: [],
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  createdAt: null,
  mergeState: 'BLOCKED',
  base: 'develop',
  approvals: 0,
  codeOwnerRequests: [],
  checkNames: ['ci'],
  ...o,
})

test('reason: a required check missing from the rollup is named', () => {
  const pr = blocked()
  const reason = stallReason(pr, 25, rulesOf({ requiredChecks: ['ci', 'e2e'] }))
  assert.match(
    reason,
    /auto-merge armed 25 min ago .* BLOCKED\. Held by required check `e2e` not reported on the head\./,
  )
})

test('reason: a missing code-owner review is named with who is asked', () => {
  const pr = blocked({
    reviewDecision: 'REVIEW_REQUIRED',
    codeOwnerRequests: ['team web', '@ana'],
  })
  const reason = stallReason(pr, 30, rulesOf({ codeOwners: true }))
  assert.match(reason, /Held by a code-owner review, still requested from team web, @ana\./)
  assert.deepEqual(stallBlockers(blocked({ reviewDecision: 'REVIEW_REQUIRED' }), rulesOf({ codeOwners: true })), [
    'a code-owner review the base requires',
  ])
})

test('reason: approvals required vs given, and the rulesets on the base', () => {
  const pr = blocked({ approvals: 1 })
  const rules = rulesOf({
    approvals: 2,
    rulesets: [{ id: 3, name: 'protect develop' }],
  })
  assert.match(
    stallReason(pr, 21, rules),
    /Held by 2 approving reviews required, 1 given\. Ruleset on `develop`: protect develop\./,
  )
  assert.match(
    stallReason(blocked(), 21, rulesOf({ rulesets: [{ id: 3, name: 'r' }] })),
    /Ruleset on `develop`: r\. One of them holds it/,
  )
})

test('reason: nothing readable → the generic wording', () => {
  assert.match(stallReason(blocked(), 21, null), /A rule cambium cannot see holds it/)
  assert.match(stallReason(blocked(), 21, rulesOf()), /A rule cambium cannot see holds it/)
})

test('mergeRulesOf: rulesets and branch protection, merged', () => {
  const rules = [
    {
      type: 'pull_request',
      ruleset_id: 3,
      parameters: {
        required_approving_review_count: 1,
        require_code_owner_review: true,
      },
    },
    {
      type: 'required_status_checks',
      ruleset_id: 4,
      parameters: { required_status_checks: [{ context: 'ci' }] },
    },
  ]
  const protection = {
    required_pull_request_reviews: { required_approving_review_count: 2 },
    required_status_checks: { contexts: ['lint'], checks: [{ context: 'ci' }] },
  }
  assert.deepEqual(mergeRulesOf(rules, new Map([[3, 'main rules']]), protection), {
    requiredChecks: ['ci', 'lint'],
    approvals: 2,
    codeOwners: true,
    rulesets: [
      { id: 3, name: 'main rules' },
      { id: 4, name: 'ruleset 4' },
    ],
  })
  assert.deepEqual(mergeRulesOf([], new Map(), null), rulesOf())
})

test('normalize: an armed non-agent PR goes to `armed` with what names a blocker; an unarmed one is dropped', () => {
  const pr = (/** @type {object} */ o) => ({
    number: 1,
    url: 'u',
    headRefName: 'feature/x',
    baseRefName: 'develop',
    state: 'OPEN',
    mergeStateStatus: 'BLOCKED',
    autoMergeRequest: { enabledAt: '2026-11-16T12:00:00Z' },
    latestReviews: { nodes: [{ state: 'APPROVED' }, { state: 'COMMENTED' }] },
    reviewRequests: {
      nodes: [
        {
          asCodeOwner: true,
          requestedReviewer: { __typename: 'Team', slug: 'web' },
        },
        {
          asCodeOwner: false,
          requestedReviewer: { __typename: 'User', login: 'bo' },
        },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: {
                nodes: [{ __typename: 'CheckRun', name: 'ci', conclusion: 'SUCCESS' }],
              },
            },
          },
        },
      ],
    },
    ...o,
  })
  const snap = normalize({
    repository: {
      open: {
        nodes: [pr({}), pr({ number: 2, autoMergeRequest: null }), pr({ number: 3, headRefName: 'agent/issue-9' })],
      },
    },
  })
  assert.deepEqual(
    snap.prs.map((p) => p.number),
    [3],
  )
  assert.equal(snap.armed?.length, 1)
  const a = /** @type {any} */ (snap.armed)[0]
  assert.equal(a.number, 1)
  assert.equal(a.base, 'develop')
  assert.equal(a.approvals, 1)
  assert.deepEqual(a.codeOwnerRequests, ['team web'])
  assert.deepEqual(a.checkNames, ['ci'])
  assert.equal(a.autoMergeAt, '2026-11-16T12:00:00Z')
})

/** A human's PR #800, armed now, green and BLOCKED. @param {object} [config] @param {any[]} [issues] */
function humanPr(config = {}, issues = []) {
  const h = harness({
    issues,
    prs: [
      {
        number: 800,
        closes: [],
        branch: 'feature/labels',
        title: 'Tidy labels',
        checks: 'SUCCESS',
        mergeState: 'BLOCKED',
        base: 'develop',
        checkNames: ['ci'],
      },
    ],
    config: { engine: 'graph', ...config },
  })
  h.gh.pulls[0].autoMergeAt = new Date(h.clock.now()).toISOString()
  h.gh.rules.set('develop', rulesOf({ requiredChecks: ['ci', 'e2e'] }))
  const warns = () => h.events.filter((e) => e.level === 'warn' && /stalled merge/.test(e.msg))
  const ops = (/** @type {string} */ op) => h.gh.calls.filter((c) => c.op === op)
  return { ...h, warns, ops }
}

test('a non-agent PR armed, green and BLOCKED past mergeStallMinutes: one warn, a heartbeat entry, no queue move', async () => {
  const h = humanPr()
  await tick(h.deps)
  h.clock.advance(19 * MIN)
  await tick(h.deps)
  assert.equal(h.warns().length, 0, 'within the window')
  assert.equal(h.ops('mergeRules').length, 0, 'no rules read before the threshold')

  h.clock.advance(2 * MIN)
  await tick(h.deps)
  assert.equal(h.warns().length, 1)
  assert.match(h.warns()[0].msg, /PR #800: auto-merge armed 21 min ago .* required check `e2e` not reported/)
  const stalls = h.beats.at(-1)?.repos[0].stalls ?? []
  assert.equal(stalls.length, 1)
  assert.equal(stalls[0].number, 800)
  assert.equal(stalls[0].minutes, 21)
  assert.match(stalls[0].reason, /`e2e`/)

  h.clock.advance(5 * MIN)
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(h.warns().length, 1, 'no repeat while it stays stuck')
  assert.equal(h.ops('mergeRules').length, 1, 'the rules are read once')
  assert.equal(h.beats.at(-1)?.repos[0].stalls[0].minutes, 26)
  for (const op of ['label', 'writeState', 'comment', 'mergePull', 'closePull', 'updatePull'])
    assert.equal(h.ops(op).length, 0, `no ${op} on a PR cambium does not own`)

  h.gh.pulls[0].mergeState = 'CLEAN'
  await tick(h.deps)
  assert.deepEqual(h.beats.at(-1)?.repos[0].stalls, [], 'unstuck: dropped')
})

test('a non-agent stall whose rules cannot be read falls back to the generic reason', async () => {
  const h = humanPr()
  h.gh.faults.rulesError = new Error('403')
  h.clock.advance(25 * MIN)
  await tick(h.deps)
  assert.equal(h.warns().length, 1)
  assert.match(h.warns()[0].msg, /A rule cambium cannot see holds it/)
})

test('mergeStallMinutes 0: neither an agent nor a non-agent PR is checked', async () => {
  const h = humanPr(
    {
      mergeStallMinutes: 0,
      mergeQueueMinutes: 600,
      phases: { task: { cap: 0 } },
    },
    [{ number: 50 }],
  )
  h.gh.addPr({
    number: 500,
    closes: [50],
    checks: 'SUCCESS',
    mergeState: 'BLOCKED',
  })
  h.gh.pulls[1].autoMergeAt = new Date(h.clock.now()).toISOString()
  h.gh.issue(50).comment = {
    id: 7,
    body: renderMarker(
      newMarker({
        node: 'submit',
        graphVersion: 2,
        status: 'done',
        pr: 500,
        branch: 'agent/issue-50',
      }),
    ),
  }
  h.clock.advance(60 * MIN)
  await tick(h.deps)
  assert.equal(h.warns().length, 0)
  assert.ok(!h.gh.issue(50).labels.includes('q:human'), 'the agent check is off too')
  assert.equal(h.ops('mergeRules').length, 0)
  assert.deepEqual(h.beats.at(-1)?.repos[0].stalls, [])
})

test('agent PR: the stall reason names a missing code-owner review; still q:human + why:approve, merge-blocked', async () => {
  const h = harness({
    issues: [{ number: 50 }],
    prs: [
      {
        number: 500,
        closes: [50],
        checks: 'SUCCESS',
        autoMerge: true,
        mergeState: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        base: 'develop',
        codeOwnerRequests: ['team web'],
      },
    ],
    config: {
      engine: 'graph',
      repos: [{ slug: SLUG, path: '/repo', merge: 'green' }],
      phases: { task: { cap: 0 } },
    },
  })
  h.gh.rules.set('develop', rulesOf({ codeOwners: true }))
  h.gh.issue(50).comment = {
    id: 7,
    body: renderMarker(
      newMarker({
        node: 'submit',
        graphVersion: 2,
        status: 'done',
        pr: 500,
        branch: 'agent/issue-50',
        submittedAt: new Date(h.clock.now()).toISOString(),
      }),
    ),
  }
  h.gh.pulls[0].autoMergeAt = new Date(h.clock.now()).toISOString()
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'mergeRules').length, 0, 'no rules read before the threshold')
  h.clock.advance(21 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(50).labels.sort(), ['q:human', 'why:approve'])
  const last = h.gh.marker(50)?.history.at(-1)
  assert.equal(last?.outcome, 'merge-blocked')
  assert.match(String(last?.reason), /Held by a code-owner review, still requested from team web/)
  assert.deepEqual(h.beats.at(-1)?.repos[0].stalls, [], 'an agent PR is not a non-agent stall')
})
