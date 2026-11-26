// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { brokerConfig, brokerPath, openBroker } from '../src/broker.mjs'
import { main } from '../src/cli.mjs'
import { withEnvFile } from '../src/envfile.mjs'
import * as entry from '../src/index.mjs'
import { createIntake } from '../src/intake.mjs'
import { pass } from '../src/runner.mjs'
import { discordConfig, discordSource, snowflakeAt } from '../src/sources/discord.mjs'
import { memoryState } from '../src/state.mjs'
import { createTracing } from '../src/telemetry.mjs'
import { fakeGithub } from './helpers.mjs'

const DECISIONS = '900000000000000010'
const INTAKE = '900000000000000001'
const GUILD = '900000000000000000'
const TOPIC = 'issue:oakgreencc/monorepo#183'
const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const env = {
  MYCELIUM_DISCORD_TOKEN: 'synthetic-bot-token',
  MYCELIUM_DISCORD_CHANNELS: `forum:${INTAKE}`,
  MYCELIUM_DISCORD_GUILD: GUILD,
  MYCELIUM_DECISIONS_CHANNEL: DECISIONS,
}
const config = /** @type {NonNullable<ReturnType<typeof brokerConfig>>} */ (brokerConfig(env))
const BOT = { id: '1', username: 'mycelium', bot: true }
const PERSON = { id: '2', username: 'alice_example' }

/** A Discord that keeps threads and messages, and honours `enforce_nonce`. */
function fakeDiscord() {
  let seq = BigInt(snowflakeAt(Date.parse('2026-11-26T12:00:00Z')))
  const next = () => {
    seq += 1n << 22n
    return String(seq)
  }
  /** @type {Map<string, { id: string, parent_id: string, name: string }>} */
  const threads = new Map()
  /** @type {Map<string, any[]>} */
  const messages = new Map()
  /** @type {Map<string, any>} */
  const nonces = new Map()
  /** @type {{ method: string, url: string, body: any }[]} */
  const calls = []
  /** @param {string} thread @param {any} author @param {string} content @param {number} [type] */
  const say = (thread, author, content, type = 0) => {
    const m = { id: next(), type, author, content, timestamp: new Date().toISOString(), channel_id: thread }
    messages.get(thread)?.push(m)
    return m
  }
  const json = (/** @type {unknown} */ b) => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(b),
  })
  /** @type {import('../src/http.mjs').Fetch} */
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, url, body })
    assert.equal(init.headers.Authorization, 'Bot synthetic-bot-token')
    const p = url.replace('https://discord.com/api/v10', '')
    let m = /^\/channels\/(\d+)\/threads$/.exec(p)
    if (m && init.method === 'POST') {
      const t = { id: next(), parent_id: m[1], name: body.name, type: body.type }
      threads.set(t.id, t)
      messages.set(t.id, [])
      return json(t)
    }
    m = /^\/channels\/(\d+)\/messages$/.exec(p)
    if (m && init.method === 'POST') {
      if (body.enforce_nonce && nonces.has(body.nonce)) return json(nonces.get(body.nonce))
      const msg = say(m[1], BOT, body.content)
      nonces.set(body.nonce, msg)
      return json(msg)
    }
    m = /^\/channels\/(\d+)\/messages\?after=(\d+)&limit=(\d+)$/.exec(p)
    if (m && init.method === 'GET')
      return json((messages.get(m[1]) ?? []).filter((x) => BigInt(x.id) > BigInt(m[2])).reverse())
    if (p === `/guilds/${GUILD}/threads/active`) return json({ threads: [...threads.values()] })
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(p)
    if (m) return json(messages.get(m[1])?.find((x) => x.id === m[2]) ?? null)
    throw new Error(`fakeDiscord: no route for ${init.method} ${url}`)
  }
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
  return { fetch, calls, threads, messages, say, posts }
}

const tmp = (/** @type {import('node:test').TestContext} */ t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mycelium-broker-'))
  t.after(() => rmSync(dir, { recursive: true }))
  return dir
}

test('put, drain, receive: one thread per topic in the decisions channel, reused; replies reach the inbox', async (t) => {
  const path = join(tmp(t), 'broker.db')
  const d = fakeDiscord()
  const b = openBroker({ path })
  t.after(() => b.close())
  const ports = { fetch: d.fetch, config }

  assert.deepEqual(b.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'Pick A or B?' }), {
    queued: true,
  })
  assert.deepEqual(await b.drain(ports), { sent: 1 })
  assert.equal(d.threads.size, 1)
  const [thread] = d.threads.values()
  assert.equal(thread.parent_id, DECISIONS)
  assert.equal(thread.name, 'oakgreencc/monorepo#183')
  assert.equal(d.posts()[0].url, `https://discord.com/api/v10/channels/${thread.id}/messages`)
  assert.deepEqual(d.posts()[0].body.allowed_mentions, { parse: [] })

  b.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-2', body: 'Still there?' })
  b.outbox.put({ service: 'canker', topic: TOPIC, key: 'ask-1', body: 'Also me' })
  assert.deepEqual(await b.drain(ports), { sent: 2 })
  assert.equal(d.threads.size, 1, 'the second and third posts reuse the thread')
  assert.equal(d.messages.get(thread.id)?.length, 3)

  const reply = d.say(thread.id, PERSON, 'B, please')
  assert.deepEqual(await b.receive(ports), { received: 2 })
  const got = b.inbox.after('cambium', TOPIC, 0)
  assert.equal(got.length, 1)
  assert.equal(got[0].messageId, reply.id)
  assert.equal(got[0].author, 'alice_example')
  assert.equal(got[0].authorId, '2')
  assert.equal(got[0].body, 'B, please')
  assert.equal(got[0].topic, TOPIC)
  assert.equal(got[0].at, reply.timestamp)
  assert.equal(b.inbox.after('canker', TOPIC, 0).length, 1)
  assert.deepEqual(b.inbox.after('cambium', TOPIC, got[0].cursor), [])
  assert.deepEqual(b.inbox.after('cambium', 'issue:o/r#1', 0), [])

  assert.deepEqual(await b.receive(ports), { received: 0 }, 'a reply is read once')
  d.say(thread.id, PERSON, 'and C')
  await b.receive(ports)
  assert.deepEqual(
    b.inbox.after('cambium', TOPIC, got[0].cursor).map((r) => r.body),
    ['and C'],
  )
})

test('restart: reopening the store and draining again posts nothing twice', async (t) => {
  const path = join(tmp(t), 'broker.db')
  const d = fakeDiscord()
  const ports = { fetch: d.fetch, config }
  const first = openBroker({ path })
  first.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'one' })
  first.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-2', body: 'two' })
  await first.drain(ports)
  first.close()

  const second = openBroker({ path })
  t.after(() => second.close())
  assert.deepEqual(await second.drain(ports), { sent: 0 })
  assert.equal(d.posts().length, 2)
  assert.equal(d.threads.size, 1)
  const [thread] = d.threads.values()
  d.say(thread.id, PERSON, 'ok')
  await second.receive(ports)
  second.close()
  const third = openBroker({ path })
  t.after(() => third.close())
  assert.deepEqual(await third.receive(ports), { received: 0 })
  assert.equal(third.inbox.after('cambium', TOPIC).length, 1)
})

test('a failed post stays queued and is retried; the nonce keeps a lost answer from posting twice', async (t) => {
  const d = fakeDiscord()
  const b = openBroker({ path: join(tmp(t), 'broker.db') })
  t.after(() => b.close())
  b.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'one' })
  let lose = true
  /** @type {import('../src/http.mjs').Fetch} */
  const flaky = async (url, init) => {
    const res = await d.fetch(url, init)
    if (lose && init.method === 'POST' && url.endsWith('/messages')) {
      lose = false
      return { status: 502, headers: { get: () => null }, text: async () => 'bad gateway' }
    }
    return res
  }
  await assert.rejects(b.drain({ fetch: flaky, config }), /502/)
  assert.deepEqual(await b.drain({ fetch: flaky, config }), { sent: 1 })
  const [thread] = d.threads.values()
  assert.equal(d.messages.get(thread.id)?.length, 1, 'Discord kept one message')
  assert.equal(d.posts()[0].body.nonce, d.posts()[1].body.nonce)
  assert.equal(d.posts()[0].body.enforce_nonce, true)
})

test('a put with a key the service already used is a no-op', async (t) => {
  const d = fakeDiscord()
  const b = openBroker({ path: join(tmp(t), 'broker.db') })
  t.after(() => b.close())
  const m = { service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'once' }
  assert.deepEqual(b.outbox.put(m), { queued: true })
  assert.deepEqual(b.outbox.put({ ...m, body: 'twice' }), { queued: false })
  await b.drain({ fetch: d.fetch, config })
  assert.deepEqual(b.outbox.put(m), { queued: false }, 'also once sent')
  assert.deepEqual(await b.drain({ fetch: d.fetch, config }), { sent: 0 })
  assert.deepEqual(
    d.posts().map((p) => p.body.content),
    ['once'],
  )
  assert.throws(() => b.outbox.put({ ...m, key: 'x', topic: 'general' }), /issue:<owner\/repo>#<n>/)
  assert.throws(() => b.outbox.put({ ...m, key: 'y', body: '' }), /body/)
})

test('bot-authored thread messages never reach the inbox or intake', async (t) => {
  const d = fakeDiscord()
  const b = openBroker({ path: join(tmp(t), 'broker.db') })
  t.after(() => b.close())
  const ports = { fetch: d.fetch, config }
  b.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'from the bot' })
  await b.drain(ports)
  const [thread] = d.threads.values()
  d.say(thread.id, { id: '3', username: 'other-bot', bot: true }, 'another bot')
  d.say(thread.id, PERSON, 'pinned', 6)
  assert.deepEqual(await b.receive(ports), { received: 0 })
  assert.deepEqual(b.inbox.after('cambium', TOPIC), [])

  // Intake reads its forum; the decisions thread (and the bot's post in it) is never filed.
  const gh = fakeGithub()
  const source = discordSource({ fetch: d.fetch, config: /** @type {any} */ (discordConfig(env)) })
  const tally = await pass(source, {
    intake: createIntake(gh.client),
    state: memoryState(),
    now: Date.now(),
    backfillMs: 3_600_000 * 24 * 365 * 20,
  })
  assert.equal(tally.created + tally.commented, 0)
  assert.equal(gh.state.issues.length, 0)
  assert.ok(!d.calls.some((c) => c.url.includes(`/channels/${thread.id}/messages/`)), 'no starter read')
})

test('config: the decisions channel cannot also be intake; settings come from forest.json and ~/.oakgreen/env', (t) => {
  const both = { ...env, MYCELIUM_DISCORD_CHANNELS: `123,forum:${DECISIONS}` }
  assert.throws(() => brokerConfig(both), /also in MYCELIUM_DISCORD_CHANNELS/)
  assert.throws(() => discordConfig(both), /decisions channel/)
  assert.throws(() => brokerConfig({ ...env, MYCELIUM_DECISIONS_CHANNEL: 'decisions' }), /snowflake/)
  assert.throws(() => brokerConfig({ MYCELIUM_DECISIONS_CHANNEL: DECISIONS }), /MYCELIUM_DISCORD_TOKEN/)
  assert.equal(brokerConfig({ MYCELIUM_DISCORD_TOKEN: 't' }), null)
  assert.equal(config.intervalMs, 30_000)

  const home = tmp(t)
  const forest = join(home, '.oakgreen', 'forest.json')
  const files = {
    [forest]: JSON.stringify({ mycelium: { decisionsChannel: DECISIONS, brokerIntervalS: 5 } }),
    [join(home, '.oakgreen', 'env')]: 'MYCELIUM_DISCORD_TOKEN=from-env-file\n',
  }
  const merged = withEnvFile({ HOME: home }, { home, read: (p) => files[p] ?? null, exists: () => false }).env
  assert.deepEqual(brokerConfig(merged), {
    token: 'from-env-file',
    channel: DECISIONS,
    guild: null,
    intervalMs: 5000,
  })
  assert.equal(brokerPath({ HOME: home }), join(home, '.oakgreen', 'mycelium', 'broker.db'))
  assert.equal(brokerPath({ HOME: home, MYCELIUM_BROKER_DB: '/x/b.db' }), '/x/b.db')
  assert.throws(
    () =>
      withEnvFile(
        { HOME: home },
        { home, read: (p) => (p === forest ? '{"mycelium":{"discordToken":"x"}}' : null), exists: () => false },
      ),
    /credential/,
  )
})

test('the store is SQLite in WAL mode at ~/.oakgreen/mycelium/broker.db; the package exports the client', (t) => {
  const home = tmp(t)
  const b = openBroker({ env: { HOME: home } })
  b.outbox.put({ service: 'cambium', topic: TOPIC, key: 'k', body: 'b' })
  assert.equal(b.path, join(home, '.oakgreen', 'mycelium', 'broker.db'))
  assert.ok(statSync(`${b.path}-wal`).isFile())
  b.close()
  assert.equal(typeof entry.outbox.put, 'function')
  assert.equal(typeof entry.inbox.after, 'function')
  assert.equal(entry.openBroker, openBroker)
})

test('spans for put, send and receive are children of the caller trace; logs carry direction, service, topic, key', async (t) => {
  const exporter = new InMemorySpanExporter()
  const tracing = await createTracing({ exporter })
  t.after(() => tracing.shutdown())
  /** @type {any[]} */
  const logs = []
  const d = fakeDiscord()
  const b = openBroker({ path: join(tmp(t), 'broker.db'), tracer: tracing.tracer, log: (r) => logs.push(r) })
  t.after(() => b.close())
  const ports = { fetch: d.fetch, config }
  b.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'q', traceparent: TP })
  await b.drain(ports)
  const [thread] = d.threads.values()
  const reply = d.say(thread.id, PERSON, 'a')
  await b.receive(ports)
  await tracing.flush()
  const spans = exporter.getFinishedSpans()
  const byName = Object.fromEntries(spans.map((s) => [s.name, s]))
  const put = byName['mycelium.broker.put']
  const send = byName['mycelium.broker.send']
  const receive = byName['mycelium.broker.receive']
  for (const s of [put, send, receive]) assert.equal(s.spanContext().traceId, '0af7651916cd43dd8448eb211c80319c')
  assert.equal(put.parentSpanContext?.spanId, 'b7ad6b7169203331')
  assert.equal(send.parentSpanContext?.spanId, put.spanContext().spanId)
  assert.equal(receive.parentSpanContext?.spanId, put.spanContext().spanId)
  assert.equal(send.attributes['mycelium.broker.topic'], TOPIC)
  assert.equal(send.attributes['mycelium.broker.key'], 'ask-1')
  assert.equal(receive.attributes['mycelium.broker.key'], `discord:${reply.id}`)
  const [got] = b.inbox.after('cambium', TOPIC)
  assert.equal(got.traceparent, `00-${receive.spanContext().traceId}-${receive.spanContext().spanId}-01`)

  const pick = (/** @type {any} */ l) => [l.direction, l.event, l.service, l.topic, l.key]
  assert.deepEqual(logs.filter((l) => !l.created).map(pick), [
    ['out', 'put', 'cambium', TOPIC, 'ask-1'],
    ['out', 'send', 'cambium', TOPIC, 'ask-1'],
    ['in', 'receive', 'cambium', TOPIC, `discord:${reply.id}`],
  ])
})

test('cli: `mycelium broker` runs one pass and logs each message; a decisions channel in intake is refused', async (t) => {
  const home = tmp(t)
  const d = fakeDiscord()
  const dbPath = join(home, 'broker.db')
  const seed = openBroker({ path: dbPath })
  seed.outbox.put({ service: 'cambium', topic: TOPIC, key: 'ask-1', body: 'q' })
  seed.close()
  const lines = /** @type {string[]} */ ([])
  const run = (/** @type {Record<string, string>} */ e) =>
    main(['broker'], { env: e, fetch: d.fetch, home, out: () => {}, err: (l) => lines.push(l) })
  assert.equal(await run({ ...env, MYCELIUM_BROKER_DB: dbPath }), 0)
  assert.equal(d.posts().length, 1)
  assert.equal(lines.at(-1), 'broker: 1 sent, 0 received')
  assert.ok(lines.some((l) => l.includes('"direction":"out"') && l.includes('"key":"ask-1"')))
  await assert.rejects(run({ ...env, MYCELIUM_DISCORD_CHANNELS: DECISIONS }), /decisions channel/)
})
