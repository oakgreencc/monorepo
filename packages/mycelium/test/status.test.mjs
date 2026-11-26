// @ts-check
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { createIntake } from '../src/intake.mjs'
import { runLoop } from '../src/runner.mjs'
import { defaultStatePath } from '../src/state.mjs'
import { createStatus, defaultStatusPath, targetOf } from '../src/status.mjs'
import { fakeFetch, fakeGithub, fixture } from './helpers.mjs'

const pem = /** @type {string} */ (
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })
)

test('status path: $MYCELIUM_STATUS, else ~/.oakgreen/mycelium/status.json', () => {
  assert.equal(defaultStatusPath({ MYCELIUM_STATUS: '/x/s.json' }, '/h'), '/x/s.json')
  assert.equal(defaultStatusPath({}, '/h'), '/h/.oakgreen/mycelium/status.json')
  assert.equal(defaultStatePath({}, '/h'), '/h/.oakgreen/mycelium/state.json')
  assert.equal(defaultStatePath({ MYCELIUM_STATE: '/x/c.json' }, '/h'), '/x/c.json')
})

test('targetOf: identifiers only, never a credential', () => {
  const env = {
    MYCELIUM_DISCORD_TOKEN: 'secret-token',
    MYCELIUM_DISCORD_CHANNELS: '111, forum:222,333',
    MYCELIUM_ASC_APP_ID: '1000000001',
    MYCELIUM_ASC_KEY_P8: pem,
    MYCELIUM_PLAY_PACKAGE: 'com.example.app',
    MYCELIUM_PLAY_KEY_JSON: '{"private_key":"pk"}',
    MYCELIUM_DEVICELOG_API: 'https://api.example.com/v3',
    MYCELIUM_DEVICELOG_PASSWORD: 'pw',
    MYCELIUM_DEVICELOG_CRASHES: 'true',
  }
  assert.equal(targetOf('discord', env), '2 channels, 1 forum')
  assert.equal(targetOf('asc', env), 'app 1000000001')
  assert.equal(targetOf('testflight', env), 'app 1000000001')
  assert.equal(targetOf('play', env), 'com.example.app')
  assert.equal(targetOf('vitals', env), 'com.example.app')
  assert.equal(targetOf('device-logs', env), 'prod · bug reports and crashes · api.example.com')
  assert.equal(targetOf('discord', {}), null)
})

test('runLoop reports each pass to the status: tallies, errors, the next due time, and a clean stop', async () => {
  let clock = Date.parse('2026-11-01T20:00:00Z')
  const writes = /** @type {any[]} */ ([])
  const status = createStatus({
    path: '/s.json',
    repo: 'o/r',
    now: () => clock,
    write: (_p, t) => writes.push(JSON.parse(t)),
    pid: 7,
    host: 'h',
    sources: [
      { name: 'good', configured: true, needs: null, target: 'app 1', intervalMs: 10_000 },
      { name: 'bad', configured: true, needs: null, target: null, intervalMs: 30_000 },
      { name: 'off', configured: false, needs: 'not configured; set X', target: null, intervalMs: null },
    ],
    notify: { channels: ['discord'], intervalMs: 20_000 },
  })
  assert.equal(writes[0].version, 1)
  assert.equal(writes[0].sources[2].nextAt, null)
  const stop = new AbortController()
  const src = (/** @type {string} */ name, /** @type {number} */ intervalMs, fail = false) => ({
    name,
    intervalMs,
    pull: async () => {
      clock += 5
      if (fail) throw new Error('boom')
      return []
    },
  })
  await runLoop([src('good', 10_000), src('bad', 30_000, true)], {
    intake: createIntake(fakeGithub().client),
    state: { get: () => null, set: () => {} },
    backfillMs: 0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      stop.abort()
    },
    signal: stop.signal,
    jobs: [{ name: 'notify', intervalMs: 20_000, run: async () => 'notify: 0 acknowledged' }],
    observe: (r) => status.pass(r),
  })
  status.stop()
  const last = writes.at(-1)
  const [good, bad] = last.sources
  assert.deepEqual({ ok: good.last.ok, created: good.last.created, ms: good.last.ms }, { ok: true, created: 0, ms: 5 })
  assert.equal(bad.last.ok, false)
  assert.equal(bad.last.error, 'boom')
  assert.equal(last.notify.last.message, 'notify: 0 acknowledged')
  assert.ok(last.stoppedAt)
  assert.equal(good.nextAt, null, 'nothing is due once stopped')
  const beforeStop = writes.at(-2)
  assert.equal(Date.parse(beforeStop.notify.nextAt) - Date.parse(beforeStop.notify.last.at), 20_000)
})

test('run writes the status file: every source listed, configured or not, and no secret in it', async () => {
  const env = {
    MYCELIUM_ASC_KEY_ID: 'KEYID',
    MYCELIUM_ASC_ISSUER_ID: 'ISSUER',
    MYCELIUM_ASC_KEY_P8: pem,
    MYCELIUM_ASC_APP_ID: '1000000001',
    MYCELIUM_REPO: 'o/r',
  }
  const pages = fixture('asc-reviews.json')
  const stop = new AbortController()
  const texts = /** @type {string[]} */ ([])
  const code = await main(['run'], {
    env,
    home: '/home/u',
    github: fakeGithub().client,
    fetch: fakeFetch((url) => (url.includes('cursor=PAGE2') ? pages.page2 : pages.page1)).fetch,
    signal: stop.signal,
    sleep: async () => stop.abort(),
    out: () => {},
    err: () => {},
    writeStatus: (p, t) => {
      assert.equal(p, '/home/u/.oakgreen/mycelium/status.json')
      texts.push(t)
    },
  })
  assert.equal(code, 0)
  const doc = JSON.parse(/** @type {string} */ (texts.at(-1)))
  assert.deepEqual(
    doc.sources.map((/** @type {any} */ s) => [s.name, s.configured]),
    [
      ['discord', false],
      ['asc', true],
      ['testflight', true],
      ['play', false],
      ['vitals', false],
      ['device-logs', false],
    ],
  )
  const asc = doc.sources[1]
  assert.equal(asc.target, 'app 1000000001')
  assert.equal(asc.intervalMs, 15 * 60_000)
  assert.equal(asc.last.ok, true)
  assert.match(doc.sources[0].needs, /MYCELIUM_DISCORD_TOKEN/)
  assert.equal(doc.repo, 'o/r')
  assert.equal(doc.notify, null)
  assert.ok(doc.stoppedAt)
  for (const t of texts) {
    assert.doesNotMatch(t, /PRIVATE KEY|KEYID|ISSUER/)
  }
})

test('run --dry-run writes no status file', async () => {
  const env = {
    MYCELIUM_ASC_KEY_ID: 'K',
    MYCELIUM_ASC_ISSUER_ID: 'I',
    MYCELIUM_ASC_KEY_P8: pem,
    MYCELIUM_ASC_APP_ID: '1',
  }
  const stop = new AbortController()
  let wrote = false
  await main(['run', '--dry-run'], {
    env,
    fetch: fakeFetch(() => ({ data: [] })).fetch,
    signal: stop.signal,
    sleep: async () => stop.abort(),
    out: () => {},
    err: () => {},
    writeStatus: () => {
      wrote = true
    },
  })
  assert.equal(wrote, false)
})
