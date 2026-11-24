// @ts-check
/** The Inbox reading pane's decide part (decide.mjs), rendered from fixtures of each status, and the lens facet. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePart, decideStatus } from '../src/decide.mjs'
import { facetsOf, inboxItems, viewOf } from '../src/inbox.mjs'
import { iso, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'
const COMMAND = `cd /src/mono && claude "/oakgreen:decide ${REPO}#7"`

/** cambium's queue-view `decide` summaries, one per status. */
const DECIDE = {
  none: {
    status: 'none',
    node: null,
    round: 0,
    holder: null,
    outcome: null,
    answerUrl: null,
    lens: 'product',
    at: null,
    error: null,
  },
  live: {
    status: 'leased',
    node: 'await-answers',
    round: 2,
    holder: 'james',
    outcome: null,
    answerUrl: null,
    lens: 'technical',
    at: iso(T0),
    error: null,
  },
  paused: {
    status: 'paused',
    node: 'confirm',
    round: 1,
    holder: 'james',
    outcome: null,
    answerUrl: null,
    lens: 'product',
    at: iso(T0),
    error: null,
  },
  committed: {
    status: 'done',
    node: null,
    round: 3,
    holder: 'james',
    outcome: 'answered',
    answerUrl: `https://github.com/${REPO}/issues/7#issuecomment-1`,
    lens: 'technical',
    at: iso(T0),
    error: null,
  },
}

/** A plain-object stand-in for the page's element builder. */
const h = (/** @type {string} */ tag, /** @type {any} */ attrs, /** @type {any[]} */ ...kids) => ({
  tag,
  attrs: Object.fromEntries(Object.entries(attrs ?? {}).filter(([, v]) => v != null)),
  kids: kids.flat(Number.POSITIVE_INFINITY).filter((k) => k != null && k !== false),
})
const link = (/** @type {string | null} */ url, /** @type {string} */ text) => h('a', { href: url }, text)
/** @returns {any[]} */
const all = (/** @type {any} */ n) => (typeof n === 'string' ? [] : [n, ...n.kids.flatMap(all)])
const text = (/** @type {any} */ n) => (typeof n === 'string' ? n : n.kids.map(text).join(''))
const render = (/** @type {any} */ decide) => decidePart({ decide, decideCommand: COMMAND }, h, link)
const status = (/** @type {any} */ part) => text(all(part).find((n) => n.attrs.class === 'decide-status'))
const copyOf = (/** @type {any} */ part) => all(part).find((n) => n.attrs['data-copy'])?.attrs['data-copy']

test('decidePart: every status shows the command with Copy and the lens', () => {
  for (const [name, d] of Object.entries(DECIDE)) {
    const part = render(d)
    assert.equal(copyOf(part), COMMAND, name)
    assert.ok(text(part).includes(COMMAND), name)
    assert.ok(text(part).includes(`lens: ${d.lens}`), name)
  }
})

test('decidePart: not started, live, paused and committed read as such', () => {
  assert.match(status(render(DECIDE.none)), /^Not started/)
  assert.equal(status(render(DECIDE.live)), 'Live · at await-answers · round 2 · held by james')
  assert.match(status(render(DECIDE.paused)), /^Paused · idle at confirm, round 1/)
  const done = render(DECIDE.committed)
  assert.equal(status(done), 'Committed · answered · the answer')
  assert.deepEqual(
    all(done)
      .filter((n) => n.tag === 'a')
      .map((n) => n.attrs.href),
    [DECIDE.committed.answerUrl],
  )
  assert.equal(all(render({ ...DECIDE.committed, answerUrl: null })).filter((n) => n.tag === 'a').length, 0)
  assert.match(status(render({ ...DECIDE.committed, outcome: 'abandoned' })), /^Abandoned/)
  assert.match(status(render({ ...DECIDE.live, error: 'agent timed out' })), /last turn failed: agent timed out/)
})

test('decideStatus: with no summary (queues read from GitHub) the status is unknown, not "not started"', () => {
  assert.equal(decideStatus(null).text, 'Status unknown')
  assert.equal(copyOf(render(undefined)), COMMAND)
})

/** @param {number} number @param {string[]} labels @param {any} [decide] */
const item = (number, labels, decide) => ({
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${REPO}/issues/${number}`,
  createdAt: iso(T0 - 86_400_000),
  updatedAt: iso(T0 - number * 60_000),
  labels,
  why: labels.find((l) => l.startsWith('why:'))?.slice(4) ?? null,
  priority: null,
  ...(decide ? { decide } : {}),
})

test('the lens facet: decide items carry lens:<value>; filtering keeps them; other items are tagged as before', () => {
  const plain = item(1, ['q:human', 'why:triage', 'bug'])
  const gh = {
    columns: {
      human: [
        plain,
        item(2, ['q:human', 'why:triage', 'ask:decide'], DECIDE.live),
        item(3, ['q:human', 'why:triage', 'ask:decide'], DECIDE.none),
      ],
    },
  }
  const xs = inboxItems(gh)
  assert.deepEqual(xs[0].tags, ['kind:human', 'why:triage', `repo:${REPO}`, 'label:bug'], 'no decide: tags unchanged')
  assert.ok(xs[1].tags.includes('lens:technical'))
  assert.ok(xs[2].tags.includes('lens:product'))
  const lens = facetsOf(xs, new Set()).find((f) => f.facet === 'lens')
  assert.deepEqual(
    lens?.tags.map((t) => `${t.value}:${t.n}`),
    ['product:1', 'technical:1'],
  )
  assert.deepEqual(
    viewOf(xs, { sort: 'newest', tags: new Set(['lens:technical']) }).map((i) => i.number),
    [2],
  )
})
