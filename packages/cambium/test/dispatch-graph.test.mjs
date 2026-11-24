// @ts-check
/**
 * The `dispatch` graph (engine: "graph"): triage of `q:intake` issues by a read-only `claude -p` worker whose final
 * message carries a typed verdict, and the three outcomes plus an invalid verdict.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toMermaid, validateGraph } from '../src/graph/index.mjs'
import { dispatch, nodeOf } from '../src/graphs/dispatch.mjs'
import { readTriage, triagePrompt } from '../src/phases/dispatch.mjs'
import { tick } from '../src/tick.mjs'
import { runIssue } from '../src/graph-engine.mjs'
import { harness, SLUG, T0 } from './fakes.mjs'

const MIN = 60_000
/** A GitHub "blocked by" link to #n; the fake reads its state from #n. @param {number} n */
const blocker = (n) => ({ number: n, state: /** @type {const} */ ('OPEN'), closedAt: null })

/** A stream-json stdout log whose final message is `text`. @param {string} text */
const logWith = (text) =>
  [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')

/** A final message ending in a fenced JSON verdict. @param {unknown} verdict */
const verdictMessage = (verdict) => `I read the issue and the code.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`

/** @param {{ issues?: any[], cap?: number, config?: any }} [o] */
function intake({
  issues = [{ number: 7, labels: ['q:intake'], body: 'Make the tick faster.' }],
  cap = 1,
  config = {},
} = {}) {
  return harness({
    issues,
    config: { engine: 'graph', phases: { dispatch: { cap }, task: { cap: 0 } }, ...config },
  })
}

/**
 * Tick once to start triage, then end the worker with `log` as its stdout and tick again.
 * @param {ReturnType<typeof harness>} h @param {string} log @param {number} [n]
 */
async function triage(h, log, n = 7) {
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, n)
  assert.ok(w, 'a triage worker is tracked')
  h.spawner.logs.set(w.stdout, log)
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  return w
}

test('dispatch graph: nine nodes, one wait, valid; entry q:intake at start-triage', () => {
  assert.deepEqual(validateGraph(dispatch), [])
  assert.deepEqual(
    dispatch.nodes.map((n) => n.name),
    [
      'start-triage',
      'triaging',
      'retry-triage',
      'to-task',
      'to-human',
      'close-duplicate',
      'deferred',
      'blocked',
      'close-obsolete',
    ],
  )
  assert.deepEqual(
    dispatch.nodes.filter((n) => n.kind === 'wait').map((n) => n.name),
    ['triaging'],
  )
  assert.equal(dispatch.entry.queue, 'q:intake')
  const decl = Object.fromEntries(dispatch.nodes.map((n) => [n.name, [nodeOf(n.name).queue, nodeOf(n.name).running]]))
  assert.deepEqual(decl, {
    'start-triage': ['q:intake', false],
    triaging: ['q:intake', true],
    'retry-triage': ['q:intake', false],
    'to-task': ['q:task', false],
    'to-human': ['q:human', false],
    'close-duplicate': [null, false],
    deferred: ['q:intake', false],
    blocked: ['q:intake', false],
    'close-obsolete': [null, false],
  })
})

test('README shows the dispatch graph exactly as toMermaid renders it', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(`\`\`\`mermaid\n${toMermaid(dispatch)}\`\`\``), 'regenerate the README diagram')
})

test('schedule: triages q:intake issues up to phases.dispatch.cap, priority then age, in read-only checkouts', async () => {
  const h = intake({
    cap: 2,
    issues: [
      { number: 1, labels: ['q:intake'] },
      { number: 2, labels: ['q:intake', 'priority:high'] },
      { number: 3, labels: ['q:intake'] },
      { number: 4, labels: ['q:task'] },
    ],
  })
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [2, 1],
  )
  const s = h.spawner.started[0]
  assert.equal(s.phase, 'dispatch')
  assert.equal(s.readOnly, true)
  assert.equal(s.branch, 'cambium/triage-2')
  assert.equal(s.maxTurns, 50)
  for (const needle of [
    'GitHub issue #2',
    'read-only checkout',
    'never ask one and wait',
    '"verdict"',
    '#4 Issue 4 (q:task)',
  ])
    assert.ok(s.prompt.includes(needle), `prompt mentions ${needle}`)
  assert.ok(!/\b(Seat|Pod|Rig)\b/.test(s.prompt), 'no OpenRig vocabulary')
  assert.deepEqual(h.gh.issue(2).labels.sort(), ['priority:high', 'q:intake', 'running'])
  const m = h.gh.marker(2)
  assert.equal(m?.graph, 'dispatch')
  assert.equal(m?.node, 'triaging')
  assert.equal(m?.phase, 'dispatch')
  assert.equal(h.deps.store.worker(SLUG, 2)?.phase, 'dispatch')
  assert.deepEqual(h.gh.issue(3).labels, ['q:intake'], 'over the cap: waits')
  assert.equal(h.spawner.started.filter((x) => x.phase === 'task').length, 0)

  // Still running: held; capacity is counted from live triage workers.
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2)
})

test('no dispatch cap: q:intake is left alone', async () => {
  const h = intake({ cap: 0 })
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  assert.deepEqual(h.gh.issue(7).labels, ['q:intake'])
})

test('actionable → q:task: a triage comment with the task and its checks, then the task graph takes it', async () => {
  const h = intake()
  const w = await triage(
    h,
    logWith(
      verdictMessage({
        verdict: 'actionable',
        reason: 'Clear and small.',
        title: 'Cache the snapshot between steps',
        acceptance: ['The tick reads each repo once', 'A test covers it'],
      }),
    ),
  )
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  const comment = h.gh.calls.find((c) => c.op === 'comment')
  assert.ok(comment)
  assert.match(comment.args[2], /\*\*Triage: actionable\.\*\* Clear and small\./)
  assert.match(comment.args[2], /\*\*Task:\*\* Cache the snapshot between steps/)
  assert.match(comment.args[2], /- \[ \] The tick reads each repo once\n- \[ \] A test covers it/)
  assert.equal(h.gh.issue(7).body, 'Make the tick faster.', 'the issue body is left alone')
  const m = h.gh.marker(7)
  assert.equal(m?.graph, 'task')
  assert.equal(m?.node, 'start-worker')
  assert.equal(m?.attempt, 1)
  assert.equal(m?.history.at(-1)?.outcome, 'actionable')
  assert.equal(m?.history.at(-1)?.node, 'triaging')
  assert.equal(h.deps.store.worker(SLUG, 7), null, 'the triage worker row is gone')
  assert.deepEqual(h.spawner.cleaned, [w.worktree], 'and its checkout')

  // The task graph schedules it next, with triage's checks in the prompt.
  h.deps.config.phases.task.cap = 1
  await tick(h.deps)
  const t = h.spawner.started.find((s) => s.phase === 'task')
  assert.ok(t)
  assert.equal(t.issue, 7)
  assert.match(t.prompt, /From triage[\s\S]*Task: Cache the snapshot between steps[\s\S]*- \[ \] A test covers it/)
})

test('needs-human → q:human with why:triage and the reason', async () => {
  const h = intake()
  await triage(h, logWith(verdictMessage({ verdict: 'needs-human', reason: 'Which tick? Two candidates; pick one.' })))
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  const m = h.gh.marker(7)
  assert.equal(m?.graph, 'dispatch')
  assert.equal(m?.node, 'to-human')
  assert.equal(m?.lastFailure, 'Which tick? Two candidates; pick one.')
  assert.equal(m?.history.at(-1)?.outcome, 'needs-human')
  // The triage inputs the worker saw, taken when it started: re-triage skips the issue while they hold.
  assert.match(m?.fingerprint?.hash ?? '', /^[0-9a-f]{16}$/)
  assert.equal(m?.fingerprint?.at, new Date(T0).toISOString())
  assert.match(h.gh.issue(7).comment?.body ?? '', /Which tick\? Two candidates/)
  assert.equal(h.deps.store.worker(SLUG, 7), null)
})

const DECIDE = {
  kind: 'decide',
  question: 'Which tick should get the cache?',
  options: [
    { label: 'The task tick', detail: 'Hot path, more risk.' },
    { label: 'The dispatch tick', detail: 'Cold path, less gain.' },
  ],
  recommendation: 'The task tick',
  interactive: true,
  lens: 'technical',
}

test('needs-human with an ask → ask:* labels beside why:triage; the state comment renders it', async () => {
  const h = intake()
  await triage(h, logWith(verdictMessage({ verdict: 'needs-human', reason: 'Two candidates.', ask: DECIDE })))
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['ask:decide', 'ask:session', 'q:human', 'why:triage'])
  assert.deepEqual(h.gh.marker(7)?.ask, DECIDE)
  const body = h.gh.issue(7).comment?.body ?? ''
  assert.match(body, /\*\*Decide:\*\* Which tick should get the cache\?/)
  assert.match(
    body,
    /1\. \*\*The task tick\*\*: Hot path, more risk\.\n2\. \*\*The dispatch tick\*\*: Cold path, less gain\./,
  )
  assert.match(body, /\*\*Recommendation:\*\* The task tick/)
})

test('needs-human with an ask on a repo without the ask:* labels → q:human with why:triage alone, the ask kept', async () => {
  const h = intake()
  h.gh.faults.missingLabels = new Set(['ask:decide', 'ask:session'])
  await triage(h, logWith(verdictMessage({ verdict: 'needs-human', reason: 'Two candidates.', ask: DECIDE })))
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.deepEqual(h.gh.marker(7)?.ask, DECIDE, 'the ask is still in the state comment')
  assert.equal(h.deps.store.worker(SLUG, 7), null, 'the hand-off finished: the worker row is gone')
})

test('a hand-off GitHub keeps refusing backs off (1m, then 2m), not every tick; it lands once GitHub takes it', async () => {
  const h = intake()
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, 7)
  assert.ok(w)
  h.spawner.logs.set(w.stdout, logWith(verdictMessage({ verdict: 'needs-human', reason: 'Which?' })))
  h.procs.live.delete(w.pid)
  h.gh.faults.labelError = new Error('label write refused')
  const labelCalls = () => h.gh.calls.filter((c) => c.op === 'label').length

  await tick(h.deps)
  assert.equal(h.deps.store.worker(SLUG, 7)?.failures, 1, 'the row is kept, its failure counted')
  assert.equal(h.deps.store.worker(SLUG, 7)?.retryAt, T0 + MIN)
  const after1 = labelCalls()
  await tick(h.deps)
  await tick(h.deps)
  assert.equal(labelCalls(), after1, 'not retried before retryAt')

  h.clock.advance(MIN)
  await tick(h.deps)
  assert.equal(h.deps.store.worker(SLUG, 7)?.failures, 2)
  assert.equal(h.deps.store.worker(SLUG, 7)?.retryAt, T0 + 3 * MIN, 'the wait doubles')

  h.gh.faults.labelError = null
  h.clock.advance(2 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.equal(h.deps.store.worker(SLUG, 7), null)
})

test('needs-human with an invalid ask still lands in q:human with why:triage, the ask dropped', async () => {
  const h = intake()
  const ask = { kind: 'decide', question: 'Which?', interactive: false }
  await triage(h, logWith(verdictMessage({ verdict: 'needs-human', reason: 'Two candidates.', ask })))
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  const m = h.gh.marker(7)
  assert.equal(m?.node, 'to-human')
  assert.equal(m?.ask, null)
  assert.match(
    String(m?.lastFailure),
    /^Two candidates\.\n\n\(triage's ask was invalid and was dropped: options: a decide ask needs two or more options\)/,
  )
})

test('duplicate → closed as a duplicate with a link to the original', async () => {
  const h = intake()
  await triage(h, logWith(verdictMessage({ verdict: 'duplicate', duplicateOf: 3, reason: 'Same request as #3.' })))
  assert.equal(h.gh.issue(7).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(7).labels, [])
  const close = h.gh.calls.find((c) => c.op === 'close')
  assert.ok(close)
  assert.match(close.args[2], /^Duplicate of #3 \(https:\/\/github\.com\/o\/r\/issues\/3\)\. Same request as #3\./)
  assert.deepEqual(close.args[3], { reason: 'duplicate' })
  const m = h.gh.marker(7)
  assert.equal(m?.node, 'close-duplicate')
  assert.equal(m?.status, 'done')
  assert.equal(m?.history.at(-1)?.outcome, 'duplicate')
})

test('defer → rests in q:intake until recheck time, then re-triage sees the reason; obsolete closes it', async () => {
  const h = intake()
  const check = 'Next main cd run green → obsolete; red → actionable.'
  await triage(h, logWith(verdictMessage({ verdict: 'defer', reason: check, recheckHours: 2 })))
  assert.deepEqual(h.gh.issue(7).labels, ['q:intake', 'wait:deferred'], 'never q:human; parked, not untriaged')
  let m = h.gh.marker(7)
  assert.equal(m?.node, 'deferred')
  assert.equal(m?.defers, 1)
  assert.equal(m?.deferReason, check)
  assert.equal(Date.parse(m?.deferUntil ?? '') - h.clock.now(), 120 * MIN)
  assert.equal(m?.attempt, 1, 'a defer is not a failed attempt')
  assert.equal(m?.history.at(-1)?.outcome, 'defer')
  assert.match(h.gh.issue(7).comment?.body ?? '', /re-triage after /)

  // Before the recheck time: left alone.
  h.clock.advance(119 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)

  // Due: triaged again, the earlier reason in the prompt; this time it can check, and it is obsolete.
  h.clock.advance(2 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2)
  const p = h.spawner.started[1].prompt
  assert.match(p, /re-triage 2: an earlier triage deferred it to check this:\nNext main cd run green/)
  m = h.gh.marker(7)
  assert.equal(m?.node, 'triaging')
  assert.equal(m?.deferUntil, null)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'running'], 'wait:deferred comes off once triaged')
  const w = h.deps.store.worker(SLUG, 7)
  assert.ok(w)
  h.spawner.logs.set(w.stdout, logWith(verdictMessage({ verdict: 'obsolete', reason: 'cd run 123 on main is green.' })))
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.equal(h.gh.issue(7).state, 'CLOSED')
  assert.deepEqual(h.gh.issue(7).labels, [])
  const close = h.gh.calls.find((c) => c.op === 'close')
  assert.match(close?.args[2], /^Obsolete: cd run 123 on main is green\./)
  assert.deepEqual(close?.args[3], { reason: 'not_planned' })
  m = h.gh.marker(7)
  assert.equal(m?.node, 'close-obsolete')
  assert.equal(m?.status, 'done')
  assert.deepEqual(
    m?.history.map((x) => x.outcome),
    ['defer', 'obsolete'],
  )
})

test('defer → a blocker closing after the defer wakes it before deferUntil; one closed before does not', async () => {
  const h = intake({
    issues: [
      {
        number: 7,
        labels: ['q:intake'],
        body: 'Blocked by #3 and #4.',
        blockedBy: [{ number: 4, state: 'CLOSED', closedAt: new Date(T0 - 60 * MIN).toISOString() }],
      },
    ],
  })
  await triage(h, logWith(verdictMessage({ verdict: 'defer', reason: 'Blocked by #3.', recheckHours: 24 })))
  assert.equal(h.gh.marker(7)?.node, 'deferred')
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:deferred'])

  // #4 closed before the defer: it wakes nothing.
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)

  // GitHub links #3, open: Schedule parks it as blocked at once (its defer reason kept), off the timer.
  h.gh.issue(7).blockedBy.push({ number: 3, state: 'OPEN', closedAt: null })
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.equal(h.gh.marker(7)?.node, 'blocked')
  assert.equal(h.gh.marker(7)?.deferReason, 'Blocked by #3.')
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:blocked'])

  // #3 closes: the next tick triages it again, a day early.
  h.gh.issue(7).blockedBy[1] = { number: 3, state: 'CLOSED', closedAt: new Date(h.clock.now()).toISOString() }
  h.clock.advance(1 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2)
  assert.equal(h.gh.marker(7)?.node, 'triaging')

  // Deferred again with every blocker already closed: it waits for deferUntil, no re-triage every tick.
  const w = h.deps.store.worker(SLUG, 7)
  assert.ok(w)
  h.spawner.logs.set(
    w.stdout,
    logWith(verdictMessage({ verdict: 'defer', reason: 'Wait for the deploy.', recheckHours: 6 })),
  )
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.equal(h.gh.marker(7)?.node, 'deferred')
  h.clock.advance(5 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2)

  // A blocker linked while deferred that closes after the defer: woken at the next tick, before deferUntil.
  h.gh.issue(7).blockedBy.push({ number: 5, state: 'CLOSED', closedAt: new Date(h.clock.now()).toISOString() })
  h.clock.advance(1 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 3)
})

test('defer without recheckHours uses phases.dispatch.deferHours; past maxDefers it goes to a human', async () => {
  const h = intake({ config: { phases: { dispatch: { cap: 1, deferHours: 1, maxDefers: 2 }, task: { cap: 0 } } } })
  const reason = 'Wait for the release.'
  await triage(h, logWith(verdictMessage({ verdict: 'defer', reason })))
  assert.equal(Date.parse(h.gh.marker(7)?.deferUntil ?? '') - h.clock.now(), 60 * MIN)
  for (const n of [2, 3]) {
    h.clock.advance(61 * MIN)
    const w = await triage(h, logWith(verdictMessage({ verdict: 'defer', reason })))
    assert.equal(w.attempt, 1)
    if (n === 2) assert.equal(h.gh.marker(7)?.defers, 2)
  }
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.match(h.gh.marker(7)?.lastFailure ?? '', /deferred 2 times without an answer\. Last: Wait for the release\./)
})

test('invalid triage output → q:human with the validation error', async () => {
  const h = intake()
  await triage(h, logWith(verdictMessage({ verdict: 'duplicate', reason: 'Seen before.' })))
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  const m = h.gh.marker(7)
  assert.equal(m?.history.at(-1)?.outcome, 'invalid')
  assert.match(m?.lastFailure ?? '', /invalid triage result: duplicateOf: a duplicate verdict needs duplicateOf/)
  assert.equal(h.gh.calls.filter((c) => c.op === 'close' || c.op === 'comment').length, 0)
})

test('a triage worker with no result (crashed) → q:human with the error and the stderr tail', async () => {
  const h = intake()
  await triage(h, '{"type":"system","subtype":"init"}\n')
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.match(h.gh.marker(7)?.lastFailure ?? '', /no result event in the worker log[\s\S]*the last stderr line/)
})

test('a triage worker over its wall-clock cap is killed and its issue goes to a human', async () => {
  const h = intake()
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, 7)
  h.clock.advance(16 * MIN)
  await tick(h.deps)
  assert.deepEqual(h.procs.terminated, [w?.pid])
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.equal(h.gh.marker(7)?.history.at(-1)?.outcome, 'killed')
})

test('a stale lease on a q:intake issue retries triage, never requeues into q:task', async () => {
  const h = intake({ cap: 0, issues: [{ number: 7, labels: ['q:intake', 'running'] }] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:intake'])
  const m = h.gh.marker(7)
  assert.equal(m?.graph, 'dispatch')
  assert.equal(m?.node, 'start-triage')
  assert.equal(m?.attempt, 2)
  assert.equal(m?.history.at(-1)?.outcome, 'lost')
})

test('a triage that cannot start is retried, then goes to a human once its attempts are spent', async () => {
  const h = intake()
  h.spawner.fail = new Error('no worktree')
  for (let i = 0; i < 3; i++) await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  const m = h.gh.marker(7)
  assert.match(m?.lastFailure ?? '', /3 triage attempts spent\. Last: could not start triage: no worktree/)
  assert.deepEqual(
    m?.history.map((x) => x.outcome),
    ['spawn-failed', 'spawn-failed', 'spawn-failed'],
  )
})

test('the issue leaving q:intake while triage runs: the verdict is dropped', async () => {
  const h = intake()
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, 7)
  assert.ok(w)
  h.gh.issue(7).labels = ['q:task']
  h.spawner.logs.set(w.stdout, logWith(verdictMessage({ verdict: 'needs-human', reason: 'x' })))
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  assert.equal(h.deps.store.worker(SLUG, 7), null)
})

test('run dispatch --issue N: a foreground triage worker, its verdict read on exit, then the graph ends', async () => {
  const h = intake({ cap: 0 })
  h.spawner.logs.set(
    '/logs/o__r/issue-7/a1.out.log',
    logWith(verdictMessage({ verdict: 'actionable', reason: 'Clear.', title: 'Faster tick' })),
  )
  /** @type {string[]} */
  const out = []
  const r = await runIssue(h.deps, { graph: 'dispatch', slug: SLUG, number: 7, out: (l) => out.push(l) })
  assert.deepEqual(r, { ok: true })
  assert.equal(h.spawner.started.length, 1, 'the cap does not apply to a run by hand')
  assert.equal(h.spawner.started[0].foreground, true)
  assert.equal(h.spawner.started[0].readOnly, true)
  assert.deepEqual(h.gh.issue(7).labels, ['q:task'])
  assert.equal(h.gh.marker(7)?.graph, 'task')
  assert.equal(h.deps.store.worker(SLUG, 7), null, 'the triage worker row is released')
  const text = out.join('\n')
  assert.match(text, /triage worker pid \d+ in /)
  assert.match(text, /triage worker exited 0/)
  assert.match(out.at(-1) ?? '', /o\/r#7: start-worker · labels q:task/)

  // Again: no longer in q:intake.
  const again = await runIssue(h.deps, { graph: 'dispatch', slug: SLUG, number: 7, out: () => {} })
  assert.equal(again.ok, false)
  assert.match(again.error ?? '', /nothing to run in the dispatch graph/)
})

test('engine switched graph → legacy while a triage worker is live: legacy never treats it as a task', async () => {
  const h = intake()
  await tick(h.deps)
  const w = h.deps.store.worker(SLUG, 7)
  assert.ok(w)
  h.spawner.logs.set(w.stdout, logWith(verdictMessage({ verdict: 'actionable', reason: 'Clear.' })))
  const graph = h.deps.config
  h.deps.config = { ...graph, engine: 'legacy', phases: { ...graph.phases, task: { ...graph.phases.task, cap: 1 } } }

  // Live, then gone: legacy reconcile and sweep leave it, and schedules no task.
  await tick(h.deps)
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'running'])
  assert.equal(h.gh.marker(7)?.node, 'triaging')
  assert.ok(h.deps.store.worker(SLUG, 7), 'the triage worker row stays for the graph engine')
  assert.deepEqual(
    h.spawner.started.map((s) => s.phase),
    ['dispatch'],
    'no task worker started',
  )

  // A lost triage lease (no row) is not requeued into q:task either.
  h.deps.store.removeWorker(SLUG, 7)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'running'])

  // Back on the graph engine: the dispatch sweep retries triage.
  h.deps.config = graph
  await tick(h.deps)
  assert.equal(h.gh.marker(7)?.graph, 'dispatch')
  assert.equal(h.gh.marker(7)?.attempt, 2)
})

test('readTriage: the last fenced block, bare JSON, and every way it can be wrong', () => {
  const ok = readTriage(
    logWith(
      '```json\n{"verdict":"needs-human","reason":"old"}\n```\nthen\n```json\n{"verdict":"actionable","reason":"go"}\n```',
    ),
    7,
  )
  assert.deepEqual(ok, { ok: true, result: { verdict: 'actionable', reason: 'go' } })
  assert.deepEqual(readTriage(logWith('{"verdict":"needs-human","reason":"why"}'), 7), {
    ok: true,
    result: { verdict: 'needs-human', reason: 'why' },
  })
  assert.deepEqual(readTriage(logWith('Verdict: {"verdict":"duplicate","duplicateOf":2,"reason":"r"} done'), 7), {
    ok: true,
    result: { verdict: 'duplicate', duplicateOf: 2, reason: 'r' },
  })
  const fail = (/** @type {string} */ log) => {
    const r = readTriage(log, 7)
    assert.equal(r.ok, false)
    return 'error' in r ? r.error : ''
  }
  assert.match(fail(''), /no result event/)
  assert.match(
    fail(JSON.stringify({ type: 'result', subtype: 'error_max_turns' })),
    /without a final message \(error_max_turns\)/,
  )
  assert.match(fail(logWith('I could not decide.')), /no JSON result in the final message/)
  assert.match(fail(logWith('{"verdict":"maybe","reason":"r"}')), /invalid triage result: verdict:/)
  assert.match(fail(logWith('{"verdict":"actionable"}')), /invalid triage result: reason:/)
  assert.match(fail(logWith('{"verdict":"duplicate","duplicateOf":7,"reason":"r"}')), /cannot duplicate itself/)
  assert.deepEqual(readTriage(logWith('{"verdict":"defer","recheckHours":12,"reason":"next cd"}'), 7), {
    ok: true,
    result: { verdict: 'defer', recheckHours: 12, reason: 'next cd' },
  })
  assert.match(fail(logWith('{"verdict":"defer","recheckHours":500,"reason":"r"}')), /recheckHours/)
  assert.deepEqual(readTriage(logWith('{"verdict":"blocked","blockedBy":[3,4],"reason":"needs both"}'), 7), {
    ok: true,
    result: { verdict: 'blocked', blockedBy: [3, 4], reason: 'needs both' },
  })
  assert.match(fail(logWith('{"verdict":"blocked","reason":"r"}')), /blocked verdict needs blockedBy/)
  assert.match(fail(logWith('{"verdict":"blocked","blockedBy":[],"reason":"r"}')), /blockedBy/)
  assert.match(fail(logWith('{"verdict":"blocked","blockedBy":[7],"reason":"r"}')), /cannot block itself/)
  assert.deepEqual(readTriage(logWith('{"verdict":"obsolete","reason":"gone"}'), 7), {
    ok: true,
    result: { verdict: 'obsolete', reason: 'gone' },
  })
  const chore = { kind: 'chore', question: 'Create the App Store listing.', interactive: false }
  assert.deepEqual(readTriage(logWith(JSON.stringify({ verdict: 'needs-human', reason: 'r', ask: chore })), 7), {
    ok: true,
    result: { verdict: 'needs-human', reason: 'r', ask: chore },
  })
  assert.deepEqual(readTriage(logWith(JSON.stringify({ verdict: 'actionable', reason: 'go', ask: chore })), 7), {
    ok: true,
    result: { verdict: 'actionable', reason: 'go' },
  })
  const bad = readTriage(logWith(JSON.stringify({ verdict: 'needs-human', reason: 'r', ask: { kind: 'ponder' } })), 7)
  assert.equal(bad.ok, true)
  assert.match('result' in bad ? bad.result.reason : '', /^r\n\n\(triage's ask was invalid and was dropped: kind:/)
  assert.equal('result' in bad ? bad.result.ask : 'x', undefined)
})

test('triagePrompt: no OpenRig vocabulary; the issue, the queue and AGENTS.md', () => {
  const p = triagePrompt({
    repo: 'o/r',
    baseBranch: 'main',
    issue: /** @type {any} */ ({ number: 9, title: 'T', url: 'u', body: 'B' }),
    queued: [
      { number: 9, title: 'T', labels: ['q:intake'] },
      { number: 1, title: 'Other', labels: ['q:human'] },
    ],
    agentsMd: '# contract',
  })
  assert.ok(!/\b(Seat|Pod|Queue row|Rig)\b/.test(p))
  assert.match(p, /--- Issue #9: T \(u\)\nB/)
  assert.match(p, /- #1 Other \(q:human\)/)
  assert.ok(!p.includes('- #9 T'), 'the issue itself is not in the list')
  assert.match(p, /--- AGENTS\.md/)
  assert.match(p, /- defer: .*default 6/)
  assert.match(p, /- blocked: .*`blockedBy` lists their numbers \(never #9\)/)
  assert.match(p, /\/repos\/o\/r\/issues\/9\/dependencies\/blocked_by/)
  assert.match(p, /never the way to verify what a machine can/)
  assert.match(p, /\/repos\/o\/r\/issues\/9\/timeline/, 'checks linked PRs before judging')
  assert.match(p, /\/repos\/o\/r\/issues\/9\/comments/)
  assert.ok(!p.includes('When in doubt between actionable and needs-human, choose needs-human'))
  assert.ok(!p.includes('re-triage'), 'no defer note on a first triage')
})

test('blocked verdict: links the missing blockedBy, parks with wait:blocked (no timer, no defer), wakes the tick the last blocker closes', async () => {
  const h = intake({
    issues: [
      { number: 7, labels: ['q:intake'], body: 'Needs #3 and #4 first.' },
      { number: 3, labels: [], state: 'CLOSED' },
      { number: 4, labels: ['q:task'] }, // a blocker sits in a queue of its own
    ],
  })
  h.gh.issue(7).blockedBy = [blocker(3)]
  // GitHub already links #3 (closed); triage names #4 only in prose, so cambium adds that link and waits on #4.
  await triage(
    h,
    logWith(verdictMessage({ verdict: 'blocked', blockedBy: [3, 4], reason: 'The API from #3, the UI from #4.' })),
  )
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'addBlockedBy').map((c) => c.args),
    [[SLUG, 7, 4]],
  )
  assert.deepEqual(
    h.gh.issue(7).blockedBy.map((b) => b.number),
    [3, 4],
  )
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:blocked'])
  let m = h.gh.marker(7)
  assert.equal(m?.node, 'blocked')
  assert.deepEqual(m?.blockedBy, [4])
  assert.equal(m?.deferUntil, null)
  assert.equal(m?.defers ?? 0, 0, 'a blocked wait is not a defer')
  assert.equal(m?.history.at(-1)?.outcome, 'blocked')
  assert.match(h.gh.issue(7).comment?.body ?? '', /re-triage once #4 close/)

  // However long it waits, it is not triaged while a blocker is open.
  const writes = h.gh.calls.length
  h.clock.advance(48 * 60 * MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:blocked'])
  assert.deepEqual(
    h.gh.calls.slice(writes).map((c) => c.op),
    ['read'],
    'still parked: nothing written',
  )

  // The last one closes: the next tick triages it, the earlier reason in the prompt.
  h.gh.issue(4).state = 'CLOSED'
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2)
  assert.match(h.spawner.started[1].prompt, /found it blocked by #4, now closed:\nThe API from #3, the UI from #4\./)
  assert.ok(!h.spawner.started[1].prompt.includes('re-triage 1'), 'not a deferred re-triage')
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'running'])
  m = h.gh.marker(7)
  assert.equal(m?.node, 'triaging')
})

test('schedule: an intake issue with an open blockedBy is never triaged; it is parked wait:blocked, whatever its deferUntil', async () => {
  const h = intake({
    cap: 2,
    issues: [
      { number: 7, labels: ['q:intake'] },
      { number: 8, labels: ['q:intake'] },
      { number: 3, labels: ['q:task'] }, // a blocker sits in a queue of its own
    ],
  })
  h.gh.issue(7).blockedBy = [blocker(3)]
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((x) => x.issue),
    [8],
    'only the unblocked one is handed to a worker',
  )
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:blocked'])
  assert.equal(h.gh.marker(7)?.node, 'blocked')
  assert.deepEqual(h.gh.marker(7)?.blockedBy, [3])
  assert.equal(h.gh.calls.filter((c) => c.op === 'addBlockedBy').length, 0, 'GitHub already links it')

  // #8 defers for a day; then GitHub links it to #3 too: parked as blocked, its defer reason kept.
  const w = /** @type {any} */ (h.deps.store.worker(SLUG, 8))
  h.spawner.logs.set(w.stdout, logWith(verdictMessage({ verdict: 'defer', reason: 'blocked by #3', recheckHours: 24 })))
  h.procs.live.delete(w.pid)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(8).labels.sort(), ['q:intake', 'wait:deferred'])
  h.gh.issue(8).blockedBy = [blocker(3)]
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(8).labels.sort(), ['q:intake', 'wait:blocked'])
  assert.equal(h.gh.marker(8)?.node, 'blocked')
  assert.equal(h.gh.marker(8)?.deferReason, 'blocked by #3')
  assert.equal(h.gh.marker(8)?.deferUntil, null)

  // #3 closes an hour later: both are triaged on the next tick, 23 hours before #8's old deferUntil.
  h.clock.advance(60 * MIN)
  h.gh.issue(3).state = 'CLOSED'
  await tick(h.deps)
  assert.deepEqual(
    h.spawner.started.map((x) => x.issue),
    [8, 7, 8],
  )
})

test('blocked waits do not count toward maxDefers; a blocked verdict on closed issues is a defer', async () => {
  const h = intake({
    config: { phases: { dispatch: { cap: 1, maxDefers: 1 }, task: { cap: 0 } } },
    issues: [
      { number: 7, labels: ['q:intake'] },
      { number: 3, labels: ['q:task'] }, // a blocker sits in a queue of its own
      { number: 4, labels: [], state: 'CLOSED' },
    ],
  })
  await triage(h, logWith(verdictMessage({ verdict: 'defer', reason: 'next cd run' })))
  assert.equal(h.gh.marker(7)?.defers, 1)
  h.clock.advance(7 * 60 * MIN)
  for (let n = 0; n < 3; n++) {
    await triage(h, logWith(verdictMessage({ verdict: 'blocked', blockedBy: [3], reason: 'needs #3' })))
    assert.equal(h.gh.marker(7)?.node, 'blocked')
    assert.equal(h.gh.marker(7)?.defers, 1)
    assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:blocked'])
    h.gh.issue(7).blockedBy = [] // unblocked: the link is gone
  }

  // Blocked only on a closed issue: nothing to wait for, so it is a defer, and this one is past maxDefers.
  await triage(h, logWith(verdictMessage({ verdict: 'blocked', blockedBy: [4], reason: 'needs #4' })))
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.match(h.gh.marker(7)?.lastFailure ?? '', /blocked by #4, but none is open\. needs #4/)
})
