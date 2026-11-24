// @ts-check
/**
 * The tick against a fake clock, GitHub, spawner and process table: every
 * queue transition, and each row of the plan's "Lessons from the old Clock".
 *
 * Every scenario runs on both engines (`engine: "legacy"` and `"graph"`): its
 * own assertions must hold on each, and then the differential check compares
 * what the two did (see `trace` in fakes.mjs). Past a PR's submission the
 * engines differ by design (the graph engine's PR graph), so those scenarios
 * are legacy only (`legacyScenario`); test/pr-graph.test.mjs is the graph side.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store.mjs'
import { tick } from '../src/tick.mjs'
import { GRAPHS } from '../src/graph-engine.mjs'
import { KILL_GRACE_MS } from '../src/workers.mjs'
import { harness as baseHarness, SLUG, stageOf, trace } from './fakes.mjs'

/** The harness the running scenario builds with: {@link baseHarness} pinned to one engine, recorded for tracing. */
let harness = baseHarness

/**
 * A scenario, replayed through both engines: its own assertions must hold on each, then the harnesses it built
 * are traced and compared.
 * @param {string} name @param {() => Promise<void>} fn
 */
function scenario(name, fn) {
  test(name, async () => {
    /** @type {Record<string, unknown[]>} */
    const traces = {}
    for (const engine of ['legacy', 'graph']) {
      /** @type {ReturnType<typeof baseHarness>[]} */
      const made = []
      harness = (seed = {}) => {
        const h = baseHarness({ ...seed, config: { ...seed.config, engine } })
        made.push(h)
        return h
      }
      try {
        await fn()
      } catch (err) {
        const e = /** @type {Error} */ (err)
        e.message = `[engine ${engine}] ${e.message}`
        throw e
      } finally {
        harness = baseHarness
      }
      if (engine === 'graph')
        for (const h of made)
          for (const c of h.gh.calls.filter((c) => c.op === 'writeState'))
            assert.doesNotMatch(c.args[3], /"stage":/, 'the graph engine writes markers without a stage')
      traces[engine] = made.map(trace)
    }
    assert.deepEqual(traces.graph, traces.legacy, 'the graph engine makes the same moves as the legacy tick')
  })
}

/**
 * Legacy only: after a PR is submitted the graph engine runs the PR graph (merge, rework, close, human), which
 * the stage tick does not; test/pr-graph.test.mjs covers the graph side.
 * @param {string} name @param {() => Promise<void>} fn
 */
function legacyScenario(name, fn) {
  test(`${name} (legacy)`, async () => {
    harness = (seed = {}) => baseHarness({ ...seed, config: { ...seed.config, engine: 'legacy' } })
    try {
      await fn()
    } finally {
      harness = baseHarness
    }
  })
}

const MIN = 60_000
const task = (/** @type {number} */ number, /** @type {string[]} */ extra = []) => ({
  number,
  labels: ['q:task', ...extra],
})

scenario('schedule: claims q:task issues up to the cap, priority then age, with the four-point prompt', async () => {
  const h = harness({
    issues: [task(1), task(2, ['priority:low']), task(3, ['priority:high']), task(4)],
    config: { phases: { task: { cap: 2 } } },
  })
  const state = await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [3, 2],
  )
  const first = h.spawner.started[0]
  assert.equal(first.branch, 'agent/3-issue-3')
  assert.equal(first.attempt, 1)
  assert.equal(first.maxTurns, 200)
  for (const needle of [
    'GitHub issue #3',
    'pnpm verify',
    'graft publish agent/3-issue-3',
    '--closes 3',
    'graft ci wait agent/3-issue-3',
    '# AGENTS.md from the worktree',
    'Body of 3',
  ])
    assert.ok(first.prompt.includes(needle), needle)
  assert.deepEqual(h.gh.issue(3).labels.sort(), ['priority:high', 'q:task', 'running'])
  const m = h.gh.marker(3)
  assert.equal(stageOf(m), 'running')
  assert.equal(m?.host, 'mac')
  assert.equal(m?.attempt, 1)
  assert.equal(m?.start, new Date(h.clock.now()).toISOString())
  assert.equal(h.deps.store.workers().length, 2)
  assert.equal(state.counts.workers, 2)
  assert.equal(state.counts.running, 2)
})

scenario('lesson #4309: capacity is counted from live workers, nothing is queued locally', async () => {
  const h = harness({ issues: [1, 2, 3, 4, 5].map((n) => task(n)), config: { phases: { task: { cap: 2 } } } })
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2, 'a second tick starts nothing while both workers live')
  // Worker for #1 finishes with a PR; its slot frees and the next oldest starts in the same tick.
  const w1 = /** @type {any} */ (h.deps.store.worker(SLUG, 1))
  h.procs.live.delete(w1.pid)
  h.gh.addPr({ number: 101, closes: [1] })
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [1, 2, 3],
  )
  assert.equal(h.deps.store.workers().length, 2)
})

scenario('reconcile: a finished worker with an open PR → submitted, out of every queue, worktree pruned', async () => {
  const h = harness({ issues: [task(7)] })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 7))
  h.procs.live.delete(w.pid)
  h.gh.addPr({ number: 70, closes: [7] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, [])
  const m = h.gh.marker(7)
  assert.equal(stageOf(m), 'submitted')
  assert.equal(m?.pr, 70)
  assert.equal(m?.attempt, 1)
  assert.equal(h.deps.store.worker(SLUG, 7), null)
  assert.deepEqual(h.spawner.cleaned, [w.worktree])
  assert.equal(h.gh.calls.filter((c) => c.op === 'writeState' && c.args[1] === 7).length, 2)
  assert.equal(new Set(h.gh.calls.filter((c) => c.op === 'writeState').map((c) => c.args[2] ?? 'new')).size, 2)
})

legacyScenario('reconcile: a PR found only by its branch gets Closes #n, so Watch can see it', async () => {
  const h = harness({ issues: [task(9)] })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 9))
  h.procs.live.delete(w.pid)
  // A base other than the default branch: GitHub links no closing refs, and this body names none.
  h.gh.addPr({ number: 90, closes: [], branch: w.branch })
  await tick(h.deps)
  assert.equal(h.gh.marker(9)?.pr, 90)
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'linkIssue').map((c) => c.args),
    [[SLUG, 90, 9]],
  )
  // Now Watch pairs them: red CI on the PR requeues the issue.
  Object.assign(h.gh.pr(90), { checks: 'FAILURE', headSha: 'red9' })
  await tick(h.deps)
  assert.equal(h.gh.marker(9)?.history.at(-1)?.outcome, 'ci-red')
})

scenario('lesson #4349: a dead worker without a result is requeued with attempt + 1 and the stderr tail', async () => {
  const h = harness({ issues: [task(8)], config: { phases: { task: { cap: 0 } } } })
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 8,
    phase: 'task',
    pid: 999,
    worktree: '/wt/8',
    branch: 'agent/issue-8',
    attempt: 1,
    startedAt: h.clock.now(),
    host: 'mac',
    stdout: '/logs/8.out.log',
    stderr: '/logs/8.err.log',
  })
  h.gh.issue(8).labels.push('running')
  await tick(h.deps)
  const m = h.gh.marker(8)
  assert.equal(m?.attempt, 2)
  assert.equal(stageOf(m), 'queued')
  assert.match(String(m?.lastFailure), /without a published PR/)
  assert.match(String(m?.lastFailure), /the last stderr line/)
  assert.equal(m?.history.at(-1)?.outcome, 'failed')
  assert.equal(m?.history.at(-1)?.log, '/logs/8.out.log')
  assert.deepEqual(h.gh.issue(8).labels, ['q:task'])
  assert.equal(h.deps.store.workers().length, 0, 'the slot is free')
})

scenario('lesson #4349: over the wall-clock cap → terminate the worker (it exits), requeue', async () => {
  const h = harness({ issues: [task(9)] })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 9))
  h.clock.advance(59 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.procs.terminated, [], 'under the cap, untouched')
  h.clock.advance(2 * MIN)
  h.deps.config.phases.task.cap = 0
  await tick(h.deps)
  assert.deepEqual(h.procs.terminated, [w.pid], 'SIGTERM first, so Claude Code ends and flushes its spans')
  assert.deepEqual(h.procs.killed, [], 'it exited on SIGTERM: no SIGKILL')
  const m = h.gh.marker(9)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.history.at(-1)?.outcome, 'killed')
  assert.match(String(m?.lastFailure), /60 min wall-clock cap/)
  assert.deepEqual(h.gh.issue(9).labels, ['q:task'])
})

scenario('a repo’s phases.task.wallClockMinutes overrides the global cap for its workers', async () => {
  const h = harness({
    issues: [task(9)],
    config: { repos: [{ slug: SLUG, path: '/repo', phases: { task: { wallClockMinutes: 120 } } }] },
  })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 9))
  h.deps.config.phases.task.cap = 0
  h.clock.advance(90 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.procs.terminated, [], 'past the global 60, under the repo’s 120: untouched')
  h.clock.advance(31 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.procs.terminated, [w.pid])
  assert.match(String(h.gh.marker(9)?.lastFailure), /120 min wall-clock cap/)
})

scenario('a worker that ignores SIGTERM is held through the grace, then SIGKILLed and requeued', async () => {
  const h = harness({ issues: [task(9)] })
  await tick(h.deps)
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 9))
  h.procs.stubborn.add(w.pid)
  h.deps.config.phases.task.cap = 0
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.procs.terminated, [w.pid])
  assert.deepEqual(h.procs.killed, [], 'within the grace: no SIGKILL yet')
  assert.equal(h.gh.marker(9)?.attempt, 1, 'held: no transition while it may still be flushing')
  assert.ok(h.deps.store.worker(SLUG, 9), 'still tracked')
  h.clock.advance(KILL_GRACE_MS - 60 * 1000 + 1)
  await tick(h.deps)
  assert.deepEqual(h.procs.killed, [w.pid], 'past the cap + grace: SIGKILL')
  assert.deepEqual(h.procs.terminated, [w.pid], 'terminated once')
  const m = h.gh.marker(9)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.history.at(-1)?.outcome, 'killed')
  assert.match(String(m?.lastFailure), /60 min wall-clock cap/)
})

scenario('attempts spent → q:human + why:budget, and nothing restarts it', async () => {
  const h = harness({ issues: [task(10, ['running'])], config: { phases: { task: { maxAttempts: 2 } } } })
  h.gh.issue(10).comment = {
    id: 3,
    body: renderBack({ v: 1, phase: 'task', stage: 'running', attempt: 2, host: 'mac', history: [] }),
  }
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 10,
    phase: 'task',
    pid: 998,
    worktree: '/wt/10',
    branch: 'agent/issue-10',
    attempt: 2,
    startedAt: h.clock.now(),
    host: 'mac',
    stdout: '/logs/10.out.log',
    stderr: '/logs/10.err.log',
  })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(10).labels.sort(), ['q:human', 'why:budget'])
  assert.equal(stageOf(h.gh.marker(10)), 'human')
  assert.equal(h.gh.marker(10)?.host, null)
  assert.match(String(h.gh.marker(10)?.lastFailure), /2 attempts spent/)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
})

scenario('lesson #4565: one loop decides and spawns — a requeued task restarts in the same tick', async () => {
  const h = harness({ issues: [task(29)] })
  await tick(h.deps)
  h.procs.live.clear()
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => [s.issue, s.attempt]),
    [
      [29, 1],
      [29, 2],
    ],
  )
  assert.match(h.spawner.started[1].prompt, /attempt 2 of 3/)
  assert.match(h.spawner.started[1].prompt, /without a published PR/)
  assert.deepEqual(h.gh.issue(29).labels.sort(), ['q:task', 'running'])
})

/** @param {any} m */
function renderBack(m) {
  return `<!-- cambium:state ${JSON.stringify(m)} -->`
}

legacyScenario(
  'lesson #4303: cambium never merges — a green PR waits for the queue; merged → close, delete branch',
  async () => {
    const h = harness({ issues: [task(11)] })
    await tick(h.deps)
    h.procs.live.clear()
    h.gh.addPr({ number: 110, closes: [11], checks: 'SUCCESS' })
    await tick(h.deps)
    await tick(h.deps)
    assert.equal(h.gh.issue(11).state, 'OPEN', 'green and armed: waiting on the merge queue')
    Object.assign(h.gh.pr(110), { state: 'MERGED' })
    await tick(h.deps)
    assert.equal(h.gh.issue(11).state, 'CLOSED')
    assert.equal(stageOf(h.gh.marker(11)), 'done')
    assert.ok(h.gh.calls.some((c) => c.op === 'deleteBranch' && c.args[1] === 'agent/issue-11'))
    const ops = new Set(h.gh.calls.map((c) => c.op))
    assert.deepEqual([...ops].sort(), ['close', 'deleteBranch', 'label', 'read', 'writeState'])
    await tick(h.deps)
    assert.equal(h.gh.calls.filter((c) => c.op === 'deleteBranch').length, 1)
  },
)

legacyScenario('watch: red CI → requeue with the failing log summary, the next worker resumes the PR', async () => {
  const h = harness({ issues: [task(12)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 120, closes: [12], checks: 'PENDING', headSha: 'deadbeef00' })
  await tick(h.deps)
  Object.assign(h.gh.pr(120), {
    checks: 'FAILURE',
    failing: [{ name: 'verify', url: 'https://ci/run/1', summary: 'cambium:test failed\n3 tests red' }],
  })
  await tick(h.deps)
  const m = h.gh.marker(12)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.failedSha, 'deadbeef00')
  assert.match(String(m?.lastFailure), /CI red on PR #120 at deadbee/)
  assert.match(String(m?.lastFailure), /verify \(https:\/\/ci\/run\/1\)/)
  assert.match(String(m?.lastFailure), /3 tests red/)
  const second = /** @type {any} */ (h.spawner.started.at(-1))
  assert.equal(second.issue, 12)
  assert.equal(second.attempt, 2)
  assert.match(second.prompt, /A PR already exists: #120/)
  assert.match(second.prompt, /graft advance agent\/issue-12/)
  assert.match(second.prompt, /3 tests red/)

  // The worker exits without pushing: head is still the red commit → a failed attempt, not "submitted".
  h.procs.live.clear()
  await tick(h.deps)
  assert.equal(h.gh.marker(12)?.attempt, 3)
  assert.match(String(h.gh.marker(12)?.lastFailure), /without pushing a fix/)
})

legacyScenario('watch: the same red commit is not requeued twice', async () => {
  const h = harness({
    issues: [{ number: 13, labels: [] }],
    prs: [{ number: 130, closes: [13], checks: 'FAILURE', headSha: 'abc' }],
    config: { phases: { task: { cap: 0 } } },
  })
  h.gh.issue(13).comment = {
    id: 1,
    body: renderBack({ v: 1, phase: 'task', stage: 'submitted', attempt: 2, pr: 130, failedSha: 'abc', history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0)
})

legacyScenario('watch: dequeued from the merge queue → requeue', async () => {
  const h = harness({ issues: [task(14)], config: { phases: { task: { cap: 1 } } } })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 140, closes: [14], checks: 'SUCCESS' })
  await tick(h.deps)
  Object.assign(h.gh.pr(140), { inMergeQueue: true, autoMerge: false })
  await tick(h.deps)
  assert.equal(h.gh.marker(14)?.queued, true)
  Object.assign(h.gh.pr(140), { inMergeQueue: false })
  h.deps.config.phases.task.cap = 0
  await tick(h.deps)
  assert.equal(h.gh.marker(14)?.attempt, 2)
  assert.match(String(h.gh.marker(14)?.lastFailure), /left the merge queue/)
  assert.deepEqual(h.gh.issue(14).labels, ['q:task'])
})

legacyScenario('watch: not merged within mergeQueueMinutes → q:human', async () => {
  const h = harness({ issues: [task(15)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 150, closes: [15], checks: 'SUCCESS', inMergeQueue: true })
  await tick(h.deps)
  h.clock.advance(121 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(15).labels.sort(), ['q:human', 'why:budget'])
  assert.match(String(h.gh.marker(15)?.lastFailure), /not merged within 120 min/)
})

scenario('restart re-adopts live pids: a fresh tick over the same store starts nothing and moves nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-'))
  const db = join(dir, 'c.db')
  const h = harness({ issues: [task(16), task(17)], store: openStore(db), config: { phases: { task: { cap: 1 } } } })
  await tick(h.deps)
  h.deps.store.close()
  h.deps.store = openStore(db)
  const writesBefore = h.gh.calls.filter((c) => c.op !== 'read').length
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, writesBefore)
  assert.equal(h.deps.store.workers()[0].issue, 16)
})

scenario(
  'lesson #4416: losing SQLite costs a requeue — `running` with no tracked worker on this host is swept',
  async () => {
    const h = harness({ issues: [task(18)], config: { phases: { task: { cap: 0 } } } })
    h.gh.issue(18).labels.push('running')
    h.gh.issue(18).comment = {
      id: 5,
      body: renderBack({ v: 1, phase: 'task', stage: 'running', attempt: 1, host: 'mac', history: [] }),
    }
    await tick(h.deps)
    assert.deepEqual(h.gh.issue(18).labels, ['q:task'])
    assert.equal(h.gh.marker(18)?.attempt, 2)
    assert.equal(h.gh.marker(18)?.history.at(-1)?.outcome, 'lost')
  },
)

scenario("sweep leaves another host's lease alone", async () => {
  const h = harness({ issues: [task(19)], config: { phases: { task: { cap: 0 } } } })
  h.gh.issue(19).labels.push('running')
  h.gh.issue(19).comment = {
    id: 5,
    body: renderBack({ v: 1, phase: 'task', stage: 'running', attempt: 1, host: 'mini', history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0)
})

scenario('lesson #4416: thousands of queued issues are just a sort — the cap still holds', async () => {
  const h = harness({
    issues: Array.from({ length: 2000 }, (_, i) => task(i + 1)),
    config: { phases: { task: { cap: 3 } } },
  })
  const state = await tick(h.deps)
  assert.equal(h.spawner.started.length, 3)
  assert.equal(state.counts.task, 2000)
  assert.ok(state.steps.every((s) => s.ok))
})

scenario('a failed spawn requeues (attempt + 1) instead of holding the lease', async () => {
  const h = harness({ issues: [task(20)] })
  h.spawner.fail = new Error('spawn claude ENOENT')
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(20).labels, ['q:task'])
  assert.equal(h.gh.marker(20)?.attempt, 2)
  assert.match(String(h.gh.marker(20)?.lastFailure), /ENOENT/)
  assert.equal(h.deps.store.workers().length, 0)
})

scenario('a failing step is logged and the tick moves on to the heartbeat', async () => {
  const h = harness({ issues: [task(21)] })
  h.gh.faults.readError = new Error('graft graphql exited 1: rate limited')
  const state = await tick(h.deps)
  const read = state.steps.find((s) => s.name === 'read')
  assert.equal(read?.ok, false)
  assert.match(String(read?.error), /no repository could be read/)
  assert.ok(state.steps.find((s) => s.name === 'schedule'))
  assert.equal(h.beats.length, 1)
  assert.equal(h.beats[0].repos[0].ok, false)
  assert.match(String(h.beats[0].repos[0].error), /rate limited/)
  assert.ok(h.events.some((e) => e.level === 'error' && /rate limited/.test(e.msg)))
})

scenario('a rate-limit error naming its reset pauses that repo’s reads until then, quietly', async () => {
  const h = harness({ issues: [task(21)] })
  const reset = h.clock.now() + 20 * MIN
  h.gh.faults.readError = new Error(
    `graft graphql exited 1: graphql: rate limited until ${new Date(reset).toISOString()}: [{"type":"RATE_LIMIT"}]`,
  )
  await tick(h.deps)
  assert.ok(h.events.some((e) => e.level === 'warn' && /reads paused until/.test(e.msg)))
  h.gh.faults.readError = null
  const reads = () => h.gh.calls.filter((c) => c.op === 'read').length
  const before = reads()
  const events = h.events.length
  h.clock.advance(10 * MIN)
  const state = await tick(h.deps)
  assert.equal(reads(), before, 'paused: no read')
  assert.equal(state.steps.find((s) => s.name === 'read')?.ok, true, 'a pause is not a failed step')
  assert.match(String(h.beats.at(-1)?.repos[0].error), /reads paused until/)
  assert.equal(h.events.length, events, 'nothing logged while paused')
  h.clock.advance(11 * MIN)
  await tick(h.deps)
  assert.equal(reads(), before + 1, 'past the reset: read again')
})

scenario('a snapshot whose budget is nearly spent pauses reads until the reset', async () => {
  const h = harness({ issues: [task(21)] })
  const resetAt = new Date(h.clock.now() + 30 * MIN).toISOString()
  h.gh.health.rateLimit = { cost: 40, remaining: 150, resetAt }
  await tick(h.deps)
  assert.deepEqual(h.beats.at(-1)?.repos[0].rateLimit, { cost: 40, remaining: 150, resetAt })
  assert.ok(h.events.some((e) => /budget nearly spent \(150 left, 40 a read\); reads paused/.test(e.msg)))
  const reads = h.gh.calls.filter((c) => c.op === 'read').length
  h.clock.advance(MIN)
  await tick(h.deps)
  assert.equal(h.gh.calls.filter((c) => c.op === 'read').length, reads)
})

scenario('one failing write does not stop the other items in the step', async () => {
  const h = harness({ issues: [task(22), task(23)] })
  let n = 0
  const label = h.deps.github.label
  h.deps.github.label = async (...args) => {
    if (n++ === 0) throw new Error('label 502')
    return label(...args)
  }
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.ok(h.events.some((e) => /label 502/.test(e.msg) && e.issue === 22))
})

scenario('each step is bounded: a hung read times out and the tick still finishes', async () => {
  const h = harness({ issues: [task(24)], config: { stepTimeoutSeconds: 0.05 } })
  h.gh.faults.hang = true
  const state = await tick(h.deps)
  assert.match(String(state.steps[0].error), /exceeded/)
  assert.equal(h.beats.length, 1)
})

scenario('pause: read and heartbeat only; drain: reconcile but start nothing', async () => {
  const h = harness({ issues: [task(25), task(26)], config: { phases: { task: { cap: 1 } } } })
  h.deps.store.setMode('paused')
  const paused = await tick(h.deps)
  assert.deepEqual(
    paused.steps.map((s) => s.name),
    ['read'],
  )
  assert.equal(paused.mode, 'paused')
  assert.equal(h.beats.length, 1)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0)

  h.deps.store.setMode('running')
  await tick(h.deps)
  h.deps.store.setMode('draining')
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 25))
  h.procs.live.delete(w.pid)
  h.gh.addPr({ number: 250, closes: [25] })
  const drained = await tick(h.deps)
  assert.equal(stageOf(h.gh.marker(25)), 'submitted', 'reconcile still runs')
  assert.equal(h.spawner.started.length, 1, 'nothing new while draining')
  assert.ok(!drained.steps.some((s) => s.name === 'schedule'))
})

scenario('a worker is gone and its issue was closed meanwhile → dropped quietly', async () => {
  const h = harness({ issues: [task(27)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.issue(27).state = 'CLOSED'
  const writes = h.gh.calls.filter((c) => c.op !== 'read').length
  await tick(h.deps)
  assert.equal(h.deps.store.workers().length, 0)
  assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, writes)
})

scenario('read failure: a dead worker waits for a readable snapshot instead of guessing', async () => {
  const h = harness({ issues: [task(28)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.faults.readError = new Error('down')
  await tick(h.deps)
  assert.equal(h.deps.store.workers().length, 1)
  h.gh.faults.readError = null
  h.gh.addPr({ number: 280, closes: [28] })
  await tick(h.deps)
  assert.equal(stageOf(h.gh.marker(28)), 'submitted')
})

// Legacy only: on the graph engine Release is the release-prepare / release-promote graphs (release-graph.test.mjs).
test('release (legacy): the daily seam runs once at its time', async () => {
  const h = baseHarness({
    issues: [{ number: 30, labels: ['q:intake'] }],
    config: { release: { enabled: true, time: '00:00' } },
  })
  /** @type {number[]} */
  const releases = []
  h.deps.release = async ({ now }) => {
    releases.push(now)
    return { done: false, note: 'stub' }
  }
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(releases.length, 1)
  h.clock.advance(24 * 60 * MIN)
  await tick(h.deps)
  assert.equal(releases.length, 2)
  assert.deepEqual(h.gh.issue(30).labels, ['q:intake'], 'intake is untouched without a dispatch cap')
})

// Legacy only: the graph engine runs the dispatch graph instead (test/dispatch-graph.test.mjs).
test('legacy dispatch: the stub is reached only with a cap and leaves q:intake alone', async () => {
  const h = baseHarness({
    issues: [{ number: 30, labels: ['q:intake'] }],
    config: { phases: { dispatch: { cap: 1 } } },
  })
  await tick(h.deps)
  assert.ok(h.events.some((e) => /dispatch phase is not built/.test(e.msg)))
  assert.deepEqual(h.gh.issue(30).labels, ['q:intake'], 'intake is untouched')
  assert.equal(h.spawner.started.length, 0)
})

scenario('heartbeat: the documented shape', async () => {
  const h = harness({ issues: [task(31), { number: 32, labels: ['q:human', 'why:budget'] }] })
  h.deps.tickNumber = 4
  h.deps.daemonStartedAt = h.clock.now() - 1000
  h.deps.pid = 42
  const s = await tick(h.deps)
  assert.deepEqual(Object.keys(s).sort(), [
    'caps',
    'costFlagUsd',
    'counts',
    'daemon',
    'engine',
    'events',
    'graphs',
    'host',
    'mode',
    'pid',
    'repos',
    'steps',
    'tick',
    'version',
    'workers',
  ])
  assert.equal(s.version, 1)
  assert.equal(s.engine, h.config.engine)
  assert.deepEqual(
    s.graphs.map((g) => g.name),
    [...Object.keys(GRAPHS), 'decide'],
  )
  for (const g of s.graphs) {
    assert.ok(g.about, `${g.name} has an about`)
    for (const n of g.nodes) assert.ok(n.about, `${g.name}/${n.name} has an about`)
  }
  assert.equal(s.pid, 42)
  assert.equal(s.tick.n, 4)
  assert.equal(s.daemon.tickSeconds, 30)
  assert.deepEqual(s.counts, { intake: 0, task: 1, human: 1, promote: 0, running: 1, review: 0, workers: 1 })
  assert.deepEqual(Object.keys(s.workers[0]).sort(), [
    'alive',
    'attempt',
    'branch',
    'elapsedMs',
    'issue',
    'killedReason',
    'logs',
    'phase',
    'pid',
    'repo',
    'startedAt',
    'wallClockMs',
    'worktree',
  ])
  assert.deepEqual(s.repos[0].counts, { intake: 0, task: 1, human: 1, promote: 0, running: 1, review: 0 })
  assert.deepEqual(s.repos[0].cost, { issues: [], days: [] }, 'nothing has cost anything yet')
  assert.equal(s.costFlagUsd, 10)
  assert.equal(Date.parse(s.tick.nextAt) - Date.parse(s.tick.finishedAt), 30_000)
})

scenario("worktree convention: the repo's branch template names the branch; a retry keeps it", async () => {
  const h = harness({ issues: [{ number: 30, title: 'Teach the tick: hydrate!', labels: ['q:task'] }] })
  h.spawner.pkgCambium = { worktree: { branch: 'bot/{issue}/{slug}' } }
  await tick(h.deps)
  assert.equal(h.spawner.started[0].branch, 'bot/30/teach-the-tick-hydrate')
  assert.equal(h.gh.marker(30)?.branch, 'bot/30/teach-the-tick-hydrate')
  h.procs.live.clear()
  h.spawner.pkgCambium = undefined
  await tick(h.deps)
  const retry = /** @type {any} */ (h.spawner.started.at(-1))
  assert.equal(retry.attempt, 2)
  assert.equal(retry.branch, 'bot/30/teach-the-tick-hydrate', 'sticky across attempts')
})

scenario('an invalid "cambium" key in the repo fails the start cleanly: requeued, no lease held', async () => {
  const h = harness({ issues: [task(31)] })
  h.spawner.pkgCambium = { worktree: { brnch: 'x' } }
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  assert.deepEqual(h.gh.issue(31).labels, ['q:task'])
  assert.equal(h.gh.marker(31)?.attempt, 2)
  assert.match(String(h.gh.marker(31)?.lastFailure), /could not start the worker: .*unknown key worktree\.brnch/)
  assert.equal(h.gh.marker(31)?.history.at(-1)?.outcome, 'spawn-failed')
})

scenario('a prepare failure requeues as spawn-failed with its stderr tail, even with an open PR', async () => {
  const h = harness({ issues: [task(32)], config: { phases: { task: { cap: 0 } } } })
  h.gh.addPr({ number: 320, closes: [32] })
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 32,
    phase: 'task',
    pid: 998,
    worktree: '/wt/32',
    branch: 'agent/32-x',
    attempt: 1,
    startedAt: h.clock.now(),
    host: 'mac',
    stdout: '/l/32.out.log',
    stderr: '/l/32.err.log',
  })
  h.spawner.stderrTail =
    'ERR_PNPM_OUTDATED_LOCKFILE\ncambium: prepare failed: install `pnpm install --frozen-lockfile` exited 1'
  await tick(h.deps)
  const m = h.gh.marker(32)
  assert.equal(m?.attempt, 2)
  assert.equal(m?.history.at(-1)?.outcome, 'spawn-failed')
  assert.match(String(m?.lastFailure), /^could not start the worker: prepare failed/)
  assert.match(String(m?.lastFailure), /ERR_PNPM_OUTDATED_LOCKFILE/)
})

scenario('teardown: a worktree graft status says holds local-only work is kept, and the log says why', async () => {
  const h = harness({ issues: [task(33)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 330, closes: [33] })
  h.spawner.keep = 'local only (not on GitHub): 1 commit'
  await tick(h.deps)
  assert.equal(stageOf(h.gh.marker(33)), 'submitted')
  assert.deepEqual(h.spawner.cleaned, [])
  assert.ok(
    h.events.some((e) => e.level === 'warn' && /kept worktree .*: local only \(not on GitHub\): 1 commit/.test(e.msg)),
  )
})

scenario('schedule: an issue past its attempt budget goes to q:human without a worker', async () => {
  const h = harness({ issues: [task(34)], config: { phases: { task: { maxAttempts: 2 } } } })
  h.gh.issue(34).comment = {
    id: 7,
    body: renderBack({ v: 1, phase: 'task', stage: 'queued', attempt: 3, history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  assert.deepEqual(h.gh.issue(34).labels.sort(), ['q:human', 'why:budget'])
  assert.equal(h.gh.marker(34)?.history.at(-1)?.outcome, 'budget')
})

legacyScenario('watch: queued in the merge queue, then merged → close from there', async () => {
  const h = harness({ issues: [task(35)] })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 350, closes: [35], checks: 'SUCCESS' })
  await tick(h.deps)
  Object.assign(h.gh.pr(350), { inMergeQueue: true })
  await tick(h.deps)
  assert.equal(h.gh.marker(35)?.queued, true)
  await tick(h.deps)
  Object.assign(h.gh.pr(350), { state: 'MERGED', inMergeQueue: false })
  await tick(h.deps)
  assert.equal(h.gh.issue(35).state, 'CLOSED')
  assert.equal(stageOf(h.gh.marker(35)), 'done')
})

legacyScenario('watch: a queued PR that goes red is requeued with its failing sha', async () => {
  const h = harness({ issues: [task(36)], config: { phases: { task: { cap: 1 } } } })
  await tick(h.deps)
  h.procs.live.clear()
  h.gh.addPr({ number: 360, closes: [36], checks: 'SUCCESS', inMergeQueue: true })
  await tick(h.deps)
  await tick(h.deps)
  Object.assign(h.gh.pr(360), { checks: 'FAILURE', headSha: 'bad0000' })
  h.deps.config.phases.task.cap = 0
  await tick(h.deps)
  assert.equal(h.gh.marker(36)?.failedSha, 'bad0000')
  assert.equal(h.gh.marker(36)?.attempt, 2)
  assert.deepEqual(h.gh.issue(36).labels, ['q:task'])
})

scenario('a human moving q:human back to q:task restarts it at the next attempt', async () => {
  const h = harness({ issues: [{ number: 37, labels: ['q:human', 'why:budget'] }] })
  h.gh.issue(37).comment = {
    id: 9,
    body: renderBack({ v: 1, phase: 'task', stage: 'human', attempt: 2, history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0, 'q:human waits for a human')
  h.gh.issue(37).labels = ['q:task']
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => [s.issue, s.attempt]),
    [[37, 2]],
  )
  assert.deepEqual(h.gh.issue(37).labels.sort(), ['q:task', 'running'])
})

legacyScenario('a merged PR closes its issue even while the issue sits in q:task', async () => {
  const h = harness({ issues: [task(38)], config: { phases: { task: { cap: 0 } } } })
  h.gh.issue(38).comment = {
    id: 11,
    body: renderBack({ v: 1, phase: 'task', stage: 'queued', attempt: 2, history: [] }),
  }
  h.gh.addPr({ number: 380, closes: [38], state: 'MERGED' })
  await tick(h.deps)
  assert.equal(h.gh.issue(38).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(38).labels, [])
})

legacyScenario('watch (#38): q:human removed by hand while its PR is open — red CI is still requeued', async () => {
  const h = harness({
    issues: [{ number: 39, labels: [] }],
    prs: [{ number: 390, closes: [39], checks: 'FAILURE', headSha: 'f00d000' }],
    config: { phases: { task: { cap: 0 } } },
  })
  h.gh.issue(39).comment = {
    id: 12,
    body: renderBack({ v: 1, phase: 'task', stage: 'human', attempt: 1, pr: 390, failedSha: 'old', history: [] }),
  }
  await tick(h.deps)
  assert.equal(h.gh.marker(39)?.attempt, 2)
  assert.equal(h.gh.marker(39)?.failedSha, 'f00d000')
  assert.match(String(h.gh.marker(39)?.lastFailure), /CI red on PR #390/)
  assert.deepEqual(h.gh.issue(39).labels, ['q:task'])
})

legacyScenario(
  'watch (#38): q:task removed by hand while its PR is open — queued, then stalled → q:human',
  async () => {
    const h = harness({
      issues: [{ number: 40, labels: [] }],
      prs: [{ number: 400, closes: [40], checks: 'PENDING' }],
      config: { phases: { task: { cap: 0 } } },
    })
    h.gh.issue(40).comment = {
      id: 13,
      body: renderBack({
        v: 1,
        phase: 'task',
        stage: 'queued',
        attempt: 2,
        submittedAt: new Date(h.clock.now()).toISOString(),
        history: [],
      }),
    }
    await tick(h.deps)
    assert.equal(h.gh.calls.filter((c) => c.op !== 'read').length, 0, 'pending CI: nothing to do')
    Object.assign(h.gh.pr(400), { checks: 'SUCCESS', inMergeQueue: true })
    await tick(h.deps)
    assert.equal(h.gh.marker(40)?.queued, true)
    h.clock.advance(121 * MIN)
    await tick(h.deps)
    assert.deepEqual(h.gh.issue(40).labels.sort(), ['q:human', 'why:budget'])
    assert.match(String(h.gh.marker(40)?.lastFailure), /PR #400 not merged within 120 min/)
  },
)
