// @ts-check
/**
 * Watched workflows (watch.mjs) and the per-repo config they and the phase overrides read (config.mjs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capsFor, resolveConfig } from '../src/config.mjs'
import { tick } from '../src/tick.mjs'
import { verdictOf, WATCH_LABEL } from '../src/watch.mjs'
import { harness, SLUG } from './fakes.mjs'

const MIN = 60_000

/** @param {number} id @param {string} conclusion */
const run = (id, conclusion) => ({
  id,
  url: `https://github.com/${SLUG}/actions/runs/${id}`,
  sha: `sha${id}`.padEnd(40, '0'),
  conclusion,
  at: '2026-11-23T00:00:00Z',
})

const base = { host: 'mac', paths: { home: '/nonexistent' } }

test('config: watch defaults its branch to baseBranch and opens issues; a string is a workflow', () => {
  const c = resolveConfig({
    ...base,
    repos: [
      {
        slug: SLUG,
        path: '/r',
        baseBranch: 'develop',
        watch: ['e2e.yml', { workflow: 'cd.yml', branch: 'main', issue: false }],
      },
    ],
  })
  assert.deepEqual(c.repos[0].watch, [
    { workflow: 'e2e.yml', branch: 'develop', issue: true },
    { workflow: 'cd.yml', branch: 'main', issue: false },
  ])
  assert.deepEqual(resolveConfig({ ...base, repos: [{ slug: SLUG, path: '/r' }] }).repos[0].watch, [])
  assert.throws(() => resolveConfig({ ...base, repos: [{ slug: SLUG, path: '/r', watch: [{}] }] }), /needs "workflow"/)
  assert.throws(
    () => resolveConfig({ ...base, repos: [{ slug: SLUG, path: '/r', watch: 'ci.yml' }] }),
    /must be a list/,
  )
})

test('config: a repo’s phases override wallClockMinutes and maxTurns, and nothing else', () => {
  const c = resolveConfig({
    ...base,
    repos: [
      { slug: SLUG, path: '/r', phases: { task: { wallClockMinutes: 120 } } },
      { slug: 'o/other', path: '/o' },
    ],
  })
  assert.equal(capsFor(c, SLUG, 'task').wallClockMinutes, 120)
  assert.equal(capsFor(c, SLUG, 'task').maxTurns, c.phases.task.maxTurns)
  assert.equal(capsFor(c, 'o/other', 'task').wallClockMinutes, 60)
  assert.equal(capsFor(c, SLUG, 'dispatch').wallClockMinutes, c.phases.dispatch.wallClockMinutes)
  const bad = (/** @type {any} */ phases) => () =>
    resolveConfig({ ...base, repos: [{ slug: SLUG, path: '/r', phases }] })
  assert.throws(bad({ task: { cap: 5 } }), /a repo may set wallClockMinutes, maxTurns/)
  assert.throws(bad({ build: { maxTurns: 5 } }), /the phases are task, dispatch, rescue and decide/)
  assert.throws(bad({ task: { wallClockMinutes: 0 } }), /above 0/)
})

test('config: mergeStallMinutes and watchEveryMinutes default to 20 and 5, and must be numbers ≥ 0', () => {
  const c = resolveConfig(base)
  assert.equal(c.mergeStallMinutes, 20)
  assert.equal(c.watchEveryMinutes, 5)
  assert.throws(() => resolveConfig({ ...base, mergeStallMinutes: -1 }), /mergeStallMinutes must be a number/)
})

test('verdictOf: the newest run that says anything; cancelled and skipped say nothing', () => {
  assert.equal(verdictOf([run(3, 'cancelled'), run(2, 'failure'), run(1, 'success')])?.state, 'red')
  assert.equal(verdictOf([run(3, 'skipped'), run(2, 'success')])?.run.id, 2)
  assert.equal(verdictOf([run(2, 'timed_out')])?.state, 'red')
  assert.equal(verdictOf([run(1, 'cancelled')]), null)
  assert.equal(verdictOf([]), null)
})

/** @param {object} [watch] */
function watched(watch = { workflow: 'release.yml', branch: 'main' }) {
  return harness({ config: { repos: [{ slug: SLUG, path: '/repo', watch: [watch] }] } })
}

test('a watched workflow goes red: one warn event and one q:human issue; green again closes it', async () => {
  const h = watched()
  h.gh.runs.set('release.yml@main', [run(1, 'success')])
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'createIssue').length, 0)

  h.gh.runs.set('release.yml@main', [run(2, 'failure'), run(1, 'success')])
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'workflowRuns').length, 1, 'not due again within watchEveryMinutes')
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  const made = h.gh.calls.filter((c) => c.op === 'createIssue')
  assert.equal(made.length, 1)
  assert.deepEqual(made[0].args[1].labels, ['q:human', WATCH_LABEL])
  assert.match(made[0].args[1].title, /`release.yml` is failing on `main`/)
  assert.match(made[0].args[1].body, /concluded \*\*failure\*\*: .*runs\/2/)
  assert.ok(h.events.some((e) => e.level === 'warn' && /watch `release.yml` on `main` is red: failure/.test(e.msg)))
  const n = Number(h.events.find((e) => /opened #/.test(e.msg))?.issue)
  assert.ok(n > 0)
  const beat = h.beats.at(-1)?.repos[0].watch[0]
  assert.equal(beat?.state, 'red')
  assert.equal(beat?.issue, n)

  h.clock.advance(5 * MIN)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'createIssue').length, 1, 'the same red run opens nothing more')

  h.gh.runs.set('release.yml@main', [run(3, 'success'), run(2, 'failure')])
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'close').map((c) => c.args[1]),
    [n],
  )
  assert.equal(h.gh.issue(n).state, 'CLOSED')
  assert.equal(h.beats.at(-1)?.repos[0].watch[0].state, 'green')
})

test('a repo without the watch label still gets its issue, with q:human alone', async () => {
  const h = watched()
  h.gh.faults.missingLabels.add(WATCH_LABEL)
  h.gh.runs.set('release.yml@main', [run(2, 'failure')])
  await tick(h.deps)
  const made = h.gh.calls.filter((c) => c.op === 'createIssue')
  assert.deepEqual(
    made.map((c) => c.args[1].labels),
    [['q:human', WATCH_LABEL], ['q:human']],
  )
  assert.ok(!h.events.some((e) => e.level === 'error'))
})

test('issue: false fires the event and opens nothing; a failed read changes nothing', async () => {
  const h = watched({ workflow: 'e2e.yml', branch: 'develop', issue: false })
  h.gh.runs.set('e2e.yml@develop', [run(2, 'failure')])
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'createIssue').length, 0)
  assert.ok(h.events.some((e) => e.level === 'warn' && /e2e.yml/.test(e.msg)))
  h.gh.faults.runsError = new Error('graft api exited 1: /repos/x: 502 (HTML page: 502 Bad Gateway)')
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  const beat = h.beats.at(-1)?.repos[0].watch[0]
  assert.equal(beat?.state, 'red', 'the stored verdict stands')
  assert.match(String(beat?.error), /502/)
})
