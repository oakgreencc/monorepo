// @ts-check
/**
 * The stalled-queue fallback (stall.mjs), driven through `tick` with the fakes: orphan blockers and overdue defers
 * unparked, blocked-by loops reported once and closed when gone, starvation warned once, and re-triage only of the
 * `q:human` issues involved whose triage inputs changed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.mjs'
import { END } from '../src/graph/index.mjs'
import { markerAt, renderDecideMarker } from '../src/graphs/decide.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { loopsOf, STALL_LABEL } from '../src/stall.mjs'
import { tick } from '../src/tick.mjs'
import { fingerprintOf } from '../src/triage-inputs.mjs'
import { harness, SLUG, T0 } from './fakes.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const at = (/** @type {number} */ ms) => new Date(ms).toISOString()

const DECIDE_SEED = {
  issue: { repo: SLUG, number: 41, question: 'Which one?', options: [] },
  lens: /** @type {const} */ ('technical'),
  channel: 'github',
}

/** @param {{ issues?: any[], prs?: any[], config?: any }} seed */
const graph = ({ issues = [], prs = [], config = {} }) =>
  harness({
    issues,
    prs,
    config: {
      engine: 'graph',
      repos: [{ slug: SLUG, path: '/repo', merge: 'green' }],
      phases: { task: { cap: 0 }, dispatch: { cap: 0 } },
      reaper: { everyMinutes: 0 },
      ...config,
    },
  })

/** A dispatch-graph marker at `node`. @param {string} node @param {Record<string, unknown>} [more] */
const dispatchMarker = (node, more = {}) => ({
  id: 1,
  body: renderMarker(
    newMarker({ graph: 'dispatch', phase: 'dispatch', node, status: 'waiting', enteredAt: at(T0 - 2 * HOUR), ...more }),
  ),
})

/** The next stall check: every `stall.everyMinutes` (15). @param {ReturnType<typeof harness>} h */
async function next(h) {
  h.clock.advance(15 * MIN)
  await tick(h.deps)
}

const creates = (/** @type {ReturnType<typeof harness>} */ h) => h.gh.calls.filter((c) => c.op === 'createIssue')
const closes = (/** @type {ReturnType<typeof harness>} */ h) => h.gh.calls.filter((c) => c.op === 'close')
const stallOf = (/** @type {ReturnType<typeof harness>} */ h) => /** @type {any} */ (h.beats.at(-1)).repos[0].stall

test('stall config: defaults, validation, and an old retriage key ignored', () => {
  const c = resolveConfig({ retriage: { enabled: true, time: '05:00', maxSkipDays: 14 } })
  assert.deepEqual(c.stall, { everyMinutes: 15, starvedHours: 6, graceMinutes: 60, overdueMinutes: 60 })
  assert.equal(/** @type {any} */ (c).retriage, undefined)
  assert.equal(resolveConfig({ stall: { everyMinutes: 0 } }).stall.everyMinutes, 0)
  for (const k of ['everyMinutes', 'starvedHours', 'graceMinutes', 'overdueMinutes']) {
    assert.throws(() => resolveConfig({ stall: { [k]: -1 } }), new RegExp(`stall.${k}`))
    assert.throws(() => resolveConfig({ stall: { [k]: '5' } }), new RegExp(`stall.${k}`))
  }
})

test('orphan blocker: wait:blocked with every blocker closed is unparked to triage after graceMinutes', async () => {
  const h = graph({
    issues: [
      {
        number: 10,
        labels: ['q:intake', 'wait:blocked'],
        comment: dispatchMarker('blocked', { blockedBy: [11], deferReason: 'needs #11' }),
        blockedBy: [{ number: 11, state: 'CLOSED', closedAt: at(T0 - 30 * MIN) }],
      },
      // Still blocked: left alone.
      {
        number: 12,
        labels: ['q:intake', 'wait:blocked'],
        comment: dispatchMarker('blocked', { blockedBy: [13] }),
        blockedBy: [{ number: 13, state: 'OPEN', closedAt: null }],
      },
    ],
  })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(10).labels.sort(), ['q:intake', 'wait:blocked'], 'blocker closed 30 min ago: grace')
  h.clock.advance(31 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(10).labels, ['q:intake'])
  const m = h.gh.marker(10)
  assert.equal(m?.node, 'start-triage')
  assert.equal(m?.deferReason, 'needs #11', 'the next triage still sees why it waited')
  assert.equal(m?.history.at(-1)?.outcome, 'unpark')
  assert.deepEqual(h.gh.issue(12).labels.sort(), ['q:intake', 'wait:blocked'])
})

test('overdue defer: wait:deferred past deferUntil + overdueMinutes is unparked, and triage then starts', async () => {
  const h = graph({
    issues: [
      {
        number: 20,
        labels: ['q:intake', 'wait:deferred'],
        comment: dispatchMarker('deferred', { deferUntil: at(T0 - 30 * MIN), deferReason: 'wait for CD', defers: 2 }),
      },
      // Not yet due.
      {
        number: 21,
        labels: ['q:intake', 'wait:deferred'],
        comment: dispatchMarker('deferred', { deferUntil: at(T0 + 5 * HOUR), deferReason: 'later' }),
      },
    ],
  })
  await tick(h.deps)
  assert.ok(h.gh.issue(20).labels.includes('wait:deferred'), '30 min overdue: within the margin')
  h.clock.advance(31 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(20).labels, ['q:intake'])
  assert.equal(h.gh.marker(20)?.node, 'start-triage')
  assert.equal(h.gh.marker(20)?.defers, 2, 'maxDefers still counts')
  assert.ok(h.gh.issue(21).labels.includes('wait:deferred'))

  h.config.phases.dispatch.cap = 1
  await tick(h.deps)
  assert.ok(h.deps.store.worker(SLUG, 20), 'back in triage')
})

test('circular blockedBy: a cycle opens exactly one q:human issue; breaking it closes the issue', async () => {
  const h = graph({
    issues: [
      {
        number: 30,
        labels: ['q:intake', 'wait:blocked'],
        comment: dispatchMarker('blocked'),
        blockedBy: [{ number: 31, state: 'OPEN', closedAt: null }],
      },
      {
        number: 31,
        labels: ['q:intake', 'wait:blocked'],
        comment: dispatchMarker('blocked'),
        blockedBy: [{ number: 30, state: 'OPEN', closedAt: null }],
      },
    ],
  })
  await tick(h.deps)
  await next(h)
  await next(h)
  assert.equal(creates(h).length, 1, 'once, not every check')
  const { title, body, labels } = creates(h)[0].args[1]
  assert.match(title, /#30 → #31 → #30 block each other/)
  assert.match(body, /- #30\n- #31/)
  assert.deepEqual(labels, ['q:human', STALL_LABEL])
  assert.deepEqual(stallOf(h).loops, [{ key: 'cycle:30,31', kind: 'cycle', members: [30, 31], end: null, issue: 9000 }])
  assert.ok(h.events.some((e) => e.level === 'warn' && /block each other in o\/r; opened #9000/.test(e.msg)))
  assert.equal(closes(h).length, 0)

  // A human removes one link.
  h.gh.issue(31).blockedBy = []
  await next(h)
  assert.deepEqual(
    closes(h).map((c) => c.args[1]),
    [9000],
  )
  assert.match(closes(h)[0].args[2], /loop is gone/)
  assert.deepEqual(stallOf(h).loops, [])
  await next(h)
  assert.equal(creates(h).length, 1)
  assert.equal(closes(h).length, 1)
})

test('circular blockedBy: without the stall label the report opens with q:human alone', async () => {
  const h = graph({
    issues: [{ number: 32, labels: ['q:intake'], blockedBy: [{ number: 32, state: 'OPEN', closedAt: null }] }],
  })
  h.gh.faults.missingLabels.add(STALL_LABEL)
  await tick(h.deps)
  assert.deepEqual(
    creates(h).map((c) => c.args[1].labels),
    [['q:human', STALL_LABEL], ['q:human']],
  )
  assert.equal(stallOf(h).loops[0].issue, 9000)
})

/**
 * #40 parked on #41, which is in q:human with a needs-human fingerprint of its inputs as they read now; #42 is in
 * q:human, uninvolved, and its fingerprint no longer matches.
 */
async function chainToHuman() {
  const h = graph({
    issues: [
      {
        number: 40,
        labels: ['q:intake', 'wait:blocked'],
        comment: dispatchMarker('blocked', { blockedBy: [41] }),
        blockedBy: [{ number: 41, state: 'OPEN', closedAt: null }],
      },
      { number: 41, labels: ['q:human', 'why:triage'] },
      { number: 42, labels: ['q:human', 'why:triage'] },
    ],
  })
  const snap = await h.gh.github.read(SLUG)
  const fp = { hash: fingerprintOf(/** @type {any} */ (snap.issues.get(41)), snap), at: at(T0 - HOUR) }
  h.gh.issue(41).comment = dispatchMarker('to-human', { fingerprint: fp, lastFailure: 'Which one?' })
  h.gh.issue(42).comment = dispatchMarker('to-human', { fingerprint: { hash: 'stale', at: fp.at } })
  return h
}

test('chain to q:human: reported once; unchanged inputs mean no re-triage, of it or of the rest of q:human', async () => {
  const h = await chainToHuman()
  await tick(h.deps)
  await next(h)
  assert.equal(creates(h).length, 1)
  assert.match(creates(h)[0].args[1].title, /#40 wait on #41, which is in q:human/)
  assert.deepEqual(h.gh.issue(41).labels.sort(), ['q:human', 'why:triage'], 'unchanged: stays')
  assert.deepEqual(h.gh.issue(42).labels.sort(), ['q:human', 'why:triage'], 'not involved: never re-triaged')
  assert.equal(h.gh.calls.filter((c) => c.op === 'label').length, 0, 'no label moves')
})

test('chain to q:human: once the end issue changes it alone is re-triaged, and the report closes', async () => {
  const h = await chainToHuman()
  await tick(h.deps)
  h.gh.issue(41).body = 'Edited: the second one.'
  await next(h)
  assert.deepEqual(h.gh.issue(41).labels, ['q:intake'])
  assert.deepEqual(h.gh.issue(42).labels.sort(), ['q:human', 'why:triage'])
  assert.ok(h.events.some((e) => e.issue === 41 && /re-triage: its triage inputs changed/.test(e.msg)))
  await next(h)
  assert.deepEqual(
    closes(h).map((c) => c.args[1]),
    [9000],
    '#41 left q:human, so the chain is gone',
  )
})

test('chain to q:human: not before the parked issue has waited graceMinutes', () => {
  const issue = (/** @type {number} */ n, /** @type {string[]} */ labels, blockers = /** @type {number[]} */ ([])) => ({
    number: n,
    state: 'OPEN',
    createdAt: at(T0 - 10 * MIN),
    labels,
    stateComment: null,
    blockedBy: blockers.map((b) => ({ number: b, state: 'OPEN', closedAt: null })),
  })
  const snap = /** @type {any} */ ({
    issues: new Map([
      [1, issue(1, ['q:intake', 'wait:blocked'], [2])],
      [2, issue(2, ['q:task'], [3])],
      [3, issue(3, ['q:human'])],
    ]),
    prs: [],
  })
  assert.deepEqual(loopsOf(snap, { now: T0, graceMs: HOUR }), [])
  assert.deepEqual(loopsOf(snap, { now: T0 + HOUR, graceMs: HOUR }), [
    { key: 'human:3', kind: 'human', members: [1], end: 3 },
  ])
})

test('starved: one warn while it holds, in the heartbeat, cleared when work arrives', async () => {
  const h = graph({
    issues: [
      {
        number: 50,
        labels: ['q:intake', 'wait:deferred'],
        comment: dispatchMarker('deferred', { deferUntil: at(T0 + 24 * HOUR) }),
      },
    ],
    prs: [{ number: 500, closes: [], branch: 'agent/x', state: 'MERGED', mergedAt: at(T0 - 5 * HOUR) }],
  })
  const starvedWarns = () => h.events.filter((e) => e.level === 'warn' && /queue starved/.test(e.msg))
  await tick(h.deps)
  assert.equal(stallOf(h).starved, null, 'merged 5 hours ago: under starvedHours')
  h.clock.advance(61 * MIN)
  await tick(h.deps)
  assert.equal(starvedWarns().length, 1)
  assert.match(starvedWarns()[0].msg, /#50/)
  assert.deepEqual(stallOf(h).starved, {
    since: at(T0 + 61 * MIN),
    parked: [50],
    lastMergeAt: at(T0 - 5 * HOUR),
  })
  await next(h)
  await next(h)
  assert.equal(starvedWarns().length, 1, 'not re-emitted while it holds')
  assert.equal(stallOf(h).starved.since, at(T0 + 61 * MIN))

  await h.gh.github.createIssue(SLUG, { title: 'work', body: '', labels: ['q:task'] })
  await next(h)
  assert.equal(stallOf(h).starved, null)
  assert.ok(h.events.some((e) => /queue moving again/.test(e.msg)))
})

test('starved: a q:human blocker of the parked work is re-triaged only when its inputs changed', async () => {
  const h = await chainToHuman()
  // No merge in the snapshot: starved from the first check.
  await tick(h.deps)
  assert.ok(stallOf(h).starved)
  assert.ok(h.gh.issue(41).labels.includes('q:human'))
  h.gh.issue(41).comments.push({ id: 7, author: 'alice', bot: false, createdAt: at(T0), body: 'The second.' })
  await next(h)
  assert.deepEqual(h.gh.issue(41).labels, ['q:intake'])
  assert.ok(h.gh.issue(42).labels.includes('q:human'))
})

test('stall.everyMinutes 0 turns the fallback off', async () => {
  const h = graph({
    issues: [{ number: 60, labels: ['q:intake'], blockedBy: [{ number: 60, state: 'OPEN', closedAt: null }] }],
    config: { stall: { everyMinutes: 0 } },
  })
  await tick(h.deps)
  assert.equal(creates(h).length, 0)
  assert.deepEqual(stallOf(h), { checkedAt: null, starved: null, loops: [] })
})

test('chain to q:human: a live decision on the end issue holds off its re-triage; a done one does not', async () => {
  for (const [status, retriaged] of /** @type {const} */ ([
    ['leased', false],
    ['done', true],
  ])) {
    const h = await chainToHuman()
    const m = markerAt({ node: status === 'done' ? END : 'await-answers', input: DECIDE_SEED }, { now: () => T0 })
    h.gh.issue(41).comments = [
      { author: 'james', bot: false, createdAt: at(T0 - HOUR), body: renderDecideMarker({ ...m, status }) },
    ]
    await tick(h.deps)
    h.gh.issue(41).body = 'Edited: the second one.'
    await next(h)
    assert.deepEqual(h.gh.issue(41).labels.sort(), retriaged ? ['q:intake'] : ['q:human', 'why:triage'], status)
  }
})
