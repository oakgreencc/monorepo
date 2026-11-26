// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveSettings } from '../src/config.mjs'
import { intakeActivity, judgeIntake, readIntake } from '../src/intake.mjs'
import { PAGE } from '../src/page.mjs'
import { buildState } from '../src/server.mjs'
import { emptyColumns } from '../src/queues.mjs'
import { heartbeat, iso, T0 } from './fixtures.mjs'

const M = 60_000
const doc = (over = {}) => ({
  version: 1,
  pid: 9,
  host: 'h',
  repo: 'o/r',
  startedAt: iso(T0 - 60 * M),
  updatedAt: iso(T0 - M),
  stoppedAt: null,
  sources: [
    {
      name: 'discord',
      configured: true,
      needs: null,
      target: '1 channel',
      intervalMs: M,
      last: { at: iso(T0 - M), ms: 5, ok: true, created: 1, commented: 0, skipped: 0 },
      nextAt: iso(T0),
    },
    {
      name: 'asc',
      configured: true,
      needs: null,
      target: 'app 1',
      intervalMs: 15 * M,
      last: { at: iso(T0 - M), ms: 5, ok: false, error: 'asc: 401' },
      nextAt: iso(T0 + 14 * M),
    },
    { name: 'vitals', configured: true, needs: null, target: 'com.x', intervalMs: 60 * M, last: null, nextAt: iso(T0) },
    {
      name: 'play',
      configured: false,
      needs: 'not configured; set MYCELIUM_PLAY_PACKAGE',
      target: null,
      intervalMs: null,
      last: null,
      nextAt: null,
    },
  ],
  notify: null,
  ...over,
})

test('judgeIntake: each source gets a state; a running mycelium has no message', () => {
  const j = judgeIntake(doc(), { path: '/s', now: T0 })
  assert.equal(j.status, 'ok')
  assert.equal(j.running, true)
  assert.equal(j.message, null)
  assert.deepEqual(
    j.data.sources.map((/** @type {any} */ s) => [s.name, s.state]),
    [
      ['discord', 'ok'],
      ['asc', 'failing'],
      ['vitals', 'waiting'],
      ['play', 'off'],
    ],
  )
})

test('judgeIntake: late past the grace is overdue; all overdue is a quiet mycelium; stoppedAt is stopped', () => {
  const late = judgeIntake(doc(), { now: T0 + 3 * M })
  assert.equal(late.data.sources[0].state, 'overdue', 'one minute interval, two minute grace')
  assert.equal(late.data.sources[2].state, 'waiting', 'an hour interval is its own grace')
  const quiet = judgeIntake(doc(), { now: T0 + 5 * 60 * M })
  assert.equal(quiet.running, false)
  assert.match(String(quiet.message), /oakgreen services/)
  const stopped = judgeIntake(doc({ stoppedAt: iso(T0) }), { now: T0 })
  assert.equal(stopped.running, false)
  assert.equal(stopped.data.sources[0].state, 'stopped')
  assert.match(String(stopped.message), /oakgreen start mycelium/)
})

test('readIntake: missing, not JSON, another version', async () => {
  const missing = await readIntake('/nope/status.json')
  assert.equal(missing.status, 'missing')
  const dir = mkdtempSync(join(tmpdir(), 'canopy-intake-'))
  writeFileSync(join(dir, 'bad.json'), '{')
  assert.equal((await readIntake(join(dir, 'bad.json'))).status, 'unreadable')
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({ version: 2 }))
  const v2 = await readIntake(join(dir, 'v2.json'))
  assert.equal(v2.status, 'unknown-version')
  assert.equal(v2.data, null)
})

/** @param {string} source @param {string} action @param {number} end @param {boolean} [failed] */
const span = (source, action, end, failed = false) => ({
  traceId: `t-${source}-${end}`,
  spanId: 's',
  parentSpanId: null,
  name: 'mycelium.intake',
  service: 'mycelium',
  start: end - 10,
  end,
  status: failed ? 'error' : 'ok',
  statusMessage: null,
  attrs: {
    'mycelium.source': source,
    'mycelium.action': action,
    'mycelium.issue.number': 7,
    'mycelium.external_id': 'x',
  },
  events: [],
})

test('intakeActivity: per source opened, commented and failed over a day and a week; newest filings first', () => {
  const traces = new Map(
    [
      span('discord', 'create', T0 - M),
      span('discord', 'comment', T0 - 2 * M),
      span('discord', 'create', T0 - 3 * 24 * 60 * M),
      span('asc', 'create', T0 - 10 * M, true),
    ].map((s) => [s.traceId, /** @type {any} */ ([s])]),
  )
  traces.set('other', /** @type {any} */ ([{ ...span('x', 'create', T0), name: 'cambium.node' }]))
  const a = intakeActivity(traces, T0)
  assert.deepEqual(a.bySource.discord.day, { created: 1, commented: 1, failed: 0 })
  assert.deepEqual(a.bySource.discord.week, { created: 2, commented: 1, failed: 0 })
  assert.deepEqual(a.bySource.asc.day, { created: 0, commented: 0, failed: 1 })
  assert.equal(a.recent[0].source, 'discord')
  assert.equal(a.recent.length, 4, 'only mycelium.intake spans')
  assert.equal(a.recent.find((f) => f.source === 'asc')?.failed, true)
})

test('settings: --intake, else $MYCELIUM_STATUS, else ~/.oakgreen/mycelium/status.json', () => {
  const read = () => {
    throw Object.assign(new Error('x'), { code: 'ENOENT' })
  }
  assert.equal(resolveSettings({}, { env: {}, home: '/h', read }).intakePath, '/h/.oakgreen/mycelium/status.json')
  assert.equal(resolveSettings({}, { env: { MYCELIUM_STATUS: '/s.json' }, home: '/h', read }).intakePath, '/s.json')
  assert.equal(
    resolveSettings({ intake: '/f.json' }, { env: { MYCELIUM_STATUS: '/s.json' }, home: '/h', read }).intakePath,
    '/f.json',
  )
})

test('/api/state carries intake with its activity; the page has the Intake tab', async () => {
  const s = await buildState({
    statePath: '/hb',
    repos: ['o/r'],
    readHeartbeat: async () => /** @type {any} */ ({ status: 'ok', data: heartbeat(), stale: false }),
    queues: {
      get: async () => ({ repos: [], columns: emptyColumns(), prs: [], stranded: [], fetchedAt: null, cached: false }),
    },
    now: () => T0,
    intakePath: '/status.json',
    readIntake: async (p, { now }) => judgeIntake(doc(), { path: p, now }),
    traces: {
      read: async () =>
        /** @type {any} */ ({
          status: 'ok',
          path: '/t',
          message: null,
          files: 1,
          malformed: 0,
          traces: new Map([['a', [span('discord', 'create', T0 - M)]]]),
        }),
    },
  })
  assert.equal(s.intake?.status, 'ok')
  assert.equal(s.intake?.activity?.bySource.discord.day.created, 1)
  assert.match(PAGE, /id="tab-intake"/)
})
