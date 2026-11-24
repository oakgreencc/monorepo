// @ts-check
/**
 * The cheap probe before the snapshot (tick.mjs `read`): an unchanged repo reuses its last full read; a change,
 * settling checks and every `fullReadEvery`th tick read in full. The heartbeat says which.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tick } from '../src/tick.mjs'
import { normalizeProbe } from '../src/github.mjs'
import { resolveConfig } from '../src/config.mjs'
import { harness } from './fakes.mjs'

const MIN = 60_000
const task = (/** @type {number} */ number) => ({ number, labels: ['q:task'] })

/**
 * A harness whose GitHub has a probe answering `state`, and whose fake read reports a budget.
 * @param {Parameters<typeof harness>[0]} [seed]
 */
function probed(seed = {}) {
  // Paused: read and heartbeat only, so nothing the tick does changes what the probe sees.
  const h = harness(seed)
  h.deps.store.setMode('paused')
  const state = {
    issuesAt: '2026-11-16T11:00:00Z',
    prsAt: '2026-11-16T11:00:00Z',
    heads: /** @type {Record<string, string | null>} */ ({ base: 'aaa' }),
    fail: /** @type {Error | null} */ (null),
    rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-11-16T13:00:00Z' },
  }
  let probes = 0
  h.deps.github = {
    ...h.gh.github,
    async probe() {
      probes++
      if (state.fail) throw state.fail
      const { fail, ...p } = state
      return structuredClone(p)
    },
  }
  h.gh.health.rateLimit = { cost: 10, remaining: 4990, resetAt: '2026-11-16T13:00:00Z' }
  const reads = () => h.gh.calls.filter((c) => c.op === 'read').length
  const read = () => h.beats.at(-1)?.repos[0].read
  const next = async () => {
    h.clock.advance(MIN / 2)
    await tick(h.deps)
  }
  return { ...h, state, reads, read, next, probes: () => probes }
}

test('the first tick, with nothing cached, probes and reads in full', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  assert.equal(h.reads(), 1)
  assert.equal(h.probes(), 1)
  assert.deepEqual(h.read(), { kind: 'full', why: 'first' })
  assert.equal(h.beats.at(-1)?.repos[0].counts?.task, 1)
})

test('an unchanged probe reuses the snapshot: one probe, no read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  await h.next()
  assert.equal(h.reads(), 1, 'no second full read')
  assert.equal(h.probes(), 2)
  assert.deepEqual(h.read(), { kind: 'probe', why: null })
  assert.equal(h.beats.at(-1)?.repos[0].counts?.task, 1, 'the reused snapshot still counts the queue')
  assert.deepEqual(
    h.beats.at(-1)?.repos[0].rateLimit,
    { cost: 10, remaining: 4000, resetAt: '2026-11-16T13:00:00Z' },
    "the probe's budget left, at the full read's cost",
  )
})

test('a changed issue updatedAt forces a full read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.issuesAt = '2026-11-16T12:00:10Z'
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'changed' })
  await h.next()
  assert.equal(h.reads(), 2, 'the new probe is the baseline: unchanged again')
})

test('a changed PR updatedAt forces a full read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.prsAt = '2026-11-16T12:00:10Z'
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'changed' })
})

test('a changed base oid forces a full read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.heads = { base: 'bbb' }
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'changed' })
})

test('pending checks on an open PR force a full read every tick', async () => {
  const h = probed({ issues: [task(1)], prs: [{ number: 50, closes: [1], checks: 'PENDING' }] })
  await tick(h.deps)
  await h.next()
  await h.next()
  assert.equal(h.reads(), 3)
  assert.deepEqual(h.read(), { kind: 'full', why: 'pending' })
})

test('settled checks on an open PR do not', async () => {
  const h = probed({ issues: [task(1)], prs: [{ number: 50, closes: [1], checks: 'SUCCESS' }] })
  await tick(h.deps)
  await h.next()
  assert.equal(h.reads(), 1)
})

test('every fullReadEvery-th tick reads in full; the default is 4', async () => {
  assert.equal(resolveConfig({}).fullReadEvery, 4)
  const h = probed({ issues: [task(1)] })
  /** @type {(string | undefined)[]} */
  const kinds = []
  await tick(h.deps)
  kinds.push(h.read()?.kind)
  for (let i = 0; i < 8; i++) {
    await h.next()
    kinds.push(h.read()?.kind)
  }
  assert.deepEqual(kinds, ['full', 'probe', 'probe', 'probe', 'full', 'probe', 'probe', 'probe', 'full'])
  assert.deepEqual(h.read(), { kind: 'full', why: 'due' })
})

test('fullReadEvery is configurable; 1 reads in full every tick without probing', async () => {
  const two = probed({ issues: [task(1)], config: { fullReadEvery: 2 } })
  await tick(two.deps)
  await two.next()
  await two.next()
  assert.equal(two.reads(), 2, 'full, probe, full')
  const one = probed({ issues: [task(1)], config: { fullReadEvery: 1 } })
  await tick(one.deps)
  await one.next()
  assert.equal(one.reads(), 2)
  assert.equal(one.probes(), 0)
  assert.deepEqual(one.read(), { kind: 'full', why: 'always' })
  assert.throws(() => resolveConfig({ fullReadEvery: 0 }), /fullReadEvery/)
  assert.throws(() => resolveConfig({ fullReadEvery: 2.5 }), /fullReadEvery/)
})

test('a failed probe falls back to a full read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.fail = new Error('graft graphql exited 1')
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'probe-failed' })
  assert.ok(h.events.some((e) => e.level === 'warn' && /probe: graft graphql exited 1/.test(e.msg)))
})

test('a config change for the repo reads afresh', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.deps.config.intake.adopt = !h.deps.config.intake.adopt
  await h.next()
  assert.deepEqual(h.read(), { kind: 'full', why: 'config' })
})

test('a GitHub without a probe reads in full every tick', async () => {
  const h = harness({ issues: [task(1)] })
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'read').length, 2)
  assert.deepEqual(h.beats.at(-1)?.repos[0].read, { kind: 'full', why: 'always' })
})

test('normalizeProbe: newest updatedAt of issues and PRs, the branch heads, the budget', () => {
  const p = normalizeProbe({
    data: {
      rateLimit: { cost: 1, remaining: 10, resetAt: 'x' },
      repository: {
        issues: { nodes: [{ updatedAt: 'i' }] },
        pullRequests: { nodes: [] },
        base: { target: { oid: 'b' } },
        from: null,
        to: { target: { oid: 't' } },
      },
    },
  })
  assert.deepEqual(p, {
    issuesAt: 'i',
    prsAt: null,
    heads: { base: 'b', from: null, to: 't' },
    rateLimit: { cost: 1, remaining: 10, resetAt: 'x' },
  })
  assert.deepEqual(normalizeProbe({ repository: { base: null } }).heads, { base: null })
  assert.throws(() => normalizeProbe({ data: {} }), /no repository/)
})
