// @ts-check
/**
 * The hosted decide driver (#167): cambium's tick walks a `q:human` + `ask:decide` + `ask:session` issue through
 * the `decide` graph over GitHub comments, each agent step a one-shot worker rebuilt from the marker alone, and only
 * answerers on the allowlist move it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.mjs'
import { decidePrompt, githubChannel, hosted, parsePostTag, seedOf } from '../src/decide-driver.mjs'
import { END } from '../src/graph/index.mjs'
import { parseDecideMarker, startOf } from '../src/graphs/decide.mjs'
import { parseAnswer } from '../src/human-reply.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { openStore } from '../src/store.mjs'
import { tick } from '../src/tick.mjs'
import { fakeClock, fakeProcs, fakeSpawner, harness, SLUG, T0 } from './fakes.mjs'

const MIN = 60_000
const N = 4774

const ASK = {
  kind: 'decide',
  question: 'Which parts of the map-page redesign should be built?',
  options: [
    { label: 'controls', detail: 'Move the controls top-right' },
    { label: 'parts-2-3', detail: 'The bottom panel and the controls' },
  ],
  interactive: true,
  lens: 'product',
}

const DECIDE = { channel: 'github', answerers: { github: ['james'] }, idleHours: 24 }
const CONFIG = { engine: 'graph', graft: { botLogin: 'cambium[bot]' }, decide: DECIDE }

/** The fixture decision's agent: one round, a draft, "y…" accepts. @type {(node: string, s: any) => any} */
function agent(node, s) {
  switch (node) {
    case 'open':
      return { frontier: ['scope', 'friend-laps'] }
    case 'orient':
      return {
        facts: [{ claim: 'No turn-count field on Track', source: 'apps/mobile/src/track.ts:12' }],
        needFacts: [],
      }
    case 'ask-round':
      return {
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
        draft: {
          choice: 'Parts 2 + 3',
          inScope: ['bottom panel', 'controls top-right'],
          outOfScope: ['track label restyle'],
          acceptance: ['controls render top-right on Android + iOS'],
          followUps: [{ title: 'Friend-lap count per track', body: 'Count friend laps per track.' }],
        },
      }
    case 'read-confirm':
      return { confirm: /^y/i.test(s.reply.body) ? 'yes' : 'edit' }
  }
  throw new Error(`unexpected node ${node}`)
}

/** The stream-json log a worker leaves: one result event whose final message ends with the JSON. @param {unknown} json */
const resultLog = (json) =>
  `${JSON.stringify({ type: 'result', subtype: 'success', result: `Done.\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` })}\n`

/**
 * A cambium process: its own store, spawner, procs and clock, over the one shared fake GitHub. A restart is a new
 * process: nothing carries over but GitHub.
 * @param {ReturnType<typeof harness>} h @param {number} now
 */
function processOver(h, now) {
  const procs = fakeProcs()
  const spawner = fakeSpawner(procs)
  const clock = fakeClock(now)
  /** @type {any[]} */
  const events = []
  const deps = {
    ...h.deps,
    clock,
    procs,
    spawner,
    store: openStore(':memory:'),
    log: (/** @type {any} */ level, /** @type {string} */ msg, where = {}) => events.push({ level, msg, ...where }),
    events: () => events,
    heartbeat: undefined,
  }
  h.gh.commentClock.now = () => clock.now()
  /** Every running decide worker exits with the fixture agent's step, read from its prompt alone. */
  const finishWorkers = () => {
    for (const w of deps.store.workers().filter((x) => x.phase === 'decide')) {
      const spec = /** @type {any} */ (spawner.started.findLast((s) => s.branch === w.branch))
      const node = w.branch.slice(`cambium/decide-${w.issue}-`.length)
      const state = JSON.parse(/** @type {string} */ (/<state>\n([\s\S]*?)\n<\/state>/.exec(spec.prompt)?.[1]))
      spawner.logs.set(w.stdout, resultLog(agent(node, state)))
      procs.live.delete(w.pid)
    }
  }
  /** A tick, then its workers finish, then a minute passes. */
  const step = async () => {
    await tick(/** @type {any} */ (deps))
    finishWorkers()
    clock.advance(MIN)
  }
  return { deps, clock, spawner, procs, events, step }
}

/** The fixture issue: in the Human Queue for a session decision, its ask in the state comment. */
function fixture() {
  const h = harness({
    config: CONFIG,
    issues: [
      {
        number: N,
        title: 'Map-page redesign',
        labels: ['q:human', 'why:triage', 'ask:decide', 'ask:session'],
        comment: { id: 1, body: renderMarker(newMarker({ node: 'to-human', ask: /** @type {any} */ (ASK) })) },
        comments: [
          { id: 10, author: 'james', bot: false, createdAt: new Date(T0 - 60 * MIN).toISOString(), body: 'older talk' },
        ],
      },
    ],
  })
  let nextId = 3000
  /** @param {string} author @param {string} body @param {number} now */
  const say = (author, body, now) =>
    h.gh.issue(N).comments.push({ id: nextId++, author, bot: false, createdAt: new Date(now).toISOString(), body })
  const marker = () => parseDecideMarker(h.gh.issue(N).comments.findLast((c) => parseDecideMarker(c.body))?.body)
  const posts = (/** @type {string} */ kind) =>
    h.gh.issue(N).comments.filter((c) => parsePostTag(c.body)?.kind === kind)
  return { h, say, marker, posts }
}

test('hosted decide: a fixture decision runs end to end on ticks, restarted mid-way, without losing or double-posting a round', async () => {
  const f = fixture()
  let p = processOver(f.h, T0)

  // open, orient, ask-round: each a worker started on one tick and read on the next.
  await p.step()
  assert.equal(f.marker()?.node, 'open', 'the decision is live from the first tick')
  assert.equal(f.marker()?.status, 'leased')
  assert.equal(p.spawner.started.at(-1)?.phase, 'decide')
  assert.equal(p.spawner.started.at(-1)?.readOnly, true)
  assert.match(p.spawner.started.at(-1)?.prompt ?? '', /## Step: `open`/)
  await p.step()
  assert.equal(f.marker()?.node, 'orient')
  assert.equal(f.marker()?.input.lease?.holder, 'cambium@github')
  await p.step()
  assert.equal(f.marker()?.node, 'ask-round')

  // The round is posted, then the process dies before the marker says so.
  f.h.gh.crash.decideWrite = new Error('killed')
  await p.step()
  assert.equal(f.posts('round').length, 1, 'the round went out')
  assert.equal(f.marker()?.node, 'ask-round', 'the marker never heard')

  // A fresh process: no store, no workers; only GitHub. It reruns ask-round and does not post the round again.
  p = processOver(f.h, p.clock.now())
  await p.step()
  await p.step()
  assert.equal(f.marker()?.node, 'await-answers')
  assert.equal(f.posts('round').length, 1, 'no second round')
  assert.match(f.posts('round')[0].body, /round 1: Which parts/)
  assert.match(f.posts('round')[0].body, /\*\*1\. scope\*\*/)

  // Nothing to answer yet: the tick writes nothing.
  const writes = f.h.gh.calls.filter((c) => c.op === 'writeState').length
  await p.step()
  assert.equal(f.h.gh.calls.filter((c) => c.op === 'writeState').length, writes, 'an idle wait writes no marker')

  // The answer; restart again while the apply-answers worker is in flight.
  f.say('james', 'yes', p.clock.now())
  p.clock.advance(1000)
  await p.step()
  assert.equal(f.marker()?.node, 'apply-answers')
  assert.equal(f.marker()?.input.reply?.body, 'yes')
  assert.equal(f.marker()?.input.cursor?.author, 'james')
  p = processOver(f.h, p.clock.now())
  await p.step() // starts apply-answers afresh: the reply is in the marker
  await p.step() // apply-answers → draft (worker)
  await p.step() // draft posted → confirm
  assert.equal(f.marker()?.node, 'confirm')
  assert.deepEqual(f.marker()?.input.decided, ['scope', 'friend-laps'])
  assert.equal(f.posts('draft').length, 1)
  assert.match(f.posts('draft')[0].body, /\*\*Choice:\*\* Parts 2 \+ 3/)

  // Accept: read-confirm, then commit.
  f.say('james', 'yes, ship it', p.clock.now())
  p.clock.advance(1000)
  await p.step()
  await p.step()
  const m = f.marker()
  assert.equal(m?.node, END)
  assert.equal(m?.status, 'done')
  assert.equal(m?.outcome, 'answered')
  const answer = f.h.gh.issue(N).comments.find((c) => parseAnswer(c.body))
  assert.ok(answer, 'the answer comment is posted')
  assert.equal(parseAnswer(answer.body)?.answerer, 'james')
  assert.match(answer.body, /Decided\*\* by james \(github\): Parts 2 \+ 3/)
  const filed = f.h.gh.calls.filter((c) => c.op === 'createIssue')
  assert.equal(filed.length, 1)
  assert.deepEqual(filed[0].args[1].labels, ['q:intake'])
  assert.equal(f.posts('round').length, 1)
  assert.equal(f.posts('draft').length, 1)

  // Done: the driver leaves it alone.
  const calls = f.h.gh.calls.length
  await p.step()
  assert.equal(f.h.gh.calls.filter((c, i) => i >= calls && c.op !== 'read').length, 0)
})

test('hosted decide: a reply from a login not on the allowlist does not advance the graph and is noted in the marker', async () => {
  const f = fixture()
  const p = processOver(f.h, T0)
  for (let i = 0; i < 4; i++) await p.step()
  assert.equal(f.marker()?.node, 'await-answers')

  f.say('mallory', 'yes', p.clock.now())
  p.clock.advance(1000)
  await p.step()
  await p.step()
  assert.equal(f.marker()?.node, 'await-answers', 'not advanced')
  assert.equal(f.marker()?.input.reply, null)
  assert.deepEqual(
    f.marker()?.input.ignored.map((x) => x.author),
    ['mallory'],
    'noted once, however many ticks see it',
  )
  assert.ok(p.events.some((e) => /ignored a reply from mallory/.test(e.msg)))

  // The bot's own comments are not replies, and are not noted.
  f.h.gh.issue(N).comments.push({
    id: 5000,
    author: 'cambium[bot]',
    bot: true,
    createdAt: new Date(p.clock.now()).toISOString(),
    body: 'something',
  })
  await p.step()
  assert.deepEqual(
    f.marker()?.input.ignored.map((x) => x.author),
    ['mallory'],
  )

  // An answerer's reply moves it on (case-insensitive login).
  f.say('James', 'yes', p.clock.now())
  p.clock.advance(1000)
  await p.step()
  assert.equal(f.marker()?.node, 'apply-answers')
  assert.equal(f.marker()?.input.reply?.author, 'James')
})

test('hosted decide: which issues it drives', () => {
  const base = /** @type {any} */ ({
    number: 1,
    state: 'OPEN',
    labels: ['q:human', 'why:triage', 'ask:decide', 'ask:session'],
    decideComment: null,
  })
  assert.equal(hosted(base, 'github'), true)
  assert.equal(hosted({ ...base, labels: ['q:human', 'ask:decide'] }, 'github'), false, 'not a session decision')
  assert.equal(hosted({ ...base, labels: [...base.labels, 'why:budget'] }, 'github'), false)
  const at = (/** @type {any} */ status, /** @type {string} */ channel) => ({
    ...base,
    decideComment: { id: 2, marker: { status, input: { channel } } },
  })
  assert.equal(hosted(at('leased', 'terminal'), 'github'), false, 'a terminal session holds it')
  assert.equal(hosted(at('paused', 'github'), 'github'), true)
  assert.equal(hosted(at('done', 'github'), 'github'), false)
})

test('hosted decide: the seed comes from the ask; the prompt carries the whole state', () => {
  const issue = /** @type {any} */ ({
    number: N,
    title: 'Map-page redesign',
    url: 'https://github.com/o/r/issues/4774',
    stateComment: { id: 1, marker: newMarker({ ask: /** @type {any} */ (ASK) }) },
  })
  const seed = seedOf(SLUG, issue, 'github')
  assert.equal(seed.issue.question, ASK.question)
  assert.deepEqual(
    seed.issue.options.map((o) => o.label),
    ['controls', 'parts-2-3'],
  )
  assert.equal(seed.lens, 'product')
  const prompt = decidePrompt({ url: issue.url, node: 'orient', state: startOf(seed).input, agentsMd: null })
  assert.match(prompt, /## Step: `orient`/)
  assert.ok(prompt.includes(JSON.stringify(startOf(seed).input, null, 2)))
})

test('github channel: replies after the cursor, in order; posts skipped once there', async () => {
  const comments = [
    { id: 1, author: 'james', bot: false, createdAt: '2026-11-16T12:00:00Z', body: 'before' },
    { id: 2, author: 'james', bot: false, createdAt: '2026-11-16T12:05:00Z', body: 'first' },
    { id: 3, author: 'james', bot: false, createdAt: '2026-11-16T12:05:00Z', body: 'second' },
  ]
  /** @type {any[]} */
  const sent = []
  const deps = /** @type {any} */ ({
    config: { graft: { botLogin: null } },
    github: { comment: async (/** @type {any[]} */ ...a) => void sent.push(a) },
    log: () => {},
  })
  const ch = githubChannel(deps, SLUG, /** @type {any} */ ({ number: 9, comments }), {
    answerers: ['james'],
    ignored: [],
  })
  const s = /** @type {any} */ ({
    ...startOf({ issue: { repo: SLUG, number: 9, question: 'q', options: [] }, lens: 'technical', channel: 'github' })
      .input,
    lease: { holder: 'h', at: '2026-11-16T12:01:00Z', activeAt: '2026-11-16T12:01:00Z', idleMs: 1 },
  })
  assert.equal((await ch.poll(s))?.body, 'first')
  assert.equal(
    (await ch.poll({ ...s, cursor: { author: 'james', at: '2026-11-16T12:05:00Z', id: '2' } }))?.body,
    'second',
  )
  assert.equal(await ch.poll({ ...s, cursor: { author: 'james', at: '2026-11-16T12:05:00Z', id: '3' } }), null)

  const round = { round: { n: 1, questions: [{ id: 'a', title: 'A', text: 'A?', rec: 'yes' }] } }
  await ch.post(round, s)
  assert.equal(sent.length, 1)
  const again = githubChannel(
    deps,
    SLUG,
    /** @type {any} */ ({
      number: 9,
      comments: [...comments, { id: 4, author: 'bot', bot: true, createdAt: '', body: sent[0][2] }],
    }),
    { answerers: ['james'], ignored: [] },
  )
  await again.post(round, s)
  assert.equal(sent.length, 1, 'the same post after the same reply is not sent twice')
})

test('config: decide channels and the allowlist', () => {
  const base = { repos: [{ slug: SLUG, path: '/repo' }], engine: 'graph' }
  assert.deepEqual(resolveConfig(base).decide, { channel: null, answerers: {}, idleHours: 24 })
  assert.throws(
    () => resolveConfig({ ...base, decide: { channel: 'github' } }),
    /decide.answerers.github needs at least one login/,
  )
  assert.throws(
    () => resolveConfig({ ...base, decide: { channel: 'discord', answerers: { discord: ['x'] } } }),
    /must be "github" or null/,
  )
  assert.throws(() => resolveConfig({ ...base, engine: 'legacy', decide: DECIDE }), /needs engine "graph"/)
  const per = resolveConfig({
    ...base,
    decide: { answerers: { github: ['james'] } },
    repos: [{ slug: SLUG, path: '/repo', decide: { channel: 'github', answerers: { github: ['ana'] } } }],
  })
  assert.equal(per.decide.channel, null)
  assert.deepEqual(per.repos[0].decide, { channel: 'github', answerers: { github: ['ana'] }, idleHours: 24 })
  assert.equal(resolveConfig(base).phases.decide.cap, 1)
})
