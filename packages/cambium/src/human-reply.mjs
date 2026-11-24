// @ts-check
/**
 * Human replies: a comment on an issue, written after the issue entered its current state, by someone who is
 * neither cambium nor a bot. A human answers a `q:human` question (or says a parked issue is not really blocked) by
 * commenting; cambium sends the issue back to triage at once and quotes the reply in the triage prompt
 * (dispatch-engine.mjs `wake`, graphs/dispatch.mjs `start-triage`).
 */
import { parseDecideMarker } from './graphs/decide.mjs'
import { parseMarker } from './marker.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Comment} Comment
 * @typedef {import('./marker.mjs').Marker} Marker
 * @typedef {{ since: string, question: string | null }} ReplyContext
 *   What a reply answers: the state's start (replies after it count) and the reason the issue was waiting for.
 */

/** A reply quoted in the triage prompt is cut to this many characters. */
export const REPLY_CHARS = 2000
/** At most this many replies are quoted, the newest. */
export const REPLIES_KEPT = 5

/**
 * When the marker's issue entered its current state: the later of `enteredAt` and the last history `at` (a
 * stage-era write can leave an old `enteredAt` behind a newer history entry). Null without either.
 * @param {Marker | null | undefined} m @returns {string | null}
 */
export function stateSince(m) {
  if (!m) return null
  const times = [m.enteredAt, m.history.at(-1)?.at].filter((t) => t && Number.isFinite(Date.parse(t)))
  if (!times.length) return null
  return /** @type {string} */ (
    times.reduce((a, b) => (Date.parse(/** @type {string} */ (b)) > Date.parse(/** @type {string} */ (a)) ? b : a))
  )
}

/**
 * The human replies on `issue` written after `since`, oldest first. Never cambium's: not by `botLogin`, not by the
 * login that wrote the state comment, not a `Bot`-type author, and not a comment carrying a state marker or a
 * `cambium:decide` marker (graphs/decide.mjs). No `since`:
 * none (nothing to be a reply to).
 * @param {Issue} issue @param {{ since: string | null, botLogin?: string | null }} o @returns {Comment[]}
 */
export function humanReplies(issue, { since, botLogin = null }) {
  if (!since) return []
  const after = Date.parse(since)
  if (!Number.isFinite(after)) return []
  const self = new Set([botLogin, issue.stateComment?.author].filter(Boolean))
  return (issue.comments ?? []).filter(
    (c) =>
      !!c.author &&
      !c.bot &&
      !self.has(c.author) &&
      !parseMarker(c.body) &&
      !parseDecideMarker(c.body) &&
      Date.parse(c.createdAt) > after,
  )
}

/**
 * The context a triage after `m` quotes replies against, or null when `m` is not waiting on anything: the
 * dispatch graph's `deferred` / `blocked` (the defer or blocked reason), or any `to-human` (the needs-human reason).
 * @param {Marker | null | undefined} m @returns {ReplyContext | null}
 */
export function replyContextOf(m) {
  if (!m || m.status === 'done') return null
  const since = stateSince(m)
  if (!since) return null
  if (m.graph === 'dispatch' && (m.node === 'deferred' || m.node === 'blocked'))
    return { since, question: m.deferReason ?? m.history.at(-1)?.reason ?? null }
  if (m.node === 'to-human') return { since, question: m.lastFailure ?? m.history.at(-1)?.reason ?? null }
  return null
}

/**
 * The replies as the triage prompt quotes them: the newest {@link REPLIES_KEPT}, each cut to {@link REPLY_CHARS}.
 * @param {Comment[]} replies @returns {{ author: string, at: string, body: string }[]}
 */
export function quoted(replies) {
  return replies.slice(-REPLIES_KEPT).map((c) => ({
    author: c.author ?? 'unknown',
    at: c.createdAt,
    body: c.body.length > REPLY_CHARS ? `${c.body.slice(0, REPLY_CHARS)}… (cut)` : c.body,
  }))
}
