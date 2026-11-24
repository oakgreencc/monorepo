// @ts-check
/** The queue view canopy reads (queue-view.mjs): built each tick from the snapshots, written atomically. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { END } from '../src/graph/index.mjs'
import { normalize } from '../src/github.mjs'
import { markerAt, renderDecideMarker } from '../src/graphs/decide.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { boardOf, QUEUES_VERSION, queueView, writeQueues } from '../src/queue-view.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

/** @param {ReturnType<typeof harness>} h */
function recordQueues(h) {
  /** @type {import('../src/queue-view.mjs').QueuesFile[]} */
  const written = []
  h.deps.queues = { write: (v) => void written.push(structuredClone(v)), prev: () => written.at(-1) ?? null }
  return written
}

test('a tick writes the queue view, and it matches the snapshot cambium read', async () => {
  const h = harness({
    issues: [
      { number: 1, labels: ['q:intake'] },
      { number: 2, labels: ['q:intake', 'wait:deferred'] },
      { number: 3, labels: ['q:human', 'why:budget', 'priority:high'] },
      { number: 4, labels: ['q:promote'], state: 'CLOSED' },
    ],
  })
  h.deps.store.setMode('paused')
  const written = recordQueues(h)
  const s = await tick(h.deps)
  assert.equal(written.length, 1)
  const [view] = written
  assert.equal(view.version, QUEUES_VERSION)
  assert.equal(view.writtenAt, new Date(h.clock.now()).toISOString())
  assert.equal(view.tickSeconds, 30)
  const snap = await h.gh.github.read(SLUG)
  assert.deepEqual(view.repos, [
    { slug: SLUG, ok: true, error: null, fetchedAt: view.writtenAt, ...structuredClone(boardOf(SLUG, snap)) },
  ])
  const cols = view.repos[0].columns
  assert.deepEqual(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((i) => i.number)])), {
    intake: [1],
    waiting: [2],
    task: [],
    running: [],
    human: [3],
    promote: [],
  })
  assert.equal(cols.human[0].why, 'budget')
  assert.equal(cols.human[0].priority, 'high')
  assert.deepEqual(cols.waiting[0].wait, { kind: 'deferred', reason: null, until: null, blockers: [] })
  assert.ok(
    s.steps.some((x) => x.name === 'queues' && x.ok),
    'the write is a step the heartbeat lists',
  )
})

test('a repo not read this tick keeps its last board, marked not ok', async () => {
  const h = harness({ issues: [{ number: 1, labels: ['q:intake'] }] })
  h.deps.store.setMode('paused')
  const written = recordQueues(h)
  await tick(h.deps)
  h.gh.faults.readError = new Error('boom')
  h.clock.advance(30_000)
  await tick(h.deps).catch(() => {})
  const [first, second] = written
  assert.equal(second.repos[0].ok, false)
  assert.match(String(second.repos[0].error), /boom/)
  assert.equal(second.repos[0].fetchedAt, first.repos[0].fetchedAt, 'the board is the one last read')
  assert.deepEqual(second.repos[0].columns, first.repos[0].columns)
  assert.notEqual(second.writtenAt, first.writtenAt)
})

test('queueView: with nothing to keep, an unread repo has an empty board', () => {
  const v = queueView({ repos: [SLUG], snaps: new Map(), readErrors: new Map(), now: 0, tickSeconds: 30 })
  assert.deepEqual(v.repos[0], {
    slug: SLUG,
    ok: false,
    error: 'not read this tick',
    fetchedAt: null,
    columns: { intake: [], waiting: [], task: [], running: [], human: [], promote: [] },
    prs: [],
    stranded: [],
  })
})

test('boardOf: blockers, awaiting promotion, PR detail and stranded issues from the GraphQL answer', () => {
  const issue = (/** @type {number} */ number, /** @type {string[]} */ labels, extra = {}) => ({
    number,
    title: `I${number}`,
    url: `u/${number}`,
    state: 'OPEN',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    body: '',
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: [] },
    ...extra,
  })
  const repository = {
    issues: {
      nodes: [
        issue(1, ['q:intake', 'wait:blocked'], {
          blockedBy: {
            nodes: [
              { number: 9, title: 'Blocker', url: 'u/9', state: 'OPEN', closedAt: null },
              { number: 8, title: 'Done', url: 'u/8', state: 'CLOSED', closedAt: '2026-11-01T00:00:00Z' },
            ],
          },
        }),
        issue(2, ['q:task', 'running']),
      ],
    },
    awaiting: { nodes: [issue(3, ['q:promote'], { state: 'CLOSED' })] },
    open: {
      nodes: [
        {
          number: 20,
          url: 'p/20',
          title: 'Fix it',
          headRefName: 'agent/2-fix',
          state: 'OPEN',
          isDraft: true,
          isInMergeQueue: true,
          mergeQueueEntry: { position: 2, state: 'QUEUED' },
          mergeStateStatus: 'BLOCKED',
          additions: 5,
          deletions: 1,
          changedFiles: 2,
          autoMergeRequest: { enabledAt: 'x' },
          closingIssuesReferences: { nodes: [{ number: 2 }] },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: 'PENDING',
                    contexts: {
                      checkRunCountsByState: [
                        { state: 'SUCCESS', count: 3 },
                        { state: 'IN_PROGRESS', count: 1 },
                      ],
                      statusContextCountsByState: [{ state: 'FAILURE', count: 1 }],
                      nodes: [],
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
    stranding: {
      nodes: [
        {
          number: 30,
          title: 'Gave up',
          url: 'p/30',
          headRefName: 'agent/5-x',
          closedAt: '2026-11-03T00:00:00Z',
          closingIssuesReferences: {
            nodes: [
              { number: 5, title: 'Left', url: 'u/5', state: 'OPEN', createdAt: 'c', updatedAt: 'd' },
              { number: 2, title: 'Covered', url: 'u/2', state: 'OPEN', createdAt: 'c', updatedAt: 'd' },
            ],
          },
        },
        { number: 31, title: 'Not an agent', url: 'p/31', headRefName: 'me/x', closingIssuesReferences: { nodes: [] } },
      ],
    },
  }
  const b = boardOf(SLUG, normalize({ repository }, { release: { from: 'main', to: 'stable' } }))
  assert.deepEqual(b.columns.waiting[0].wait, {
    kind: 'blocked',
    reason: null,
    until: null,
    blockers: [{ number: 9, title: 'Blocker', url: 'u/9' }],
  })
  assert.deepEqual(
    b.columns.running.map((i) => i.number),
    [2],
  )
  assert.deepEqual(
    b.columns.promote.map((i) => i.number),
    [3],
  )
  assert.equal(b.columns.promote[0].updatedAt, '2026-11-02T00:00:00Z')
  assert.deepEqual(b.prs, [
    {
      repo: SLUG,
      number: 20,
      title: 'Fix it',
      url: 'p/20',
      branch: 'agent/2-fix',
      draft: true,
      checks: 'PENDING',
      tally: { passed: 3, failed: 1, pending: 1 },
      inMergeQueue: true,
      autoMerge: true,
      queue: { position: 2, state: 'QUEUED' },
      mergeState: 'BLOCKED',
      additions: 5,
      deletions: 1,
      files: 2,
      closes: [2],
      createdAt: null,
      updatedAt: null,
    },
  ])
  assert.deepEqual(
    b.stranded.map((s) => [s.number, s.pr.number]),
    [[5, 30]],
    'only the open issue no open PR covers',
  )
})

test('writeQueues: atomic, leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-queues-'))
  const path = join(dir, 'nested', 'queues.json')
  const v = queueView({ repos: [SLUG], snaps: new Map(), readErrors: new Map(), now: 0, tickSeconds: 30 })
  writeQueues(path, v)
  writeQueues(path, { ...v, tickSeconds: 60 })
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['queues.json'])
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tickSeconds, 60)
})

test('boardOf: an ask:decide item carries its decide summary from the marker; no marker reads as not started', () => {
  const seed = {
    issue: { repo: SLUG, number: 7, question: 'Which?', options: [] },
    lens: /** @type {const} */ ('technical'),
    channel: 'github',
  }
  const T = Date.parse('2026-11-20T00:00:00Z')
  const leased = markerAt(
    {
      node: 'await-answers',
      input: {
        ...seed,
        lease: { holder: 'james', at: 'x', activeAt: 'x', idleMs: 1 },
        rounds: [
          { n: 1, questions: [{ id: 'q1', title: 'T', text: 'Q', rec: 'yes' }], answers: [] },
          { n: 2, questions: [{ id: 'q2', title: 'T', text: 'Q', rec: 'yes' }], answers: [] },
        ],
      },
    },
    { now: () => T },
  )
  const paused = markerAt({ node: 'paused', input: { ...seed, paused: 'confirm' } }, { now: () => T })
  const done = markerAt({ node: END, input: { ...seed, answerUrl: 'https://x/a' } }, { now: () => T })
  const node = (/** @type {number} */ number, /** @type {string[]} */ labels, /** @type {string[]} */ bodies) => ({
    number,
    title: `I${number}`,
    url: `u/${number}`,
    state: 'OPEN',
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: bodies.map((body, k) => ({ databaseId: number * 10 + k, body, author: { login: 'cambium' } })) },
  })
  const ask = { ...newMarker(), ask: { kind: 'decide', question: 'Q', interactive: true, lens: 'product' } }
  const snap = normalize(
    {
      repository: {
        issues: {
          nodes: [
            node(1, ['q:human', 'ask:decide', 'ask:session'], [renderMarker(/** @type {any} */ (ask))]),
            node(2, ['q:human', 'ask:decide', 'ask:session'], [renderDecideMarker(leased)]),
            node(3, ['q:human', 'ask:decide'], [renderDecideMarker(done)]),
            node(4, ['q:human', 'why:budget'], []),
            node(5, ['q:human', 'ask:decide', 'ask:session'], [renderDecideMarker(paused)]),
          ],
        },
      },
    },
    { botLogin: 'cambium' },
  )
  const human = boardOf(SLUG, snap).columns.human
  const by = Object.fromEntries(human.map((i) => [i.number, i.decide]))
  assert.deepEqual(by[1], {
    status: 'none',
    node: null,
    round: 0,
    holder: null,
    outcome: null,
    answerUrl: null,
    lens: 'product',
    at: null,
    error: null,
  })
  assert.deepEqual(by[2], {
    status: 'leased',
    node: 'await-answers',
    round: 2,
    holder: 'james',
    outcome: null,
    answerUrl: null,
    lens: 'technical',
    at: new Date(T).toISOString(),
    error: null,
  })
  assert.equal(by[3]?.status, 'done')
  assert.equal(by[3]?.outcome, 'answered')
  assert.equal(by[3]?.answerUrl, 'https://x/a')
  assert.equal(by[3]?.node, null)
  assert.deepEqual([by[5]?.status, by[5]?.node], ['paused', 'confirm'], 'paused: the wait it left')
  assert.equal(by[4], undefined, 'no ask:decide and no marker: no decide field')
  assert.equal('decide' in human.find((i) => i.number === 4), false)
})
