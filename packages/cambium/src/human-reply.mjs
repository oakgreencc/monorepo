// @ts-check
/**
 * Human replies: a comment on an issue, written after the issue entered its current state, by someone who is
 * neither cambium nor a bot. A human answers a `q:human` question (or says a parked issue is not really blocked) by
 * commenting; cambium sends the issue back to triage at once and quotes the reply in the triage prompt
 * (dispatch-engine.mjs `wake`, graphs/dispatch.mjs `start-triage`).
 *
 * An answer comment counts too, whoever wrote it: a comment carrying
 * `<!-- cambium:answer {"graph":"decide","decideAt":"…","answerer":"<login>"} -->`. A decision made in a `decide`
 * session is posted through graft as the App; the marker says a person (`answerer`) made it. It is separate from the
 * state marker (marker.mjs) and is the only way an App or bot comment counts.
 */
import { parseDecideMarker } from './graphs/decide.mjs'
import { parseMarker } from './marker.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Comment} Comment
 * @typedef {import('./marker.mjs').Marker} Marker
 * @typedef {{ graph: string | null, decideAt: string | null, answerer: string }} Answer
 *   An answer marker's payload: the session graph that produced it, when the decision was made, who made it.
 * @typedef {{ since: string, question: string | null }} ReplyContext
 *   What a reply answers: the state's start (replies after it count) and the reason the issue was waiting for.
 */

/** A reply quoted in the triage prompt is cut to this many characters. */
export const REPLY_CHARS = 2000
/** At most this many replies are quoted, the newest. */
export const REPLIES_KEPT = 5

const ANSWER_RE = /<!-- cambium:answer (.*?) -->/s

/**
 * The answer marker in `body`, or null: none, unparsable JSON, not an object, or no `answerer` login. Never throws.
 * @param {string | null | undefined} body @returns {Answer | null}
 */
export function parseAnswer(body) {
  const m = ANSWER_RE.exec(body ?? '')
  if (!m) return null
  try {
    const p = JSON.parse(m[1])
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    if (typeof p.answerer !== 'string' || !p.answerer.trim()) return null
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : null)
    return { graph: str(p.graph), decideAt: str(p.decideAt), answerer: p.answerer.trim() }
  } catch {
    return null
  }
}

/**
 * The answer marker for a decision `answerer` made, as {@link parseAnswer} reads it. `--` would end the HTML
 * comment early, so it is written as a JSON escape.
 * @param {Answer} a
 */
export const renderAnswerMarker = (a) => `<!-- cambium:answer ${JSON.stringify(a).replace(/--/g, '-\\u002d')} -->`

/**
 * Whether `c` is a reply rather than cambium talking to itself, regardless of time: never a comment carrying a state
 * marker or a `cambium:decide` marker; an answer comment always; otherwise a human's (an author, not a `Bot`, not one of `self`).
 * @param {Comment} c @param {Set<string | null | undefined>} self
 */
export function isReply(c, self) {
  if (parseMarker(c.body) || parseDecideMarker(c.body)) return false
  if (parseAnswer(c.body)) return true
  return !!c.author && !c.bot && !self.has(c.author)
}

/** Who a reply is from: an answer's `answerer`, else the comment's author. @param {Comment} c @returns {string} */
export const replyAuthor = (c) => parseAnswer(c.body)?.answerer ?? c.author ?? 'unknown'

/**
 * The logins whose comments are cambium's own: `botLogin` and the state comment's author.
 * @param {Issue} issue @param {string | null | undefined} botLogin @returns {Set<string | null | undefined>}
 */
export const selfLogins = (issue, botLogin) => new Set([botLogin, issue.stateComment?.author].filter(Boolean))

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
 * `cambium:decide` marker (graphs/decide.mjs); except an answer comment ({@link parseAnswer}), which counts whoever wrote it. No `since`: none (nothing to be a reply to).
 * @param {Issue} issue @param {{ since: string | null, botLogin?: string | null }} o @returns {Comment[]}
 */
export function humanReplies(issue, { since, botLogin = null }) {
  if (!since) return []
  const after = Date.parse(since)
  if (!Number.isFinite(after)) return []
  const self = selfLogins(issue, botLogin)
  return (issue.comments ?? []).filter((c) => Date.parse(c.createdAt) > after && isReply(c, self))
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
 * The replies as the triage prompt quotes them: the newest {@link REPLIES_KEPT}, each cut to {@link REPLY_CHARS}. An
 * answer comment's author is its `answerer`, not the App that posted it.
 * @param {Comment[]} replies @returns {{ author: string, at: string, body: string }[]}
 */
export function quoted(replies) {
  return replies.slice(-REPLIES_KEPT).map((c) => ({
    author: replyAuthor(c),
    at: c.createdAt,
    body: c.body.length > REPLY_CHARS ? `${c.body.slice(0, REPLY_CHARS)}… (cut)` : c.body,
  }))
}
