// @ts-check
/**
 * Adoption (adopt.mjs): an open issue filed without a queue label is labelled `q:intake` and triaged, not ignored.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.mjs'
import { normalize, unqueuedSearch } from '../src/github.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

/** @param {{ issues?: any[], prs?: any[], config?: any }} [o] */
const graph = ({ issues = [], prs = [], config = {} } = {}) =>
  harness({
    issues,
    prs,
    config: { engine: 'graph', phases: { dispatch: { cap: 1 }, task: { cap: 0 } }, ...config },
  })

test('an issue filed without a queue label is adopted into q:intake and triaged the same tick', async () => {
  const h = graph({ issues: [{ number: 7, labels: ['bug'] }] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels.sort(), ['bug', 'q:intake', 'running'])
  assert.deepEqual(
    h.spawner.started.map((s) => s.issue),
    [7],
  )
  assert.ok(h.events.some((e) => e.issue === 7 && /adopted into q:intake/.test(e.msg)))
})

test('on the legacy engine too: adopted, so it waits in q:intake where people and canopy see it', async () => {
  const h = harness({ issues: [{ number: 7, labels: [] }] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, ['q:intake'])
})

test('left alone: cambium has handled it, a PR names it, cambium filed it, or a label says to ignore it', async () => {
  const marker = { id: 1, body: renderMarker(newMarker({ phase: 'task' })) }
  const h = graph({
    config: { intake: { ignoreLabels: ['release-area'] } },
    issues: [
      { number: 1, labels: [], comment: marker },
      { number: 2, labels: [] },
      { number: 3, labels: [] },
      { number: 4, labels: ['watch'] },
      { number: 5, labels: ['red-base'] },
      { number: 6, labels: ['rescue'] },
      { number: 7, labels: ['release-area'] },
      { number: 8, labels: [], state: 'CLOSED' },
    ],
    prs: [
      { number: 50, closes: [2] },
      { number: 51, closes: [], branch: 'agent/3-fix', state: 'MERGED' },
    ],
  })
  await tick(h.deps)
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'label').map((c) => c.args[1]),
    [],
  )
  assert.equal(h.spawner.started.length, 0)
})

test('intake.adopt false: an issue in no queue stays there', async () => {
  const h = graph({ config: { intake: { adopt: false } }, issues: [{ number: 7, labels: [] }] })
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, [])
  assert.equal(h.spawner.started.length, 0)
})

test('a paused cambium adopts nothing', async () => {
  const h = graph({ issues: [{ number: 7, labels: [] }] })
  h.deps.store.setMode('paused')
  await tick(h.deps)
  assert.deepEqual(h.gh.issue(7).labels, [])
})

test('the search: open issues of the repo in no queue and without a lease, minus ignored labels, oldest first', () => {
  assert.equal(
    unqueuedSearch('o/r', ['release-area']),
    'repo:o/r is:issue is:open -label:"q:intake" -label:"q:task" -label:"q:human" -label:"q:promote" -label:"running" -label:"release-area" sort:created-asc',
  )
})

test('normalize: the search answer becomes `unqueued`, without the issues the snapshot already holds', () => {
  const node = (/** @type {number} */ n, /** @type {string[]} */ labels) => ({
    number: n,
    state: 'OPEN',
    createdAt: '2026-11-24T00:00:00Z',
    labels: { nodes: labels.map((name) => ({ name })) },
  })
  const snap = normalize({
    repository: {
      issues: { nodes: [node(1, ['q:task'])] },
      unqueued: { nodes: [node(1, ['q:task']), node(2, ['bug']), {}] },
    },
  })
  assert.deepEqual(
    snap.unqueued?.map((i) => [i.number, i.labels]),
    [[2, ['bug']]],
  )
  assert.equal(normalize({ repository: {} }).unqueued, undefined, 'not asked: absent')
})

test('config: intake defaults on, and is checked', () => {
  const base = { repos: [{ slug: SLUG, path: '/r' }] }
  assert.deepEqual(resolveConfig(base).intake, { adopt: true, ignoreLabels: [] })
  assert.throws(() => resolveConfig({ ...base, intake: { adopt: 'yes' } }), /intake.adopt/)
  assert.throws(() => resolveConfig({ ...base, intake: { ignoreLabels: 'x' } }), /intake.ignoreLabels/)
})
