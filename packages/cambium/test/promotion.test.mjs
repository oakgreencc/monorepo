// @ts-check
/** Merged, not yet promoted: `q:promote` on the issue while its agent PR is on `from` but not yet in `to`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.mjs'
import { graftGitHub, normalize } from '../src/github.mjs'
import { promotionMoves } from '../src/promotion.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

/** @param {any} m */
const renderBack = (m) => `<!-- cambium:state ${JSON.stringify(m)} -->`

/**
 * The graph engine with a develop → main repo; `release.enabled` as given. The read adds the comparison:
 * `state.merged` are the PRs on develop not yet in main.
 * @param {{ enabled?: boolean, aheadBy?: number | null, merged?: number[], from?: string }} [seed]
 */
function promoHarness({ enabled = false, aheadBy = 1, merged = [110], from = 'develop' } = {}) {
  const h = harness({
    issues: [{ number: 11, labels: [] }],
    config: {
      engine: 'graph',
      phases: { task: { cap: 0 } },
      repos: [{ slug: SLUG, path: '/repo', baseBranch: from, release: { enabled, time: '00:00', from, to: 'main' } }],
    },
  })
  h.gh.issue(11).comment = {
    id: 7,
    body: renderBack({ v: 1, phase: 'task', stage: 'submitted', queued: true, attempt: 1, pr: 110, history: [] }),
  }
  h.gh.addPr({ number: 110, closes: [11], state: 'MERGED', branch: 'agent/11-x' })
  const state = { aheadBy, merged }
  const base = h.gh.github
  h.deps.github = {
    ...base,
    async read(slug) {
      const snap = await base.read(slug)
      if (from === 'main') return snap
      return {
        ...snap,
        release: {
          from,
          to: 'main',
          aheadBy: state.aheadBy,
          merged: state.merged.map((number) => ({ number, title: `PR ${number}` })),
          prs: [],
        },
      }
    },
  }
  return { ...h, state }
}

test('merged into develop: the issue is closed and waits in q:promote, counted as promote', async () => {
  const h = promoHarness()
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, ['q:promote'])
  assert.equal(h.beats.at(-1)?.counts.promote, 1)
  assert.ok(h.events.some((e) => e.issue === 11 && /waiting for promotion to `main`/.test(e.msg)))
  // Idempotent: the next tick labels nothing again.
  const labels = h.gh.calls.filter((c) => c.op === 'label').length
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'label').length, labels)
})

test('promoted (no longer ahead of main): q:promote comes off, the issue stays closed', async () => {
  const h = promoHarness()
  await tick(h.deps)
  h.state.merged = []
  h.state.aheadBy = 0
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
  assert.equal(h.beats.at(-1)?.counts.promote, 0)
  assert.ok(h.events.some((e) => e.issue === 11 && e.msg === 'promoted to `main`'))
  // Not relabelled once gone.
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('more than 100 commits ahead: an issue whose PR fell out of the comparison keeps q:promote', async () => {
  const h = promoHarness()
  await tick(h.deps)
  h.state.merged = []
  h.state.aheadBy = 150
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(11).labels, ['q:promote'])
})

test('main is missing (aheadBy null): nothing labelled', async () => {
  const h = promoHarness({ aheadBy: null })
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('no promotion (from = to): merged closes the issue as before, no q:promote', async () => {
  const h = promoHarness({ from: 'main' })
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('legacy engine: no q:promote', async () => {
  const h = promoHarness()
  h.deps.config.engine = 'legacy'
  await tick(h.deps)
  assert.equal(h.gh.issue(11).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(11).labels, [])
})

test('the read asks for the comparison and the closed q:promote issues whenever from ≠ to, release on or off', async () => {
  /** @type {string[][]} */
  const argv = []
  const answer = {
    repository: {
      issues: { nodes: [] },
      awaiting: {
        nodes: [{ number: 5, title: 'T', url: 'u', state: 'CLOSED', labels: { nodes: [{ name: 'q:promote' }] } }],
      },
      toRef: { compare: { aheadBy: 0, commits: { nodes: [] } } },
    },
  }
  const config = resolveConfig({
    repos: [
      { slug: 'o/r', path: '/src/r', baseBranch: 'develop', release: { enabled: false } },
      { slug: 'o/m', path: '/src/m', baseBranch: 'main' },
    ],
  })
  const gh = graftGitHub({
    config,
    exec: async (_cmd, args) => {
      argv.push(args)
      return JSON.stringify(answer)
    },
  })
  const snap = await gh.read('o/r')
  assert.deepEqual((({ release, from, to }) => [release, from, to])(JSON.parse(argv[0][3])), [true, 'develop', 'main'])
  assert.equal(snap.issues.get(5)?.state, 'CLOSED')
  assert.deepEqual(snap.issues.get(5)?.labels, ['q:promote'])
  await gh.read('o/m')
  assert.equal(JSON.parse(argv[1][3]).release, false)
  assert.equal(normalize({ repository: { awaiting: answer.repository.awaiting } }).issues.get(5)?.number, 5)
})

/** A develop → main answer: `#5` waits in q:promote for PR 50; `ahead` lists the PRs on develop not in main. */
const promoAnswer = (/** @type {{ ahead?: number[], from?: string, to?: string, release?: boolean }} */ o = {}) => {
  const { ahead = [50], from = 'f1', to = 't1', release = true } = o
  return {
    repository: {
      issues: { nodes: [] },
      fromTip: { target: { oid: from } },
      toTip: { target: { oid: to } },
      ...(release
        ? {
            awaiting: {
              nodes: [
                {
                  number: 5,
                  title: 'T',
                  url: 'u',
                  state: 'CLOSED',
                  labels: { nodes: [{ name: 'q:promote' }] },
                  comments: {
                    nodes: [
                      {
                        databaseId: 1,
                        author: { login: 'bot' },
                        body: renderBack({ v: 1, phase: 'task', stage: 'submitted', attempt: 1, pr: 50, history: [] }),
                      },
                    ],
                  },
                },
              ],
            },
            toRef: {
              compare: {
                aheadBy: ahead.length,
                commits: {
                  nodes: ahead.map((n) => ({
                    associatedPullRequests: {
                      nodes: [{ number: n, title: `P${n}`, baseRefName: 'develop', state: 'MERGED' }],
                    },
                  })),
                },
              },
            },
          }
        : {}),
    },
  }
}

/** A graft client over a develop → main repo, a settable clock and settable answers. */
function keptClient(/** @type {number | undefined} */ readEveryMinutes = undefined) {
  /** @type {any[]} */
  const vars = []
  const state = { now: 0, ahead: [50], from: 'f1', to: 't1' }
  const config = resolveConfig({
    repos: [
      {
        slug: 'o/r',
        path: '/src/r',
        baseBranch: 'develop',
        release: { enabled: true, ...(readEveryMinutes === undefined ? {} : { readEveryMinutes }) },
      },
      { slug: 'o/m', path: '/src/m', baseBranch: 'main' },
    ],
  })
  const gh = graftGitHub({
    config,
    now: () => state.now,
    exec: async (_cmd, args) => {
      if (args[0] !== 'graphql') return ''
      const v = JSON.parse(args[3])
      vars.push(v)
      return JSON.stringify(promoAnswer({ ...state, release: v.release }))
    },
  })
  return { gh, vars, state }
}

test('between release reads: $release false, promotion works from the kept answer; due again after readEveryMinutes', async () => {
  const { gh, vars, state } = keptClient()
  const first = await gh.read('o/r')
  assert.equal(vars[0].release, true)
  assert.equal(vars[0].tips, true)
  assert.equal(first.release?.fresh, true)
  // The PR leaves `from`'s lead in GitHub, but the next read (a minute on) does not ask: the kept answer stands.
  state.ahead = []
  state.now = 60_000
  const skipped = await gh.read('o/r')
  assert.equal(vars[1].release, false)
  assert.equal(skipped.release?.fresh, false)
  assert.deepEqual(skipped.release?.merged, [{ number: 50, title: 'P50' }])
  assert.deepEqual(skipped.issues.get(5)?.labels, ['q:promote'], 'the kept q:promote issue is still in the snapshot')
  assert.deepEqual(promotionMoves(skipped).unlabel, [], 'no unlabel from a kept answer that still has PR 50 ahead')
  // Five minutes after the last read: read again, and the label comes off.
  state.now = 5 * 60_000
  const read = await gh.read('o/r')
  assert.equal(vars[2].release, true)
  assert.deepEqual(
    promotionMoves(read).unlabel.map((i) => i.number),
    [5],
  )
  // from = to: never the release part, nor the tips.
  await gh.read('o/m')
  assert.deepEqual([vars[3].release, vars[3].tips], [false, false])
})

test('a skipped tick still labels a newly merged issue from the kept comparison', async () => {
  const { gh, state } = keptClient()
  await gh.read('o/r')
  state.now = 60_000
  const snap = await gh.read('o/r')
  snap.issues.set(6, {
    .../** @type {any} */ (snap.issues.get(5)),
    number: 6,
    labels: [],
    stateComment: { id: 2, marker: /** @type {any} */ ({ pr: 50 }), author: null },
  })
  snap.prs.push(/** @type {any} */ ({ number: 50, state: 'MERGED', closes: [6], branch: 'agent/6-x' }))
  assert.equal(snap.release?.fresh, false)
  assert.deepEqual(
    promotionMoves(snap).label.map((i) => i.number),
    [6],
  )
})

test('a merge into `to` or `from` reads the release part on the next tick', async () => {
  for (const tip of /** @type {const} */ (['to', 'from'])) {
    const { gh, vars, state } = keptClient(60)
    await gh.read('o/r')
    state.now = 60_000
    state[tip] = `${tip}2`
    state.ahead = []
    await gh.read('o/r')
    assert.equal(vars[1].release, false, `${tip}: the tick that sees the move still uses the kept answer`)
    state.now = 120_000
    const next = await gh.read('o/r')
    assert.equal(vars[2].release, true, `${tip}: the next tick reads`)
    assert.deepEqual(
      promotionMoves(next).unlabel.map((i) => i.number),
      [5],
    )
    state.now = 180_000
    await gh.read('o/r')
    assert.equal(vars[3].release, false, `${tip}: and then waits again`)
  }
})

test('kept release answer: writes keep it honest; readEveryMinutes 0 and { fresh: true } always read', async () => {
  const { gh, vars, state } = keptClient(60)
  await gh.read('o/r')
  // Unlabelling a kept q:promote issue drops it from the kept answer.
  await gh.label('o/r', 5, { add: [], remove: ['q:promote'] })
  state.now = 60_000
  const snap = await gh.read('o/r')
  assert.equal(vars[1].release, false)
  assert.equal(snap.issues.has(5), false)
  // A write to the promotion (a PR opened) reads the next tick.
  await gh.openPull('o/r', { head: 'release/x', base: 'main', title: 'T', body: 'B' }).catch(() => {})
  await gh.read('o/r')
  assert.equal(vars[2].release, true)
  await gh.read('o/r', { fresh: true })
  assert.equal(vars[3].release, true)
  const every = keptClient(0)
  await every.gh.read('o/r')
  await every.gh.read('o/r')
  assert.deepEqual(
    every.vars.map((v) => v.release),
    [true, true],
  )
  assert.throws(
    () => resolveConfig({ repos: [{ slug: 'o/r', path: '/r', release: { readEveryMinutes: -1 } }] }),
    /readEveryMinutes/,
  )
})
