// @ts-check
/**
 * Watched workflows (watch.mjs) and the per-repo config they and the phase overrides read (config.mjs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capsFor, resolveConfig } from '../src/config.mjs'
import { tick } from '../src/tick.mjs'
import { HAND_OFF } from '../src/phases/task.mjs'
import { LOG_LINES, logTail, verdictOf, WATCH_LABEL } from '../src/watch.mjs'
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
    { workflow: 'e2e.yml', branch: 'develop', issue: true, agent: true },
    { workflow: 'cd.yml', branch: 'main', issue: false, agent: true },
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

test('agent: false: a red watched workflow opens one q:human issue, as before agents; green again closes it', async () => {
  const h = watched({ workflow: 'release.yml', branch: 'main', agent: false })
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

test('agent: false, a repo without the watch label still gets its issue, with q:human alone', async () => {
  const h = watched({ workflow: 'release.yml', branch: 'main', agent: false })
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

test('config: watch[].agent defaults to true, takes false, and nothing else', () => {
  const repo = (/** @type {any} */ watch) => ({ ...base, repos: [{ slug: SLUG, path: '/r', watch }] })
  assert.equal(resolveConfig(repo(['ci.yml'])).repos[0].watch[0].agent, true)
  assert.equal(resolveConfig(repo([{ workflow: 'ci.yml', agent: false }])).repos[0].watch[0].agent, false)
  assert.throws(
    () => resolveConfig(repo([{ workflow: 'ci.yml', agent: 'no' }])),
    /watch\[0\]\.agent must be true or false/,
  )
})

test('logTail: the last lines, without timestamps, colour or a closing fence', () => {
  const log = Array.from({ length: 60 }, (_, i) => `2026-11-23T00:00:${String(i).padStart(2, '0')}.1234567Z line ${i}`)
  const tail = logTail(`${log.join('\n')}\n\u001b[31m\`\`\`boom\u001b[0m\n\n`)
  const lines = tail.split('\n')
  assert.equal(lines.length, LOG_LINES)
  assert.equal(lines[0], 'line 21')
  assert.equal(lines.at(-1), "'''boom")
  assert.equal(logTail(null), '')
})

/** A red run 2 after green run 1, with its failed job and the commits between them. */
function redWithContext(/** @type {object} */ watch = { workflow: 'docs.yml', branch: 'main' }) {
  const h = watched(watch)
  h.gh.runs.set('docs.yml@main', [run(2, 'failure'), run(1, 'success')])
  h.gh.failures.set(2, {
    jobs: [{ id: 77, name: 'build', url: 'https://github.com/o/r/actions/runs/2/job/77', steps: ['Build docs'] }],
    log: '2026-11-23T00:00:00.0Z [ERROR] canopy.md: bad indentation of a mapping entry\n',
  })
  h.gh.compares.set(`${run(1, '').sha}...${run(2, '').sha}`, [
    { sha: 'aaaa111'.padEnd(40, '0'), message: 'docs: canopy sidebar order\n\nbody' },
    { sha: 'bbbb222'.padEnd(40, '0'), message: 'fix(cambium): something else' },
  ])
  return h
}
const createdIssues = (/** @type {ReturnType<typeof harness>} */ h) => h.gh.calls.filter((c) => c.op === 'createIssue')

test('agent on (the default): a red watched workflow opens a high-priority q:task issue that is the worker’s spec', async () => {
  const h = redWithContext()
  await tick(h.deps)
  const made = createdIssues(h)
  assert.equal(made.length, 1)
  const { labels, body: text, title } = made[0].args[1]
  assert.deepEqual(labels, ['q:task', 'priority:high', WATCH_LABEL])
  assert.match(title, /`docs.yml` is failing on `main`/)
  for (const needle of [
    run(2, '').url,
    run(2, '').sha,
    'job `build`',
    'step `Build docs`',
    'bad indentation of a mapping entry',
    `Last green run: ${run(1, '').url}`,
    '- bbbb222 fix(cambium): something else\n- aaaa111 docs: canopy sidebar order',
    `graft jobs ${run(2, '').url}`,
    'revert',
    '.github/workflows/**',
    HAND_OFF,
  ])
    assert.ok(text.includes(needle), needle)
  assert.ok(!text.includes('[ERROR]\n') && !/2026-11-23T00:00:00.0Z \[ERROR\]/.test(text), 'timestamps stripped')
})

test('agent on: unreadable jobs, no green run, no watch label: the issue still opens, saying what is missing', async () => {
  const h = watched()
  h.gh.faults.missingLabels.add(WATCH_LABEL)
  h.gh.runs.set('release.yml@main', [run(2, 'failure')])
  await tick(h.deps)
  const made = createdIssues(h)
  assert.deepEqual(
    made.map((c) => c.args[1].labels),
    [
      ['q:task', 'priority:high', WATCH_LABEL],
      ['q:task', 'priority:high'],
    ],
  )
  assert.match(made[1].args[1].body, /jobs could not be read/)
  assert.match(made[1].args[1].body, /No green run among the recent ones/)
  assert.ok(!h.events.some((e) => e.level === 'error'))
})

test('agent on: a newer red run comments "Still failing" on the task issue, and a green run closes it', async () => {
  const h = redWithContext()
  h.deps.config.phases.task.cap = 0
  await tick(h.deps)
  const n = Number(h.events.find((e) => /opened #/.test(e.msg))?.issue)
  assert.deepEqual(h.gh.issue(n).labels, ['q:task', 'priority:high', WATCH_LABEL])
  h.gh.runs.set('docs.yml@main', [run(3, 'failure'), run(2, 'failure'), run(1, 'success')])
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  const comments = h.gh.calls.filter((c) => c.op === 'comment' && c.args[1] === n)
  assert.equal(comments.length, 1)
  assert.match(comments[0].args[2], /^Still failing: failure on sha3000.*runs\/3/)
  assert.equal(createdIssues(h).length, 1)
  h.gh.runs.set('docs.yml@main', [run(4, 'success'), run(3, 'failure')])
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  assert.equal(h.gh.issue(n).state, 'CLOSED')
})

for (const engine of /** @type {const} */ (['legacy', 'graph'])) {
  /** A watch task issue whose worker has started; returns the harness and the issue. */
  const working = async (/** @type {object} */ task = {}) => {
    const h = harness({
      config: {
        engine,
        phases: { task: { cap: 1, ...task } },
        repos: [{ slug: SLUG, path: '/repo', watch: [{ workflow: 'docs.yml', branch: 'main' }] }],
      },
    })
    h.gh.runs.set('docs.yml@main', [run(2, 'failure')])
    for (let i = 0; i < 3 && !h.spawner.started.length; i++) {
      await tick(h.deps)
      h.clock.advance(MIN)
    }
    const n = Number(h.events.find((e) => /opened #/.test(e.msg))?.issue)
    assert.equal(h.spawner.started.length, 1, 'a worker took the watch task')
    assert.equal(h.spawner.started[0].issue, n)
    assert.match(h.spawner.started[0].prompt, /cambium:hand-off/)
    return { h, n }
  }

  test(`${engine}: a worker that posts a hand-off and exits without a PR lands in q:human with its findings, attempts unspent`, async () => {
    const { h, n } = await working()
    h.clock.advance(10 * MIN)
    const findings = `${HAND_OFF}\nThe fix is in .github/workflows/docs.yml: the App cannot push it.\n\n\`\`\`diff\n- a\n+ b\n\`\`\``
    h.gh.issue(n).comments.push({
      id: 9001,
      author: 'oakgreen[bot]',
      bot: true,
      createdAt: new Date(h.clock.now()).toISOString(),
      body: findings,
    })
    h.procs.live.clear()
    await tick(h.deps)
    assert.deepEqual(h.gh.issue(n).labels.sort(), ['priority:high', 'q:human', WATCH_LABEL, 'why:budget'].sort())
    const m = h.gh.marker(n)
    assert.equal(m?.attempt, 1, 'a hand-off spends no more attempts')
    assert.equal(m?.history.at(-1)?.outcome, 'handed-off')
    assert.match(String(m?.lastFailure), /handed off to a person: The fix is in \.github\/workflows\/docs\.yml/)
    assert.ok(
      h.gh.issue(n).comments.some((c) => c.body === findings),
      'the findings stay on the issue',
    )
    assert.equal(h.spawner.started.length, 1, 'nothing restarts it')
  })

  test(`${engine}: a watch task whose attempts run out lands in q:human (why:budget); a stale hand-off does not count`, async () => {
    const { h, n } = await working({ maxAttempts: 1 })
    h.gh.issue(n).comments.push({
      id: 9002,
      author: 'oakgreen[bot]',
      bot: true,
      createdAt: new Date(h.clock.now() - 60 * MIN).toISOString(),
      body: `${HAND_OFF}\nan older attempt's`,
    })
    h.clock.advance(10 * MIN)
    h.procs.live.clear()
    await tick(h.deps)
    assert.ok(h.gh.issue(n).labels.includes('q:human'))
    assert.ok(h.gh.issue(n).labels.includes('why:budget'))
    const m = h.gh.marker(n)
    assert.notEqual(m?.history.at(-1)?.outcome, 'handed-off')
    assert.match(String(m?.lastFailure), /1 attempts spent/)
  })
}
