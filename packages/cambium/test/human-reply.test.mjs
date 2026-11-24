// @ts-check
/**
 * Human replies (#101): a comment by a human after an issue entered its state wakes a `q:human` issue or a parked
 * intake issue for triage at the next tick, and the triage prompt quotes it as the answer to the open question.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/github.mjs'
import { humanReplies, quoted, REPLY_CHARS, replyContextOf, stateSince } from '../src/human-reply.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { triagePrompt } from '../src/phases/dispatch.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG, T0 } from './fakes.mjs'

const MIN = 60_000
const BOT = 'oak-agents'
const at = (/** @type {number} */ ms) => new Date(ms).toISOString()

/** A stream-json stdout log whose final message carries `verdict`. @param {unknown} verdict */
const verdictLog = (verdict) =>
  JSON.stringify({ type: 'result', subtype: 'success', result: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` })

/** @param {string} author @param {number} ms @param {string} body @param {boolean} [bot] */
const comment = (author, ms, body, bot = false) => ({ author, bot, createdAt: at(ms), body })

/** @param {{ issues: any[], cap?: number }} o */
const graph = ({ issues, cap = 1 }) =>
  harness({
    issues,
    config: { engine: 'graph', graft: { botLogin: BOT }, phases: { dispatch: { cap }, task: { cap: 0 } } },
  })

/** A state comment at `node` of `graph`, entered at `enteredAt`. @param {Record<string, any>} m */
const stateComment = (m) => ({ id: 1, body: renderMarker(newMarker({ phase: 'dispatch', graph: 'dispatch', ...m })) })

const QUESTION = 'Which tick should get faster: the daemon tick or the canopy poll?'

/** A `q:human` issue triage sent to a human at T0 - 1h. @param {Record<string, any>} [o] */
const humanIssue = (o = {}) => ({
  number: 7,
  labels: ['q:human', 'why:triage'],
  body: 'Make the tick faster.',
  comment: stateComment({
    node: 'to-human',
    enteredAt: at(T0 - 60 * MIN),
    lastFailure: QUESTION,
    history: [{ at: at(T0 - 60 * MIN), attempt: 1, outcome: 'needs-human', reason: QUESTION, node: 'triaging' }],
  }),
  ...o,
})

/** End the triage worker of #n with `verdict` and tick. @param {ReturnType<typeof harness>} h @param {unknown} verdict */
async function finishTriage(h, verdict, n = 7) {
  const w = h.deps.store.worker(SLUG, n)
  assert.ok(w, 'a triage worker is tracked')
  h.spawner.logs.set(w.stdout, verdictLog(verdict))
  h.procs.live.delete(w.pid)
  await tick(h.deps)
}

// ---- Detection

test('stateSince: the later of enteredAt and the last history at; null without either', () => {
  assert.equal(stateSince(null), null)
  assert.equal(stateSince(newMarker()), null)
  assert.equal(stateSince(newMarker({ enteredAt: at(T0) })), at(T0))
  const h = [{ at: at(T0 + MIN), attempt: 1, outcome: 'x' }]
  assert.equal(stateSince(newMarker({ history: h })), at(T0 + MIN))
  assert.equal(stateSince(newMarker({ enteredAt: at(T0), history: h })), at(T0 + MIN))
  assert.equal(stateSince(newMarker({ enteredAt: at(T0 + 2 * MIN), history: h })), at(T0 + 2 * MIN))
})

test('humanReplies: by author (bot login, state comment author, Bot type, marker) and by time', () => {
  const issue = /** @type {import('../src/github.mjs').Issue} */ ({
    number: 7,
    stateComment: { id: 1, marker: newMarker(), author: 'cambium-app' },
    comments: [
      comment('alice', T0 - MIN, 'before the state: not a reply'),
      comment(BOT, T0 + MIN, 'cambium by its bot login'),
      comment('cambium-app', T0 + MIN, 'whoever wrote the state comment'),
      comment('renovate', T0 + MIN, 'an App', true),
      comment('bob', T0 + MIN, '<!-- cambium:state {"v":2} --> a pasted marker'),
      comment('alice', T0 + 2 * MIN, 'The daemon tick.'),
    ],
  })
  assert.deepEqual(
    humanReplies(issue, { since: at(T0), botLogin: BOT }).map((c) => c.body),
    ['The daemon tick.'],
  )
  assert.deepEqual(humanReplies(issue, { since: null, botLogin: BOT }), [], 'no state: nothing to reply to')
  assert.equal(humanReplies(issue, { since: at(T0 + 3 * MIN), botLogin: BOT }).length, 0)
})

test('replyContextOf: to-human quotes lastFailure; deferred / blocked their reason; elsewhere none', () => {
  const since = at(T0)
  assert.deepEqual(replyContextOf(newMarker({ node: 'to-human', enteredAt: since, lastFailure: 'Why?' })), {
    since,
    question: 'Why?',
  })
  for (const node of ['deferred', 'blocked'])
    assert.deepEqual(
      replyContextOf(newMarker({ graph: 'dispatch', node, enteredAt: since, deferReason: 'Wait for #3.' })),
      { since, question: 'Wait for #3.' },
    )
  assert.equal(replyContextOf(newMarker({ graph: 'dispatch', node: 'triaging', enteredAt: since })), null)
  assert.equal(replyContextOf(null), null)
})

test('normalize: the recent comments with their time and author type; the state comment author', () => {
  const marker = renderMarker(newMarker())
  const snap = normalize({
    repository: {
      issues: {
        nodes: [
          {
            number: 5,
            state: 'OPEN',
            labels: { nodes: [{ name: 'q:human' }] },
            comments: { nodes: [{ databaseId: 9, body: marker, author: { login: BOT } }] },
            recent: {
              nodes: [
                { createdAt: at(T0), body: marker, author: { login: BOT, __typename: 'Bot' } },
                { createdAt: at(T0 + MIN), body: 'Yes.', author: { login: 'alice', __typename: 'User' } },
                { createdAt: at(T0 + MIN), body: 'Ghost.', author: null },
              ],
            },
          },
        ],
      },
    },
  })
  const issue = snap.issues.get(5)
  assert.equal(issue?.stateComment?.author, BOT)
  assert.deepEqual(issue?.comments, [
    { author: BOT, bot: true, createdAt: at(T0), body: marker },
    { author: 'alice', bot: false, createdAt: at(T0 + MIN), body: 'Yes.' },
    { author: null, bot: false, createdAt: at(T0 + MIN), body: 'Ghost.' },
  ])
})

// ---- Wake

test('q:human + why:triage with a human reply → q:intake, no why:*, triage starts in the same tick with the reply', async () => {
  const h = graph({ issues: [humanIssue({ comments: [comment('alice', T0 - MIN, 'The daemon tick, please.')] })] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'running'])
  assert.equal(h.spawner.started.length, 1)
  const m = h.gh.marker(7)
  assert.equal(m?.graph, 'dispatch')
  assert.equal(m?.node, 'triaging')
  assert.equal(m?.attempt, 1)
  assert.deepEqual(
    m?.history.map((x) => x.outcome),
    ['needs-human', 'human-reply'],
    'history kept, the wake recorded',
  )
  assert.match(m?.history.at(-1)?.reason ?? '', /@alice/)
  const p = h.spawner.started[0].prompt
  assert.match(p, new RegExp(`left it waiting on this:\\n> ${QUESTION.replace(/[?:]/g, '.')}`))
  assert.match(p, /@alice at 2026-11-16T11:59:00\.000Z:\n> The daemon tick, please\./)
  assert.match(p, /usually makes the issue actionable/)
  assert.ok(h.events.some((e) => /human reply from @alice: q:human → q:intake/.test(e.msg)))

  // Needs-human again: it rests; the same reply never wakes it again.
  h.clock.advance(MIN)
  await finishTriage(h, { verdict: 'needs-human', reason: 'Still missing: a target latency.' })
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.equal(h.gh.marker(7)?.reply, null, 'the reply context goes once triage lands a verdict')
  for (let i = 0; i < 3; i++) {
    h.clock.advance(5 * MIN)
    await tick(h.deps)
  }
  assert.equal(h.spawner.started.length, 1)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])

  // The next reply wakes it again, quoted against the new question; the older one is not repeated.
  h.gh.issue(7).comments.push(comment('alice', h.clock.now() - MIN, 'Under 2s.'))
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 2)
  const p2 = h.spawner.started[1].prompt
  assert.match(p2, /> Still missing: a target latency\./)
  assert.match(p2, /> Under 2s\./)
  assert.ok(!p2.includes('The daemon tick, please.'))
})

test('a reply that wakes a q:human issue while the dispatch cap is full is quoted once triage starts', async () => {
  const h = graph({
    issues: [humanIssue({ comments: [comment('alice', T0 - MIN, 'Daemon.')] })],
  })
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 99,
    phase: 'dispatch',
    pid: 1,
    worktree: '/w',
    branch: 'cambium/triage-99',
    attempt: 1,
    startedAt: T0,
    host: 'mac',
    stdout: '/o',
    stderr: '/e',
  })
  h.procs.live.add(1)
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:intake'], 'woken, waiting for a triage slot')
  assert.equal(h.gh.marker(7)?.node, 'start-triage')
  assert.equal(h.spawner.started.length, 0)
  h.deps.store.removeWorker(SLUG, 99)
  h.clock.advance(MIN)
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.match(h.spawner.started[0].prompt, /> Daemon\./)
  assert.match(h.spawner.started[0].prompt, /> Which tick should get faster/)
})

test('never woken: bot-login or Bot-type comments, comments older than the state, why:approve, running', async () => {
  const old = T0 - 2 * 60 * MIN
  const h = graph({
    cap: 4,
    issues: [
      humanIssue({
        comments: [
          comment(BOT, T0 - MIN, 'cambium itself'),
          comment('renovate', T0 - MIN, 'an App', true),
          comment('alice', old, 'before it went to a human'),
        ],
      }),
      humanIssue({
        number: 8,
        labels: ['q:human', 'why:approve'],
        comments: [comment('alice', T0 - MIN, 'Please merge.')],
      }),
      humanIssue({
        number: 9,
        labels: ['q:human', 'why:budget', 'running'],
        comment: {
          id: 2,
          body: renderMarker(newMarker({ node: 'to-human', enteredAt: at(T0 - 60 * MIN), host: 'other-host' })),
        },
        comments: [comment('alice', T0 - MIN, 'Retry it.')],
      }),
    ],
  })
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:human', 'why:triage'])
  assert.deepEqual(h.gh.issue(8).labels.sort(), ['q:human', 'why:approve'])
  assert.deepEqual(h.gh.issue(9).labels.sort(), ['q:human', 'running', 'why:budget'])
  assert.equal(h.gh.calls.filter((c) => c.op === 'writeState' || c.op === 'label').length, 0)
})

test('never woken: an issue with a tracked worker', async () => {
  const h = graph({ issues: [humanIssue({ comments: [comment('alice', T0 - MIN, 'Daemon.')] })] })
  h.deps.store.addWorker({
    repo: SLUG,
    issue: 7,
    phase: 'dispatch',
    pid: 1,
    worktree: '/w',
    branch: 'cambium/triage-7',
    attempt: 1,
    startedAt: T0,
    host: 'mac',
    stdout: '/o',
    stderr: '/e',
  })
  h.procs.live.add(1)
  await tick(h.deps)
  assert.ok(h.gh.issue(7).labels.includes('q:human'))
  assert.equal(h.spawner.started.length, 0)
})

test('wait:deferred with a human reply: triaged at the next tick, before deferUntil, the reply and the reason quoted', async () => {
  const reason = 'Next cd run green → obsolete.'
  const h = graph({
    issues: [
      {
        number: 7,
        labels: ['q:intake', 'wait:deferred'],
        comment: stateComment({
          node: 'deferred',
          enteredAt: at(T0 - 60 * MIN),
          deferUntil: at(T0 + 24 * 60 * MIN),
          deferReason: reason,
          defers: 1,
        }),
      },
    ],
  })
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 0, 'no reply: it waits for deferUntil')
  assert.deepEqual(h.gh.issue(7).labels, ['q:intake', 'wait:deferred'])

  h.gh.issue(7).comments.push(comment('alice', T0 - MIN, 'The cd job was removed; nothing to wait for.'))
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'running'])
  const p = h.spawner.started[0].prompt
  assert.match(p, /> Next cd run green → obsolete\./)
  assert.match(p, /> The cd job was removed/)
  assert.ok(!p.includes('re-triage 2'), 'the reply note replaces the defer note')
})

test('wait:blocked with a human reply: triaged whatever its open blockers; blocked again, it rests', async () => {
  const h = graph({
    issues: [
      {
        number: 7,
        labels: ['q:intake', 'wait:blocked'],
        blockedBy: [{ number: 3, state: 'OPEN', closedAt: null }],
        comment: stateComment({
          node: 'blocked',
          enteredAt: at(T0 - 60 * MIN),
          deferReason: 'Needs the API from #3.',
          blockedBy: [3],
        }),
        comments: [comment('alice', T0 - MIN, 'It does not need #3: the old API works.')],
      },
      { number: 3, labels: ['q:task'] }, // a blocker sits in a queue of its own
    ],
  })
  await tick(h.deps)
  assert.equal(h.spawner.started.length, 1)
  const p = h.spawner.started[0].prompt
  assert.match(p, /> Needs the API from #3\./)
  assert.match(p, /> It does not need #3/)
  assert.ok(!p.includes('now closed'), 'not told its blockers closed')

  h.clock.advance(MIN)
  await finishTriage(h, { verdict: 'blocked', blockedBy: [3], reason: 'It does: the old API lacks the field.' })
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['q:intake', 'wait:blocked'])
  assert.equal(h.gh.marker(7)?.node, 'blocked')
  for (let i = 0; i < 3; i++) {
    h.clock.advance(5 * MIN)
    await tick(h.deps)
  }
  assert.equal(h.spawner.started.length, 1, 'the same reply does not re-trigger')
})

// ---- Prompt

test('triagePrompt: replies quoted under the question; quoted() keeps the newest five, each cut', () => {
  const issue = /** @type {any} */ ({ number: 7, title: 'T', url: 'u', body: 'B' })
  const long = 'x'.repeat(REPLY_CHARS + 50)
  const replies = quoted([
    ...Array.from({ length: 6 }, (_, i) => comment('alice', T0 + i * MIN, `reply ${i}`)),
    comment('bob', T0 + 10 * MIN, `two lines\n${long}`),
  ])
  assert.equal(replies.length, 5)
  assert.equal(replies[0].body, 'reply 2')
  assert.ok(replies[4].body.endsWith('… (cut)'))
  const p = triagePrompt({
    repo: SLUG,
    baseBranch: 'main',
    issue,
    queued: [],
    agentsMd: null,
    replied: { question: 'Which one?', replies },
  })
  assert.match(p, /left it waiting on this:\n> Which one\?\nA human has since replied/)
  assert.match(p, /@bob at 2026-11-16T12:10:00\.000Z:\n> two lines\n> xxx/)
  const plain = triagePrompt({ repo: SLUG, baseBranch: 'main', issue, queued: [], agentsMd: null })
  assert.ok(!plain.includes('A human has since replied'))
})
