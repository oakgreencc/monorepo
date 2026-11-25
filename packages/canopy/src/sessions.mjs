// @ts-check
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A Claude Code session id, as `claude.session` spans carry it in `claude.session_id`. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const TEXT_MAX = 20_000
const TOOL_IO_MAX = 4_000
const PROMPT_MAX = 40_000

/** @param {string} s @param {number} max */
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/**
 * @typedef {{ kind: 'prompt', text: string }
 *   | { kind: 'user', at: number | null, text: string, sub: boolean }
 *   | { kind: 'thinking' | 'text', at: number | null, text: string, sub: boolean }
 *   | { kind: 'tool', at: number | null, id: string, name: string, input: string, sub: boolean,
 *       result: string | null, error: boolean, doneAt: number | null }
 *   | { kind: 'result', at: number | null, subtype: string, error: boolean, costUsd: number | null, turns: number | null,
 *       text: string | null }} Entry
 *   `sub`: said inside a subagent (an Agent/Task tool call), not by the worker itself.
 * @typedef {{ sessionId: string | null, model: string | null, cwd: string | null, entries: Entry[], malformed: number }} Transcript
 */

/** A tool input as one readable string: Bash's command as is, anything else as JSON. @param {string} name @param {any} input */
function inputText(name, input) {
  if (input == null) return ''
  if (name === 'Bash' && typeof input.command === 'string')
    return input.description ? `${input.command}\n# ${input.description}` : input.command
  if (typeof input === 'string') return input
  return JSON.stringify(input, null, 1)
}

/** A tool_result's content as text; images become a placeholder. @param {unknown} c */
function resultText(c) {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return c == null ? '' : JSON.stringify(c)
  return c
    .map((/** @type {any} */ b) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * What a worker did, in order, from its log: either cambium's copy of its stdout (`claude -p --output-format
 * stream-json --verbose`) or Claude Code's own transcript (`~/.claude/projects/<cwd>/<session>.jsonl`). Both carry
 * `assistant` and `user` events with Messages API content; everything else (hooks, rate limits, token counters) is
 * skipped. Each tool call is one entry with its result folded in. Long text is clipped. Never throws.
 *
 * @param {string} text the log
 * @param {{ prompt?: string | null }} [opts] `prompt`: what the worker was started with, when the log lacks it
 * @returns {Transcript}
 */
export function transcriptOf(text, { prompt = null } = {}) {
  /** @type {Entry[]} */
  const entries = prompt ? [{ kind: 'prompt', text: clip(prompt, PROMPT_MAX) }] : []
  /** @type {Map<string, Extract<Entry, { kind: 'tool' }>>} */
  const tools = new Map()
  let malformed = 0
  /** @type {string | null} */
  let sessionId = null
  /** @type {string | null} */
  let model = null
  /** @type {string | null} */
  let cwd = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    /** @type {any} */
    let e
    try {
      e = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (!e || typeof e !== 'object' || e.isMeta === true) continue
    if (typeof e.session_id === 'string') sessionId ??= e.session_id
    if (typeof e.sessionId === 'string') sessionId ??= e.sessionId
    if (typeof e.cwd === 'string') cwd ??= e.cwd
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN
    const at = Number.isNaN(ts) ? null : ts
    const sub = typeof e.parent_tool_use_id === 'string' || e.isSidechain === true
    const content = e.message?.content
    if (e.type === 'system' && e.subtype === 'init') {
      if (typeof e.model === 'string') model ??= e.model
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      if (typeof e.message?.model === 'string') model ??= e.message.model
      for (const c of content) {
        if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim())
          entries.push({ kind: 'thinking', at, text: clip(c.thinking.trim(), TEXT_MAX), sub })
        else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
          entries.push({ kind: 'text', at, text: clip(c.text.trim(), TEXT_MAX), sub })
        else if (c?.type === 'tool_use' && typeof c.id === 'string' && !tools.has(c.id)) {
          const name = String(c.name ?? 'unknown')
          /** @type {Extract<Entry, { kind: 'tool' }>} */
          const t = {
            kind: 'tool',
            at,
            id: c.id,
            name,
            input: clip(inputText(name, c.input), TOOL_IO_MAX),
            sub,
            result: null,
            error: false,
            doneAt: null,
          }
          tools.set(c.id, t)
          entries.push(t)
        }
      }
    } else if (e.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) entries.push({ kind: 'user', at, text: clip(content.trim(), PROMPT_MAX), sub })
        continue
      }
      if (!Array.isArray(content)) continue
      const said = []
      for (const c of content) {
        const t = c?.type === 'tool_result' ? tools.get(c.tool_use_id) : undefined
        if (t && t.result === null) {
          t.result = clip(resultText(c.content), TOOL_IO_MAX)
          t.error = c.is_error === true
          t.doneAt = at
        } else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) said.push(c.text.trim())
      }
      if (said.length) entries.push({ kind: 'user', at, text: clip(said.join('\n\n'), PROMPT_MAX), sub })
    } else if (e.type === 'result') {
      const said = typeof e.result === 'string' ? e.result.trim() : ''
      // The result repeats the worker's last words; show them once.
      const echoed = entries.findLast((x) => x.kind === 'text' && !x.sub)
      entries.push({
        kind: 'result',
        at,
        subtype: String(e.subtype ?? '?'),
        error: e.is_error === true || e.subtype !== 'success',
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null,
        turns: typeof e.num_turns === 'number' ? e.num_turns : null,
        text:
          said && !(echoed && 'text' in echoed && echoed.text === clip(said, TEXT_MAX)) ? clip(said, TEXT_MAX) : null,
      })
    }
  }
  // A one-shot worker's prompt is also its transcript's first user message: keep one.
  if (prompt && entries[1]?.kind === 'user' && entries[1].text.trim() === entries[0].text.trim()) entries.splice(1, 1)
  return { sessionId, model, cwd, entries, malformed }
}

/** The first session id a log names, from its first few lines. @param {string} text */
export function sessionIdOf(text) {
  let n = 0
  for (const line of text.split('\n', 50)) {
    if (!line.trim()) continue
    if (++n > 20) break
    const m = /"(?:session_id|sessionId)"\s*:\s*"([0-9a-f-]{36})"/.exec(line)
    if (m) return m[1]
  }
  return null
}

/**
 * @typedef {{ status: 'ok', source: 'cambium' | 'claude', path: string, promptPath: string | null } & Transcript
 *   | { status: 'missing', message: string }} SessionLog
 */

/**
 * Finds a worker session's log: first among cambium's worker logs for the issue (`<logs>/<owner>__<name>/issue-<n>/
 * a<attempt>-<time>.out.log`, its prompt beside it as `.prompt.md`), then Claude Code's own transcript under
 * `<projects>/<cwd slug>/<session id>.jsonl`, which outlives cambium's rotation. Which session a cambium log holds is
 * read from its first lines and kept while the file's size and mtime stay the same.
 *
 * @param {{
 *   logs: string,
 *   projects?: string,
 *   fs?: {
 *     stat: (p: string) => Promise<{ size: number, mtimeMs: number }>,
 *     readdir: (p: string) => Promise<string[]>,
 *     readFile: (p: string) => Promise<string>,
 *   },
 * }} opts
 */
export function sessionLogs({
  logs,
  projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
  fs = { stat, readdir, readFile: (p) => readFile(p, 'utf8') },
}) {
  /** @type {Map<string, { key: string, id: string | null }>} */
  const ids = new Map()

  /** @param {string} dir @param {string} sessionId */
  async function inCambium(dir, sessionId) {
    let names = []
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.out.log'))
    } catch {
      return null
    }
    for (const n of names.sort().reverse()) {
      const p = join(dir, n)
      try {
        const st = await fs.stat(p)
        const key = `${st.size}:${st.mtimeMs}`
        let hit = ids.get(p)
        if (hit?.key !== key) {
          hit = { key, id: sessionIdOf(await fs.readFile(p)) }
          ids.set(p, hit)
        }
        if (hit.id === sessionId) return p
      } catch {}
    }
    return null
  }

  /** @param {string} sessionId */
  async function inClaude(sessionId) {
    let dirs = []
    try {
      dirs = await fs.readdir(projects)
    } catch {
      return null
    }
    for (const d of dirs) {
      const p = join(projects, d, `${sessionId}.jsonl`)
      try {
        await fs.stat(p)
        return p
      } catch {}
    }
    return null
  }

  return {
    logs,
    projects,
    /**
     * @param {{ repo: string | null, issue: number | null, sessionId: string }} q
     * @returns {Promise<SessionLog>}
     */
    async find({ repo, issue, sessionId }) {
      if (!SESSION_ID.test(sessionId)) return { status: 'missing', message: `not a session id: ${sessionId}` }
      const out =
        repo && issue ? await inCambium(join(logs, repo.replace('/', '__'), `issue-${issue}`), sessionId) : null
      if (out) {
        const promptPath = out.replace(/\.out\.log$/, '.prompt.md')
        let prompt = null
        try {
          prompt = await fs.readFile(promptPath)
        } catch {}
        const t = transcriptOf(await fs.readFile(out), { prompt })
        return { status: 'ok', source: 'cambium', path: out, promptPath: prompt === null ? null : promptPath, ...t }
      }
      const native = await inClaude(sessionId)
      if (native)
        return {
          status: 'ok',
          source: 'claude',
          path: native,
          promptPath: null,
          ...transcriptOf(await fs.readFile(native)),
        }
      return {
        status: 'missing',
        message: `no log for session ${sessionId}: not among cambium's worker logs${repo && issue ? ` for ${repo}#${issue}` : ''} (it keeps the newest few per issue) nor in ${projects}`,
      }
    },
  }
}

/** @typedef {ReturnType<typeof sessionLogs>} SessionLogs */
