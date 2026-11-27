// @ts-check
/**
 * The cheap probe before the snapshot (tick.mjs `read`): conditional REST GETs (If-None-Match). All 304: the repo
 * reuses its last full read; a 200, an error, settling checks and every `fullReadEvery`th tick read in full. The
 * heartbeat says which.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tick, readRepo } from '../src/tick.mjs'
import { graftGitHub, parseIncluded, probeRequests } from '../src/github.mjs'
import { openStore } from '../src/store.mjs'
import { resolveConfig } from '../src/config.mjs'
import { harness } from './fakes.mjs'

const MIN = 60_000
const task = (/** @type {number} */ number) => ({ number, labels: ['q:task'] })

/**
 * A harness whose GitHub has a probe over a fake REST: each request's current ETag is `state.tags[name]`; one
 * sent with that tag answers 304, anything else 200 (or an error, for a name in `state.errors`).
 * @param {Parameters<typeof harness>[0]} [seed]
 */
function probed(seed = {}) {
  // Paused: read and heartbeat only, so nothing the tick does changes what the probe sees.
  const h = harness(seed)
  h.deps.store.setMode('paused')
  const state = {
    tags: /** @type {Record<string, string>} */ ({ issues: 'W/"i1"', base: 'W/"b1"' }),
    errors: /** @type {string[]} */ ([]),
    fail: /** @type {Error | null} */ (null),
  }
  /** @type {Record<string, string | null>[]} */
  const sent = []
  h.deps.github = {
    ...h.gh.github,
    async probe(_slug, etags) {
      sent.push({ ...etags })
      if (state.fail) throw state.fail
      /** @type {import('../src/github.mjs').Probe} */
      const out = { changed: false, etags: {}, errors: [] }
      for (const [name, tag] of Object.entries(state.tags)) {
        if (state.errors.includes(name)) {
          out.changed = true
          out.etags[name] = null
          out.errors.push(`${name}: 502`)
        } else {
          if (etags[name] !== tag) out.changed = true
          out.etags[name] = tag
        }
      }
      return out
    },
  }
  h.gh.health.rateLimit = { cost: 10, remaining: 4990, resetAt: '2026-11-16T13:00:00Z' }
  const reads = () => h.gh.calls.filter((c) => c.op === 'read').length
  const read = () => h.beats.at(-1)?.repos[0].read
  const next = async () => {
    h.clock.advance(MIN / 2)
    await tick(h.deps)
  }
  return { ...h, state, sent, reads, read, next, probes: () => sent.length }
}

test('the first tick, with nothing cached, probes and reads in full', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  assert.equal(h.reads(), 1)
  assert.equal(h.probes(), 1)
  assert.deepEqual(h.read(), { kind: 'full', why: 'first' })
  assert.equal(h.beats.at(-1)?.repos[0].counts?.task, 1)
})

test('every probe request 304: the snapshot is reused, no GraphQL read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  assert.deepEqual(h.sent[0], {}, 'nothing cached: no If-None-Match')
  await h.next()
  assert.equal(h.reads(), 1, 'no second full read')
  assert.equal(h.probes(), 2)
  assert.deepEqual(h.sent[1], { issues: 'W/"i1"', base: 'W/"b1"' }, 'the stored ETags are sent')
  assert.deepEqual(h.read(), { kind: 'probe', why: null })
  assert.equal(h.beats.at(-1)?.repos[0].counts?.task, 1, 'the reused snapshot still counts the queue')
  assert.deepEqual(
    h.beats.at(-1)?.repos[0].rateLimit,
    { cost: 10, remaining: 4990, resetAt: '2026-11-16T13:00:00Z' },
    "the last full read's budget",
  )
})

test('a 200 on the issues list forces a full read and stores its fresh ETag', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.tags.issues = 'W/"i2"'
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'changed' })
  await h.next()
  assert.deepEqual(h.sent.at(-1), { issues: 'W/"i2"', base: 'W/"b1"' }, 'the fresh ETag is sent next')
  assert.equal(h.reads(), 2, 'the new tags are the baseline: unchanged again')
})

test('a 200 on a branch ref forces a full read', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.tags.base = 'W/"b2"'
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'changed' })
})

test('an error on one probe request forces a full read; that request goes unconditional next time', async () => {
  const h = probed({ issues: [task(1)] })
  await tick(h.deps)
  h.state.errors = ['base']
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'probe-failed' })
  assert.ok(h.events.some((e) => e.level === 'warn' && /probe: base: 502/.test(e.msg)))
  h.state.errors = []
  await h.next()
  assert.deepEqual(h.sent.at(-1), { issues: 'W/"i1"', base: null })
  assert.equal(h.reads(), 3, 'no tag for base: its 200 reads again')
  await h.next()
  assert.equal(h.reads(), 3)
})

test('a restart with stored ETags probes first: all 304 reuses the stored snapshot', async () => {
  const store = openStore(':memory:')
  const before = probed({ issues: [task(1)], store })
  await tick(before.deps)
  assert.equal(before.reads(), 1)
  const after = probed({ issues: [task(1)], store })
  await tick(after.deps)
  assert.equal(after.reads(), 0, 'no full read after the restart')
  assert.deepEqual(after.sent[0], { issues: 'W/"i1"', base: 'W/"b1"' })
  assert.deepEqual(after.read(), { kind: 'probe', why: null })
  assert.equal(after.beats.at(-1)?.repos[0].counts?.task, 1, 'the stored snapshot counts the queue')
  // The count of reuses survives too: fullReadEvery still holds across the restart.
  const again = probed({ issues: [task(1)], store })
  await tick(again.deps)
  await again.next()
  assert.deepEqual(again.read(), { kind: 'probe', why: null }, 'reused on ticks 2, 3 and 4')
  await again.next()
  assert.deepEqual(again.read(), { kind: 'full', why: 'due' }, 'tick 5: due')
  assert.equal(again.reads(), 1)
})

test('a restart with nothing stored, or a stored read the store cannot parse, reads in full', async () => {
  const store = openStore(':memory:')
  store.set('read.probe:o/r', '{not json')
  store.set('read.snapshot:o/r', '{}')
  const h = probed({ issues: [task(1)], store })
  await tick(h.deps)
  assert.deepEqual(h.read(), { kind: 'full', why: 'first' })
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
  h.state.fail = new Error('graft api exited 1')
  await h.next()
  assert.equal(h.reads(), 2)
  assert.deepEqual(h.read(), { kind: 'full', why: 'probe-failed' })
  assert.ok(h.events.some((e) => e.level === 'warn' && /probe: graft api exited 1/.test(e.msg)))
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

test('probeRequests: the issues list (PRs too) and each compared branch head', () => {
  assert.deepEqual(probeRequests('o/r', { base: 'main' }), {
    issues: '/repos/o/r/issues?state=all&sort=updated&direction=desc&per_page=1',
    base: '/repos/o/r/git/ref/heads/main',
  })
  assert.deepEqual(probeRequests('o/r', { base: 'main', from: 'main', to: 'release/prod' }), {
    issues: '/repos/o/r/issues?state=all&sort=updated&direction=desc&per_page=1',
    base: '/repos/o/r/git/ref/heads/main',
    from: '/repos/o/r/git/ref/heads/main',
    to: '/repos/o/r/git/ref/heads/release/prod',
  })
})

test('parseIncluded: the status line and the ETag of graft api --include', () => {
  assert.deepEqual(parseIncluded('HTTP 304\netag: W/"a"\nx-ratelimit-remaining: 5\n\n'), { status: 304, etag: 'W/"a"' })
  assert.deepEqual(parseIncluded('HTTP 200\n\n[{"a":1}]\n'), { status: 200, etag: null })
  assert.throws(() => parseIncluded('[]'), /no status line/)
})

test('graftGitHub.probe: graft api --include with If-None-Match; all 304 unchanged, a 200 or a failure changed', async () => {
  /** @type {string[][]} */
  const calls = []
  /** @type {Record<string, string | Error>} */
  let answers = {}
  const config = resolveConfig({ repos: [{ slug: 'o/r', path: '/src/r', baseBranch: 'main' }] })
  const gh = graftGitHub({
    config,
    exec: async (_cmd, args) => {
      calls.push(args)
      const a = answers[args[2]]
      if (a instanceof Error) throw a
      return a
    },
  })
  const [issues, base] = Object.values(probeRequests('o/r', { base: 'main' }))
  answers = { [issues]: 'HTTP 200\netag: W/"i1"\n\n[]', [base]: 'HTTP 200\netag: W/"b1"\n\n{}' }
  const first = await /** @type {any} */ (gh).probe('o/r', {})
  assert.deepEqual(first, { changed: true, etags: { issues: 'W/"i1"', base: 'W/"b1"' }, errors: [] })
  assert.deepEqual(calls[0], ['api', 'GET', issues, '--include', '--repo', 'o/r'])
  calls.length = 0
  answers = { [issues]: 'HTTP 304\netag: W/"i1"\n\n', [base]: 'HTTP 304\n\n' }
  const same = await /** @type {any} */ (gh).probe('o/r', first.etags)
  assert.deepEqual(same, { changed: false, etags: { issues: 'W/"i1"', base: 'W/"b1"' }, errors: [] })
  assert.ok(calls.some((a) => a.includes('If-None-Match: W/"b1"') && a[2] === base))
  assert.ok(calls.every((a) => a.at(-4) === '--header'))
  answers = { [issues]: 'HTTP 304\n\n', [base]: new Error('graft api exited 1: 404') }
  const failed = await /** @type {any} */ (gh).probe('o/r', first.etags)
  assert.equal(failed.changed, true)
  assert.deepEqual(failed.etags, { issues: 'W/"i1"', base: null })
  assert.match(failed.errors[0], /^base: graft api exited 1/)
})

test('a reused snapshot marks its release part not fresh, as a kept one is', async () => {
  const h = probed({ issues: [task(1)] })
  const read = h.deps.github.read
  h.deps.github.read = async (slug, opts) => ({
    ...(await read(slug, opts)),
    release: /** @type {any} */ ({ from: 'main', to: 'prod', prs: [], fresh: true }),
  })
  const ctx = /** @type {any} */ ({ reads: new Map() })
  const first = await readRepo(h.deps, ctx, h.deps.config.repos[0].slug)
  assert.equal(first.release?.fresh, true)
  h.clock.advance(MIN / 2)
  const reused = await readRepo(h.deps, ctx, h.deps.config.repos[0].slug)
  assert.deepEqual(ctx.reads.get(h.deps.config.repos[0].slug), { kind: 'probe', why: null })
  assert.equal(reused.release?.fresh, false)
})
