// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { judge, readHeartbeat } from '../src/heartbeat.mjs'
import { heartbeat, T0 } from './fixtures.mjs'

test('a fresh v1 heartbeat is ok and not stale', () => {
  const hb = judge(heartbeat(), { now: T0 + 10_000 })
  assert.equal(hb.status, 'ok')
  assert.equal(hb.stale, false)
  assert.equal(hb.ageMs, 10_000)
  assert.equal(hb.staleAfterMs, 90_000)
  assert.equal(hb.message, null)
  assert.equal(hb.data.mode, 'running')
  assert.equal(hb.data.workers[0].logs.stdout, '/tmp/logs/a2.out.log')
  assert.deepEqual(
    hb.data.steps.map((/** @type {any} */ s) => [s.name, s.ok]),
    [
      ['read', true],
      ['reconcile', false],
    ],
  )
})

test('stale after three ticks of tickSeconds', () => {
  assert.equal(judge(heartbeat(), { now: T0 + 90_000 }).stale, false)
  const hb = judge(heartbeat(), { now: T0 + 90_001 })
  assert.equal(hb.stale, true)
  assert.match(String(hb.message), /90s ago.*3 ticks of 30s/)
  const slow = judge(heartbeat({ daemon: { startedAt: null, tickSeconds: 60 } }), { now: T0 + 120_000 })
  assert.equal(slow.stale, false)
})

test('no finished tick counts as stale, not a crash', () => {
  const hb = judge(heartbeat({ tick: {} }), { now: T0 })
  assert.equal(hb.status, 'ok')
  assert.equal(hb.stale, true)
  assert.equal(hb.ageMs, null)
})

test('unknown version gives a clear message and no data', () => {
  for (const version of [2, undefined, '1']) {
    const hb = judge(heartbeat({ version }), { now: T0 })
    assert.equal(hb.status, 'unknown-version')
    assert.equal(hb.data, null)
    assert.match(String(hb.message), /not one canopy reads \(expects 1\)/)
  }
})

test('sparse v1 is filled in so the page never guards', () => {
  const hb = judge({ version: 1 }, { now: T0 })
  assert.equal(hb.status, 'ok')
  assert.deepEqual(hb.data.workers, [])
  assert.deepEqual(hb.data.events, [])
  assert.equal(hb.data.mode, 'unknown')
  assert.equal(hb.staleAfterMs, 90_000)
})

test('readHeartbeat: missing, not JSON, not an object, and ok from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-'))
  const missing = await readHeartbeat(join(dir, 'nope.json'))
  assert.equal(missing.status, 'missing')
  assert.match(String(missing.message), /no heartbeat at/)

  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"version":1,')
  assert.equal((await readHeartbeat(bad)).status, 'unreadable')

  const arr = join(dir, 'arr.json')
  writeFileSync(arr, '[]')
  assert.equal((await readHeartbeat(arr)).status, 'unreadable')

  const good = join(dir, 'state.json')
  writeFileSync(good, JSON.stringify(heartbeat()))
  const hb = await readHeartbeat(good, { now: T0 + 1000 })
  assert.equal(hb.status, 'ok')
  assert.equal(hb.path, good)
})

test('readHeartbeat: a read error other than ENOENT is unreadable', async () => {
  const hb = await readHeartbeat('/x', {
    read: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
  })
  assert.equal(hb.status, 'unreadable')
  assert.match(String(hb.message), /permission denied/)
})

const REPO = 'oakgreencc/monorepo'
const run = (/** @type {string} */ conclusion) => ({
  id: 7,
  url: `https://github.com/${REPO}/actions/runs/7`,
  sha: 'abcdef1234',
  conclusion,
  at: '2026-11-24T10:00:00Z',
})
/** @param {Record<string, unknown>} repo */
const withRepo = (repo) =>
  judge(heartbeat({ repos: [{ slug: REPO, ok: true, error: null, counts: null, ...repo }] }), { now: T0 }).data.repos[0]

test('watched workflows: green, red and unknown keep their run and watch issue', () => {
  const r = withRepo({
    watch: [
      {
        workflow: 'deploy.yml',
        branch: 'main',
        state: 'green',
        run: run('success'),
        issue: null,
        checkedAt: '2026-11-24T10:01:00Z',
        error: null,
      },
      {
        workflow: 'release.yml',
        branch: 'main',
        state: 'red',
        run: run('failure'),
        issue: 41,
        checkedAt: '2026-11-24T10:01:00Z',
        error: null,
      },
      {
        workflow: 'nightly.yml',
        branch: 'main',
        state: 'unknown',
        run: null,
        issue: null,
        checkedAt: null,
        error: null,
      },
    ],
  })
  assert.deepEqual(
    r.watch.map((/** @type {any} */ w) => [w.workflow, w.state, w.run?.url ?? null, w.issue]),
    [
      ['deploy.yml', 'green', `https://github.com/${REPO}/actions/runs/7`, null],
      ['release.yml', 'red', `https://github.com/${REPO}/actions/runs/7`, 41],
      ['nightly.yml', 'unknown', null, null],
    ],
  )
  assert.equal(r.watch[1].run.conclusion, 'failure')
})

test('a watch state canopy does not know reads as unknown; one without a workflow is dropped', () => {
  const r = withRepo({ watch: [{ workflow: 'x.yml', state: 'purple' }, { state: 'red' }, null] })
  assert.deepEqual(
    r.watch.map((/** @type {any} */ w) => [w.workflow, w.state, w.branch, w.run]),
    [['x.yml', 'unknown', null, null]],
  )
})

test('the GraphQL budget left and its reset come through', () => {
  const r = withRepo({ rateLimit: { cost: 3, remaining: 4120, resetAt: '2026-11-24T11:00:00Z' } })
  assert.deepEqual(r.rateLimit, { cost: 3, remaining: 4120, resetAt: '2026-11-24T11:00:00Z' })
  assert.equal(r.pausedUntil, null)
})

test('a repo paused for budget is marked paused, not just failed', () => {
  const r = withRepo({
    ok: false,
    error: 'GraphQL budget spent; reads paused until 2026-11-24T11:00:00.000Z',
    rateLimit: null,
  })
  assert.equal(r.pausedUntil, '2026-11-24T11:00:00.000Z')
  assert.equal(r.rateLimit, null)
  const failed = withRepo({ ok: false, error: 'HTTP 502' })
  assert.equal(failed.pausedUntil, null)
})

test('an older heartbeat without watch or rateLimit still reads: none watched, budget unknown', () => {
  const r = judge(heartbeat(), { now: T0 }).data.repos[0]
  assert.deepEqual(r.watch, [])
  assert.equal(r.rateLimit, null)
  assert.equal(r.pausedUntil, null)
})
