// @ts-check
/**
 * The `decide` graph (#161): valid, drawn in the README, resumable from its `cambium:decide` marker alone, paused when
 * idle, and left alone by dispatch while live.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { advance, describeGraph, END, toMermaid, validateGraph } from '../src/graph/index.mjs'
import {
  decide,
  driveDecide,
  IDLE_MS,
  isLiveDecision,
  markerAt,
  parseDecideMarker,
  positionOf,
  renderDecideMarker,
  startOf,
} from '../src/graphs/decide.mjs'
import { normalize } from '../src/github.mjs'
import { humanReplies } from '../src/human-reply.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, T0 } from './fakes.mjs'

const MIN = 60_000
const at = (/** @type {number} */ ms) => new Date(ms).toISOString()

const SEED = {
  issue: {
    repo: 'sektorapp/monorepo',
    number: 4774,
    question: 'Which parts of the map-page redesign should be built?',
    options: [
      { label: 'controls', detail: '', cost: 'S' },
      { label: 'parts-2-3', detail: '', cost: 'M' },
    ],
  },
  lens: /** @type {const} */ ('product'),
  channel: 'terminal',
}

/** A fake agent for #4774: one round of questions, a draft, and "y…" accepts. @type {any} */
const agent = async (/** @type {string} */ node, /** @type {any} */ s) => {
  switch (node) {
    case 'open':
      return s
    case 'orient':
      return {
        ...s,
        needFacts: [],
        visual: true,
        facts: [{ claim: 'No turn-count field on Track', source: 'apps/mobile/src/track.ts:12' }],
        frontier: ['scope', 'friend-laps'],
      }
    case 'mock':
      return {
        ...s,
        mocks: s.issue.options.map((/** @type {any} */ o) => ({ option: o.label, url: `${o.label}.html` })),
      }
    case 'ask-round':
      return {
        ...s,
        rounds: [
          ...s.rounds,
          {
            n: s.rounds.length + 1,
            answers: [],
            questions: s.frontier.map((/** @type {string} */ f) => ({
              id: f,
              title: f,
              text: `${f}?`,
              rec: 'Parts 2+3',
            })),
          },
        ],
      }
    case 'apply-answers': {
      const r = s.rounds.at(-1)
      return {
        ...s,
        rounds: [
          ...s.rounds.slice(0, -1),
          { ...r, answers: r.questions.map((/** @type {any} */ q) => ({ id: q.id, text: s.reply.body })) },
        ],
        decided: [...s.decided, ...r.questions.map((/** @type {any} */ q) => q.id)],
        frontier: [],
      }
    }
    case 'draft':
      return {
        ...s,
        draft: {
          choice: 'Parts 2 + 3',
          inScope: ['bottom panel', 'controls top-right'],
          outOfScope: ['track label restyle'],
          acceptance: ['controls render top-right on Android + iOS'],
          followUps: [{ title: 'Friend-lap count per track', body: '…' }],
        },
      }
    case 'read-confirm':
      return { ...s, confirm: /^y/i.test(s.reply.body) ? 'yes' : /^abandon/i.test(s.reply.body) ? 'abandon' : 'edit' }
  }
  throw new Error(`unexpected agent node ${node}`)
}

/** A driver's world: a clock, a channel inbox, and the one marker comment, written as GitHub would hold it. */
function world() {
  let now = T0
  /** @type {any[]} */
  const inbox = []
  /** @type {unknown[]} */
  const posts = []
  /** @type {string[]} */
  const writes = []
  /** @type {string | null} */
  let comment = null
  const ctx = {
    agent,
    channel: {
      post: async (/** @type {unknown} */ m) => void posts.push(m),
      poll: async () => inbox.shift() ?? null,
    },
    commit: async (/** @type {any} */ s) => ({
      ...s,
      answerUrl: 'https://github.com/sektorapp/monorepo/issues/4774#a',
    }),
    now: () => now,
    holder: 'james@terminal',
    idleMs: 60 * MIN,
  }
  const io = {
    writeMarker: async (/** @type {any} */ m) => {
      writes.push(`marker:${m.status}`)
      comment = renderDecideMarker(m)
    },
    setLabels: async (/** @type {any} */ m) => void writes.push(`labels:${m.status}`),
  }
  /** One turn from the marker alone (or the start when there is none). */
  const turn = async () => {
    const m = parseDecideMarker(comment)
    return driveDecide(m ? positionOf(m) : startOf(SEED), ctx, io)
  }
  /** @param {string} body */
  const reply = (body) => inbox.push({ author: 'james', at: at(now), channel: 'terminal', body })
  return {
    ctx,
    io,
    turn,
    reply,
    posts,
    writes,
    advanceClock: (/** @type {number} */ ms) => {
      now += ms
    },
    marker: () => parseDecideMarker(comment),
  }
}

/** @param {{ transitions: { from: string }[] }} r */
const path = (r) => r.transitions.map((t) => t.from).join(' → ')

test('decide: validateGraph is clean; every node has an about', () => {
  assert.deepEqual(validateGraph(decide), [])
  for (const n of describeGraph(decide).nodes) assert.ok(n.about, `${n.name} has an about`)
})

test('README shows the decide graph exactly as toMermaid renders it', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(`\`\`\`mermaid\n${toMermaid(decide)}\`\`\``), 'regenerate the README diagram')
})

test('decide: describeGraph carries it, its waits and named edges into the heartbeat', async () => {
  const d = describeGraph(decide)
  assert.equal(d.entry.queue, 'q:human')
  assert.deepEqual(
    d.nodes.filter((n) => n.kind === 'wait').map((n) => n.name),
    ['await-answers', 'confirm', 'paused'],
  )
  assert.ok(d.edges.some((e) => e.from === 'apply-answers' && e.to === 'orient' && e.when === 'needsFacts'))
  const h = harness({ config: { engine: 'graph' } })
  await tick(h.deps)
  const beat = /** @type {any} */ (h.beats.at(-1))
  assert.deepEqual(
    beat.graphs.find((/** @type {any} */ g) => g.name === 'decide'),
    JSON.parse(JSON.stringify(d)),
  )
})

test('decide: the #4774 dry run, open to commit over three turns, each resumed from the parsed marker alone', async () => {
  const w = world()
  const t1 = await w.turn()
  assert.equal(path(t1), 'open → orient → mock → ask-round')
  assert.equal(t1.reason, 'waiting')
  assert.equal(w.marker()?.node, 'await-answers')
  assert.equal(w.marker()?.status, 'leased')
  assert.equal(w.marker()?.input.lease?.holder, 'james@terminal')
  assert.equal(w.marker()?.input.mocks.length, 2)

  w.reply('yes')
  const t2 = await w.turn()
  assert.equal(path(t2), 'await-answers → apply-answers → draft')
  assert.equal(w.marker()?.node, 'confirm')
  assert.deepEqual(w.marker()?.input.decided, ['scope', 'friend-laps'])

  w.reply('yes')
  const t3 = await w.turn()
  assert.equal(path(t3), 'confirm → commit')
  assert.equal(t3.reason, 'end')
  const m = w.marker()
  assert.equal(m?.node, END)
  assert.equal(m?.status, 'done')
  assert.equal(m?.outcome, 'answered')
  assert.equal(m?.input.answerUrl, 'https://github.com/sektorapp/monorepo/issues/4774#a')
  assert.equal(isLiveDecision(m), false)
  assert.equal(w.posts.length, 2, 'the round and the draft were posted')
  assert.deepEqual(w.writes, [
    'marker:leased',
    'labels:leased',
    'marker:leased',
    'labels:leased',
    'marker:done',
    'labels:done',
  ])
})

test('decide: a resume from a parsed marker reaches the same next node as an uninterrupted run', async () => {
  // Uninterrupted: the replies are there from the start, so one advance runs to the end.
  const straight = world()
  straight.reply('yes')
  straight.reply('yes')
  const all = await advance(decide, startOf(SEED), straight.ctx, { maxTransitions: 32 })
  assert.equal(all.reason, 'end')
  const order = all.transitions.map((t) => t.to)

  // Interrupted after every transition: the marker is written, rendered, parsed and resumed from.
  const w = world()
  w.reply('yes')
  w.reply('yes')
  let pos = startOf(SEED)
  /** @type {string[]} */
  const seen = []
  for (let i = 0; i < 32; i++) {
    const r = await advance(decide, pos, w.ctx, { maxTransitions: 1 })
    if (r.reason === 'end' && !r.transitions.length) break
    const parsed = parseDecideMarker(renderDecideMarker(markerAt(r, w.ctx)))
    assert.ok(parsed, 'the marker parses')
    seen.push(parsed.node)
    pos = positionOf(parsed)
  }
  assert.deepEqual(seen, order)
})

test('decide: an abandon reply ends without an answer; the marker is done/abandoned', async () => {
  const w = world()
  await w.turn()
  w.reply('stop, not now')
  const r = await w.turn()
  assert.equal(path(r), 'await-answers → abandon')
  assert.equal(w.marker()?.status, 'done')
  assert.equal(w.marker()?.outcome, 'abandoned')
  assert.equal(w.marker()?.input.answerUrl, null)
})

test('decide: an edit at confirm redrafts', async () => {
  const w = world()
  await w.turn()
  w.reply('yes')
  await w.turn()
  w.reply('change the scope')
  const r = await w.turn()
  assert.equal(path(r), 'confirm → draft')
  assert.equal(w.marker()?.node, 'confirm')
  assert.equal(w.marker()?.input.confirm, 'pending')
})

test('decide: idle past the lease pauses; the next reply resumes the wait it left', async () => {
  const w = world()
  await w.turn()
  w.advanceClock(30 * MIN)
  const quiet = await w.turn()
  assert.equal(quiet.transitions.length, 0, 'not idle yet: still waiting for answers')
  assert.equal(w.marker()?.status, 'leased')

  w.advanceClock(31 * MIN)
  const idled = await w.turn()
  assert.equal(path(idled), 'await-answers')
  assert.equal(w.marker()?.node, 'paused')
  assert.equal(w.marker()?.status, 'paused')
  assert.equal(isLiveDecision(w.marker()), true, 'paused is still live')

  w.advanceClock(3 * 24 * 60 * MIN)
  assert.equal((await w.turn()).transitions.length, 0, 'paused holds, however long')
  assert.equal(w.marker()?.node, 'paused')

  w.reply('yes')
  const back = await w.turn()
  assert.equal(path(back), 'paused → await-answers → apply-answers → draft')
  assert.equal(w.marker()?.node, 'confirm')
  assert.equal(w.marker()?.input.paused, null)
  assert.equal(w.marker()?.input.lease?.activeAt, at(T0 + 61 * MIN + 3 * 24 * 60 * MIN))

  // Idle at confirm too, then accepted on the reply.
  w.advanceClock(2 * 60 * MIN)
  await w.turn()
  assert.equal(w.marker()?.status, 'paused')
  assert.equal(w.marker()?.input.paused, 'confirm')
  w.reply('yes')
  const done = await w.turn()
  assert.equal(path(done), 'paused → confirm → commit')
  assert.equal(w.marker()?.outcome, 'answered')
})

test('decide: the lease defaults to IDLE_MS and the holder to cambium', async () => {
  const w = world()
  const ctx = { ...w.ctx, holder: undefined, idleMs: undefined }
  const r = await driveDecide(startOf(SEED), ctx, w.io)
  assert.equal(r.marker.input.lease?.idleMs, IDLE_MS)
  assert.equal(r.marker.input.lease?.holder, 'cambium')
})

test('decide: a node error is recorded in the marker at the failed node, and the next turn retries it', async () => {
  const w = world()
  let fail = true
  const ctx = {
    ...w.ctx,
    agent: async (/** @type {string} */ node, /** @type {any} */ s) => {
      if (node === 'orient' && fail) throw new Error('rate limited')
      return agent(node, s)
    },
  }
  const r = await driveDecide(startOf(SEED), ctx, w.io)
  assert.equal(r.reason, 'error')
  assert.equal(r.marker.node, 'orient')
  assert.match(r.marker.error ?? '', /rate limited/)
  fail = false
  const again = await driveDecide(positionOf(r.marker), ctx, w.io)
  assert.equal(path(again), 'orient → mock → ask-round')
  assert.equal(again.marker.error, null)
})

test('parseDecideMarker: round-trips, survives `--`, rejects junk', () => {
  const m = markerAt({ node: 'orient', input: { ...SEED, notes: 'a -- b -->' } }, { now: () => T0 })
  const body = renderDecideMarker(m)
  assert.match(body, /^\*\*Decision in progress\*\* \(product\): at `orient`\./)
  assert.deepEqual(parseDecideMarker(body), m)
  assert.equal(parseDecideMarker('no marker'), null)
  assert.equal(parseDecideMarker('<!-- cambium:decide {nope} -->'), null)
  assert.equal(parseDecideMarker('<!-- cambium:decide {"v":1,"graph":"decide","node":"x","status":"odd"} -->'), null)
  assert.equal(parseDecideMarker(renderMarker(newMarker())), null, 'a state marker is not a decide marker')
})

test('normalize: the last cambium:decide comment, from any author; humanReplies skips it', () => {
  const live = renderDecideMarker(markerAt({ node: 'await-answers', input: SEED }, { now: () => T0 }))
  const snap = normalize({
    repository: {
      issues: {
        nodes: [
          {
            number: 5,
            state: 'OPEN',
            labels: { nodes: [{ name: 'q:human' }] },
            comments: { nodes: [{ databaseId: 3, body: live, author: { login: 'james' } }] },
            recent: {
              nodes: [{ createdAt: at(T0 + MIN), body: live, author: { login: 'james', __typename: 'User' } }],
            },
          },
        ],
      },
    },
  })
  const issue = /** @type {any} */ (snap.issues.get(5))
  assert.equal(issue.decideComment.id, 3)
  assert.equal(issue.decideComment.marker.node, 'await-answers')
  assert.deepEqual(humanReplies(issue, { since: at(T0) }), [], 'the marker is not a reply')
})

// ---- Dispatch leaves a live decision alone

const BOT = 'oak-agents'

/** A q:human ask:decide issue with a human reply and, optionally, a decide marker at `status`. @param {string | null} status */
function humanIssue(status) {
  const decision =
    status === null
      ? []
      : [
          {
            id: 2,
            author: 'james',
            bot: false,
            createdAt: at(T0 - 50 * MIN),
            body: renderDecideMarker({
              ...markerAt({ node: status === 'done' ? END : 'await-answers', input: SEED }, { now: () => T0 }),
              status: /** @type {any} */ (status),
            }),
          },
        ]
  return {
    number: 7,
    labels: ['q:human', 'why:triage', 'ask:decide', 'ask:session'],
    comment: {
      id: 1,
      body: renderMarker(
        newMarker({ phase: 'dispatch', graph: 'dispatch', node: 'to-human', enteredAt: at(T0 - 60 * MIN) }),
      ),
    },
    comments: [
      ...decision,
      { author: 'james', bot: false, createdAt: at(T0 - 40 * MIN), body: 'Option two, I think.' },
    ],
  }
}

for (const [status, skipped] of /** @type {const} */ ([
  ['leased', true],
  ['paused', true],
  ['done', false],
  [null, false],
]))
  test(`dispatch wake: a q:human reply with ${status ? `a ${status} decide marker` : 'no decide marker'} is ${skipped ? 'left alone' : 're-triaged'}`, async () => {
    const h = harness({
      issues: [humanIssue(status)],
      config: { engine: 'graph', graft: { botLogin: BOT }, phases: { dispatch: { cap: 1 }, task: { cap: 0 } } },
    })
    await tick(h.deps)
    if (skipped) assert.ok(h.gh.issue(7).labels.includes('q:human'), 'stays in q:human')
    else assert.ok(h.gh.issue(7).labels.includes('q:intake'), 'woken for triage')
  })
