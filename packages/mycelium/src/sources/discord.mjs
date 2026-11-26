// @ts-check
import { envelope } from '../envelope.mjs'
import { requestJson } from '../http.mjs'
import { closedText, filedText } from '../notify.mjs'

export const DISCORD_API = 'https://discord.com/api/v10'
/** Discord rejects requests without a User-Agent of this shape. */
export const USER_AGENT = 'DiscordBot (https://github.com/oakgreencc/monorepo, 0.0.0)'
export const DISCORD_ENV = /** @type {const} */ ([
  'MYCELIUM_DISCORD_TOKEN',
  'MYCELIUM_DISCORD_CHANNELS',
  'MYCELIUM_DISCORD_GUILD',
])
export const DISCORD_INTERVAL_MS = 60_000
const PAGE = 100
const MAX_PAGES = 10
const DISCORD_EPOCH = 1420070400000n
/** Default and reply messages; joins, pins, boosts and the like are not reports. */
const REPORT_TYPES = new Set([0, 19])

/**
 * Bot token, channels (`123,forum:456`; a forum channel's posts are
 * threads), and the guild (needed for forum channels and message links).
 * Null when the token or channels are missing.
 *
 * @param {Record<string, string | undefined>} env
 */
export function discordConfig(env = process.env) {
  const token = env.MYCELIUM_DISCORD_TOKEN ?? ''
  const channels = String(env.MYCELIUM_DISCORD_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('forum:') ? { id: s.slice(6), forum: true } : { id: s, forum: false }))
  if (!token || channels.length === 0) return null
  for (const c of channels) if (!/^\d+$/.test(c.id)) throw new Error(`discord: channel '${c.id}' is not a snowflake`)
  const decisions = String(env.MYCELIUM_DECISIONS_CHANNEL ?? '').trim()
  if (decisions && channels.some((c) => c.id === decisions))
    throw new Error(`discord: ${decisions} is the decisions channel (MYCELIUM_DECISIONS_CHANNEL); it is never intake`)
  const guild = env.MYCELIUM_DISCORD_GUILD || null
  if (channels.some((c) => c.forum) && !guild) throw new Error('discord: forum channels need MYCELIUM_DISCORD_GUILD')
  return { token, channels, guild, decisions: decisions || null }
}

export const snowflakeAt = (/** @type {number} */ ms) => String((BigInt(Math.max(0, ms)) - DISCORD_EPOCH) << 22n)
export const snowflakeTime = (/** @type {string} */ id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
const after = (/** @type {string} */ a, /** @type {string} */ b) => BigInt(a) > BigInt(b)

/** @param {any} m */
function text(m) {
  const files = (m.attachments ?? []).map((/** @type {any} */ a) => a?.url).filter(Boolean)
  return [String(m.content ?? ''), ...files].filter(Boolean).join('\n')
}

/**
 * Discord channels and forums. A text channel's messages are envelopes; a
 * reply's identity is the message it answers, so it lands as a comment on
 * that intent. A forum channel's new posts (threads) are envelopes, the
 * starter message as the body. Bot authors are skipped so nothing echoes.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof discordConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number,
 * }} ports
 */
export function discordSource({ fetch, config, sleep, intervalMs = DISCORD_INTERVAL_MS }) {
  const get = (/** @type {string} */ path) =>
    requestJson({ fetch, sleep, label: `discord GET ${path.split('?')[0]}` }, `${DISCORD_API}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bot ${config.token}`, 'User-Agent': USER_AGENT },
    })
  const link = (/** @type {string} */ ...ids) =>
    config.guild ? `https://discord.com/channels/${config.guild}/${ids.join('/')}` : null

  /** @param {string} channelId @param {string} since */
  const messages = async (channelId, since) => {
    /** @type {any[]} */
    const all = []
    let cursor = since
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await get(`/channels/${channelId}/messages?after=${cursor}&limit=${PAGE}`)
      if (!Array.isArray(batch)) throw new Error(`discord: channel ${channelId} messages is not a list`)
      all.push(...batch)
      if (batch.length < PAGE) break
      cursor = batch.reduce((m, x) => (after(x.id, m) ? x.id : m), cursor)
    }
    all.sort((a, b) => (after(a.id, b.id) ? 1 : -1))
    /** @type {Map<string, string>} */
    const roots = new Map()
    /** @type {{ id: string, envelope: import('../envelope.mjs').Envelope | null }[]} */
    const out = []
    for (const m of all) {
      const ref = m.type === 19 ? m.message_reference?.message_id : undefined
      const root = ref ? (roots.get(ref) ?? m.referenced_message?.message_reference?.message_id ?? ref) : m.id
      roots.set(m.id, root)
      const report = REPORT_TYPES.has(m.type) && !m.author?.bot && text(m)
      out.push({
        id: m.id,
        envelope: report
          ? envelope({
              source: 'discord',
              externalId: m.id,
              receivedAt: m.timestamp,
              author: m.author?.username ?? '',
              title: '',
              body: text(m),
              url: link(channelId, m.id),
              meta: { channelId, rootId: root === m.id ? null : root },
            })
          : null,
      })
    }
    return out
  }

  /** @param {string} forumId @param {string} since */
  const posts = async (forumId, since) => {
    const active = await get(`/guilds/${config.guild}/threads/active`)
    const threads = (active?.threads ?? [])
      .filter((/** @type {any} */ t) => String(t.parent_id) === forumId && after(t.id, since))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (after(a.id, b.id) ? 1 : -1))
    /** @type {{ id: string, envelope: import('../envelope.mjs').Envelope | null }[]} */
    const out = []
    for (const t of threads) {
      const starter = await get(`/channels/${t.id}/messages/${t.id}`)
      out.push({
        id: t.id,
        envelope: starter?.author?.bot
          ? null
          : envelope({
              source: 'discord',
              externalId: t.id,
              receivedAt: new Date(snowflakeTime(t.id)).toISOString(),
              author: starter?.author?.username ?? '',
              title: String(t.name ?? ''),
              body: text(starter ?? {}),
              url: link(t.id),
              meta: { channelId: forumId, rootId: t.id, tags: t.applied_tags?.length ? t.applied_tags : null },
            }),
      })
    }
    return out
  }

  return {
    name: 'discord',
    intervalMs,
    /**
     * Cursor: the last snowflake handled per channel. Skipped messages
     * still advance it.
     *
     * @param {Record<string, string> | null} cursor
     * @param {{ now: number, since: number }} at
     */
    async pull(cursor, { since }) {
      /** @type {Record<string, string>} */
      let c = { ...(cursor ?? {}) }
      /** @type {{ envelope: import('../envelope.mjs').Envelope | null, cursor: Record<string, string> }[]} */
      const out = []
      for (const ch of config.channels) {
        const from = c[ch.id] ?? snowflakeAt(since)
        for (const item of ch.forum ? await posts(ch.id, from) : await messages(ch.id, from)) {
          c = { ...c, [ch.id]: item.id }
          out.push({ envelope: item.envelope, cursor: c })
        }
      }
      return out
    },
  }
}

/**
 * Where a Discord-filed intent is answered, from its intake url: a forum
 * post's thread (`/channels/<guild>/<thread>`), or a reply to the message in
 * its text channel (`/channels/<guild>/<channel>/<message>`). Null for any
 * other url.
 *
 * @param {string | null} url
 * @returns {{ channelId: string, replyTo: string | null } | null}
 */
export function replyTarget(url) {
  const m = /^https:\/\/discord\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?$/.exec(String(url ?? ''))
  return m ? { channelId: m[1], replyTo: m[2] ?? null } : null
}

/**
 * The notifier's Discord channel: posts the acknowledgement and the outcome
 * note where the report was made. Needs Send Messages (and Send Messages in
 * Threads for forums); mentions are never parsed, so nothing pings anyone.
 *
 * @param {{
 *   fetch: import('../http.mjs').Fetch,
 *   config: NonNullable<ReturnType<typeof discordConfig>>,
 *   sleep?: (ms: number) => Promise<void>,
 * }} ports
 * @returns {import('../notify.mjs').Channel}
 */
export function discordChannel({ fetch, config, sleep }) {
  /** @param {import('../notify.mjs').Intake} intake @param {string} content */
  const post = async (intake, content) => {
    const target = replyTarget(intake.url)
    if (!target) throw new Error(`discord: no reply target in ${intake.url}`)
    const path = `/channels/${target.channelId}/messages`
    await requestJson({ fetch, sleep, label: `discord POST ${path}` }, `${DISCORD_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bot ${config.token}`, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
        ...(target.replyTo ? { message_reference: { message_id: target.replyTo, fail_if_not_exists: false } } : {}),
      }),
    })
  }
  const link = (/** @type {import('../notify.mjs').Issue} */ i) => i.html_url ?? `#${i.number}`
  return {
    filed: (intake, issue) => post(intake, filedText(issue.number, link(issue))),
    closed: (intake, issue, outcome) => post(intake, closedText(outcome, link(issue))),
  }
}
