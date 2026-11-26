// @ts-check
/**
 * The Discord broker: mycelium is the one Discord client of the stack. Local services put messages in an outbox and
 * read replies from an inbox, both in one SQLite file (`~/.oakgreen/mycelium/broker.db`, WAL). mycelium's run loop
 * drains the outbox to Discord and reads replies back.
 *
 * A topic `issue:<owner/repo>#<n>` is one thread in the decisions channel, created on its first post. A reply by a
 * person (never a bot) lands in the inbox once for every service that has posted to that topic.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { withEnvFile } from './envfile.mjs'
import { serviceDir } from './forest.mjs'
import { requestJson } from './http.mjs'
import { DISCORD_API, USER_AGENT } from './sources/discord.mjs'
import { formatTraceparent, NO_TRACING, spanContextOf } from './telemetry.mjs'

export const BROKER_INTERVAL_MS = 30_000
export const TOPIC = /^issue:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/
const CONTENT_MAX = 2000
const PAGE = 100
const MAX_PAGES = 10
/** Default and reply messages; joins, pins and thread notices are not replies. */
const REPLY_TYPES = new Set([0, 19])

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ direction: 'out' | 'in', event: 'put' | 'send' | 'receive', service: string, topic: string,
 *   key: string, [k: string]: unknown }} BrokerLog
 * @typedef {{ service: string, topic: string, key: string, body: string, traceparent?: string | null }} Message
 * @typedef {{ cursor: number, service: string, topic: string, messageId: string, author: string,
 *   authorId: string | null, body: string, at: string, traceparent: string | null }} Reply
 */

/** `$MYCELIUM_BROKER_DB`, else `~/.oakgreen/mycelium/broker.db`. @param {Env} [env] @param {string} [home] */
export const brokerPath = (env = process.env, home = undefined) =>
  env.MYCELIUM_BROKER_DB || join(serviceDir('mycelium', { env, home }), 'broker.db')

const snowflake = (/** @type {string} */ s) => /^\d+$/.test(s)
const later = (/** @type {string} */ a, /** @type {string} */ b) => BigInt(a) > BigInt(b)

/**
 * The broker's Discord side, or null when no decisions channel is set. Throws when the token is missing, the channel
 * is not a snowflake, or the decisions channel is also an intake channel: its threads would be filed as intents.
 * @param {Env} env
 */
export function brokerConfig(env = process.env) {
  const channel = String(env.MYCELIUM_DECISIONS_CHANNEL ?? '').trim()
  if (!channel) return null
  if (!snowflake(channel)) throw new Error(`broker: decisions channel '${channel}' is not a snowflake`)
  const intake = String(env.MYCELIUM_DISCORD_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^forum:/, ''))
  if (intake.includes(channel))
    throw new Error(`broker: decisions channel ${channel} is also in MYCELIUM_DISCORD_CHANNELS; take it out of intake`)
  const token = env.MYCELIUM_DISCORD_TOKEN ?? ''
  if (!token) throw new Error('broker: MYCELIUM_DISCORD_TOKEN is not set')
  const interval = Number(env.MYCELIUM_BROKER_INTERVAL_S)
  return {
    token,
    channel,
    guild: env.MYCELIUM_DISCORD_GUILD || null,
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : BROKER_INTERVAL_MS,
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  traceparent TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  UNIQUE (service, key)
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (sent_at, id);
CREATE TABLE IF NOT EXISTS threads (
  topic TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  read_after TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  topic TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  at TEXT NOT NULL,
  traceparent TEXT,
  UNIQUE (service, message_id)
);
CREATE INDEX IF NOT EXISTS inbox_read ON inbox (service, topic, id);
`

/** A span under `traceparent` when it is valid, else a root. @param {import('@opentelemetry/api').Tracer} tracer */
function spanUnder(tracer, /** @type {string} */ name, /** @type {string | null | undefined} */ traceparent, attrs) {
  const parent = spanContextOf(traceparent)
  const ctx = parent ? trace.setSpanContext(context.active(), parent) : context.active()
  return tracer.startSpan(
    name,
    { kind: name.endsWith('receive') ? SpanKind.CONSUMER : SpanKind.PRODUCER, root: !parent, attributes: attrs },
    ctx,
  )
}

/** @param {import('@opentelemetry/api').Span} span @param {unknown} err */
function failed(span, err) {
  span.recordException(/** @type {Error} */ (err))
  span.setStatus({ code: SpanStatusCode.ERROR, message: /** @type {Error} */ (err).message })
}

/**
 * Open (creating) the store. The client side: `outbox.put` and `inbox.after`. `drain` and `receive` are mycelium's.
 *
 * @param {{
 *   path?: string,
 *   env?: Env,
 *   home?: string,
 *   tracer?: import('@opentelemetry/api').Tracer,
 *   log?: (record: BrokerLog) => void,
 *   now?: () => number,
 * }} [opts]
 */
export function openBroker({ path, env = process.env, home, tracer = NO_TRACING.tracer, log = () => {}, now } = {}) {
  const file = path ?? brokerPath(env, home)
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  // Loaded here, not imported: intake-only commands never load (or warn about) node:sqlite.
  const { DatabaseSync } = /** @type {typeof import('node:sqlite')} */ (process.getBuiltinModule('node:sqlite'))
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  let open = true
  const iso = () => new Date(now ? now() : Date.now()).toISOString()

  const insertOut = db.prepare(
    `INSERT INTO outbox (service, topic, key, body, traceparent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (service, key) DO NOTHING`,
  )
  const afterIn = db.prepare('SELECT * FROM inbox WHERE service = ? AND topic = ? AND id > ? ORDER BY id LIMIT ?')

  const outbox = {
    /**
     * Queue one message. A key the service already used is a no-op: `{ queued: false }`.
     * @param {Message} m @returns {{ queued: boolean }}
     */
    put({ service, topic, key, body, traceparent = null }) {
      if (!service || !key) throw new Error('outbox.put: service and key are required')
      if (!TOPIC.test(String(topic))) throw new Error(`outbox.put: topic '${topic}' is not issue:<owner/repo>#<n>`)
      if (typeof body !== 'string' || !body.trim()) throw new Error('outbox.put: body must be non-empty text')
      const attrs = { 'mycelium.broker.service': service, 'mycelium.broker.topic': topic, 'mycelium.broker.key': key }
      const span = spanUnder(tracer, 'mycelium.broker.put', traceparent, attrs)
      try {
        // The message carries the put span, so its send is a child of the put.
        const tp = formatTraceparent(span.spanContext()) ?? traceparent ?? null
        const queued = insertOut.run(service, topic, key, body, tp, iso()).changes > 0
        span.setAttribute('mycelium.broker.queued', queued)
        log({ direction: 'out', event: 'put', service, topic, key, queued })
        return { queued }
      } catch (err) {
        failed(span, err)
        throw err
      } finally {
        span.end()
      }
    },
  }

  const inbox = {
    /**
     * Replies in a topic for a service, oldest first, past `cursor` (0 or null: from the start). Pass the last
     * reply's `cursor` to read on.
     * @param {string} service @param {string} topic @param {number | null} [cursor] @param {number} [limit]
     * @returns {Reply[]}
     */
    after(service, topic, cursor = 0, limit = 100) {
      return afterIn.all(service, topic, Number(cursor ?? 0), limit).map((r) => ({
        cursor: Number(r.id),
        service: String(r.service),
        topic: String(r.topic),
        messageId: String(r.message_id),
        author: String(r.author),
        authorId: r.author_id == null ? null : String(r.author_id),
        body: String(r.body),
        at: String(r.at),
        traceparent: r.traceparent == null ? null : String(r.traceparent),
      }))
    },
  }

  /**
   * @param {{ fetch: import('./http.mjs').Fetch, config: NonNullable<ReturnType<typeof brokerConfig>>,
   *   sleep?: (ms: number) => Promise<void> }} ports
   */
  const discord = ({ fetch, config, sleep }) => {
    /** @param {string} method @param {string} p @param {unknown} [body] */
    const call = (method, p, body) =>
      requestJson({ fetch, sleep, label: `discord ${method} ${p.split('?')[0]}` }, `${DISCORD_API}${p}`, {
        method,
        headers: {
          Authorization: `Bot ${config.token}`,
          'User-Agent': USER_AGENT,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    return { call }
  }

  const threadOf = db.prepare('SELECT * FROM threads WHERE topic = ?')
  const insertThread = db.prepare('INSERT INTO threads (topic, thread_id, read_after, created_at) VALUES (?, ?, ?, ?)')
  const pending = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id')
  const markSent = db.prepare('UPDATE outbox SET sent_at = ?, message_id = ?, error = NULL WHERE id = ?')
  const markFailed = db.prepare('UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?')

  /**
   * Post every queued message, oldest first, creating a topic's thread on its first post. Each is marked sent in
   * the same breath as Discord answers, and carries a nonce Discord enforces, so a restart never posts it twice. A
   * failure stops the pass there (order is kept); the message is retried next pass.
   * @param {Parameters<typeof discord>[0]} ports
   */
  async function drain(ports) {
    const { call } = discord(ports)
    let sent = 0
    for (const m of pending.all()) {
      const service = String(m.service)
      const topic = String(m.topic)
      const key = String(m.key)
      const attrs = { 'mycelium.broker.service': service, 'mycelium.broker.topic': topic, 'mycelium.broker.key': key }
      const span = spanUnder(tracer, 'mycelium.broker.send', /** @type {string | null} */ (m.traceparent), attrs)
      try {
        let thread = threadOf.get(topic)
        if (!thread) {
          const [, repo, n] = /** @type {RegExpExecArray} */ (TOPIC.exec(topic))
          const made = await call('POST', `/channels/${ports.config.channel}/threads`, {
            name: `${repo}#${n}`.slice(0, 100),
            type: 11,
            auto_archive_duration: 10080,
          })
          if (!made?.id) throw new Error(`discord: thread for ${topic} has no id`)
          insertThread.run(topic, String(made.id), String(made.id), iso())
          thread = threadOf.get(topic)
          log({ direction: 'out', event: 'send', service, topic, key, thread: String(made.id), created: true })
        }
        const threadId = String(/** @type {any} */ (thread).thread_id)
        span.setAttribute('mycelium.broker.thread', threadId)
        const body = String(m.body)
        const posted = await call('POST', `/channels/${threadId}/messages`, {
          content: body.length > CONTENT_MAX ? `${body.slice(0, CONTENT_MAX - 1)}…` : body,
          allowed_mentions: { parse: [] },
          nonce: createHash('sha256').update(`${service}\0${key}`).digest('hex').slice(0, 25),
          enforce_nonce: true,
        })
        markSent.run(iso(), posted?.id == null ? null : String(posted.id), Number(m.id))
        span.setAttribute('mycelium.broker.message_id', String(posted?.id ?? ''))
        log({ direction: 'out', event: 'send', service, topic, key, thread: threadId, messageId: posted?.id ?? null })
        sent++
      } catch (err) {
        markFailed.run(/** @type {Error} */ (err).message, Number(m.id))
        failed(span, err)
        log({ direction: 'out', event: 'send', service, topic, key, error: /** @type {Error} */ (err).message })
        span.end()
        throw err
      }
      span.end()
    }
    return { sent }
  }

  const threads = db.prepare('SELECT * FROM threads ORDER BY topic')
  const moveRead = db.prepare('UPDATE threads SET read_after = ? WHERE topic = ?')
  const senders = db.prepare(
    `SELECT service, traceparent FROM outbox WHERE topic = ? AND id IN
       (SELECT max(id) FROM outbox WHERE topic = ? AND sent_at IS NOT NULL GROUP BY service)`,
  )
  const insertIn = db.prepare(
    `INSERT INTO inbox (service, topic, message_id, author, author_id, body, at, traceparent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (service, message_id) DO NOTHING`,
  )

  /**
   * Read every topic thread past its cursor. A reply by a person lands in the inbox once per service that posted to
   * the topic, spanned under that service's last message; bot messages (mycelium's own posts among them) and system
   * notices only move the cursor.
   * @param {Parameters<typeof discord>[0]} ports
   */
  async function receive(ports) {
    const { call } = discord(ports)
    let received = 0
    for (const t of threads.all()) {
      const topic = String(t.topic)
      const threadId = String(t.thread_id)
      /** @type {any[]} */
      const all = []
      let cursor = String(t.read_after)
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await call('GET', `/channels/${threadId}/messages?after=${cursor}&limit=${PAGE}`)
        if (!Array.isArray(batch)) throw new Error(`discord: thread ${threadId} messages is not a list`)
        all.push(...batch)
        if (batch.length < PAGE) break
        cursor = batch.reduce((c, x) => (later(x.id, c) ? x.id : c), cursor)
      }
      all.sort((a, b) => (later(a.id, b.id) ? 1 : -1))
      for (const msg of all) {
        const id = String(msg.id)
        const person = REPLY_TYPES.has(msg.type) && !msg.author?.bot && !msg.webhook_id
        if (person) {
          for (const s of senders.all(topic, topic)) {
            const service = String(s.service)
            const key = `discord:${id}`
            const attrs = {
              'mycelium.broker.service': service,
              'mycelium.broker.topic': topic,
              'mycelium.broker.key': key,
              'mycelium.broker.thread': threadId,
            }
            const span = spanUnder(
              tracer,
              'mycelium.broker.receive',
              /** @type {string | null} */ (s.traceparent),
              attrs,
            )
            const tp = formatTraceparent(span.spanContext())
            const author = String(msg.author?.username ?? '')
            const fresh =
              insertIn.run(
                service,
                topic,
                id,
                author,
                msg.author?.id == null ? null : String(msg.author.id),
                String(msg.content ?? ''),
                String(msg.timestamp ?? iso()),
                tp,
              ).changes > 0
            span.end()
            if (fresh) {
              received++
              log({ direction: 'in', event: 'receive', service, topic, key, author, messageId: id })
            }
          }
        }
        moveRead.run(id, topic)
      }
    }
    return { received }
  }

  return {
    path: file,
    outbox,
    inbox,
    drain,
    receive,
    /** The run loop's job: drain, then read replies. @param {Parameters<typeof discord>[0]} ports */
    job(ports) {
      return {
        name: 'broker',
        intervalMs: ports.config.intervalMs,
        run: async () => {
          const { sent } = await drain(ports)
          const { received } = await receive(ports)
          return `broker: ${sent} sent, ${received} received`
        },
      }
    },
    /** Safe to call twice. */
    close: () => {
      if (open) db.close()
      open = false
    },
  }
}

/** @type {ReturnType<typeof openBroker> | null} */
let shared = null
/** The store at {@link brokerPath} (environment over ~/.oakgreen/env over forest.json), opened on first use. */
const sharedBroker = () => {
  shared ??= openBroker({ env: withEnvFile(process.env).env })
  return shared
}

/** `outbox.put(...)` on the default store. */
export const outbox = Object.freeze({
  /** @param {Message} m */
  put: (m) => sharedBroker().outbox.put(m),
})

/** `inbox.after(...)` on the default store. */
export const inbox = Object.freeze({
  /** @param {string} service @param {string} topic @param {number | null} [cursor] @param {number} [limit] */
  after: (service, topic, cursor, limit) => sharedBroker().inbox.after(service, topic, cursor, limit),
})
