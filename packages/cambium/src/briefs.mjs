// @ts-check
/**
 * Session briefs: for a `q:human` item worth an interactive session, a Markdown file that seeds a fresh
 * `claude` session with what cambium knows (the issue, its marker history, the last failure, its PRs, what earlier
 * attempts tried) so a human does not rebuild that by hand.
 *
 * Written to `<home>/briefs/<owner>__<repo>/issue-<n>.md`. Every tick {@link syncBriefs} renders each candidate's
 * brief and rewrites the file only when the text changed (so it is regenerated when the issue enters `q:human` or
 * its marker changes), and deletes every other brief in a repo's directory (the issue left `q:human` or closed).
 * A repo whose snapshot failed this tick is left alone. Briefs are local files: they never go to GitHub.
 *
 * {@link redact} runs over the whole brief: nothing token-shaped leaves cambium's memory in one.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Q, WHY } from './labels.mjs'
import { branchIssue } from './github.mjs'

/**
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').PullRequest} PullRequest
 * @typedef {{ label: string, detail: string }} AskOption
 * @typedef {{ question?: string, options?: AskOption[], recommendation?: string }} Ask
 *   What a typed escalation asks the human; read from the marker's `ask` when it has one. Options keep the
 *   `{ label, detail }` shape of `ask.mjs`'s asks; one without a string label is dropped.
 * @typedef {{
 *   read(path: string): string | null, write(path: string, text: string): void, remove(path: string): void,
 *   list(dir: string): string[],
 * }} BriefFs
 *   `read`: null when the file does not exist. `list`: the file names in `dir`, [] when it does not exist.
 */

const BODY_KEPT = 4000

/**
 * Whether an issue gets a brief: in `q:human` for a reason worth an interactive session. The one place that
 * decides; today `why:budget` (attempts or reworks spent).
 * @param {{ labels: string[] }} issue
 */
export const isSessionCandidate = (issue) => issue.labels.includes(Q.human) && issue.labels.includes(WHY.budget)

/** `owner/name` → the brief directory's name. @param {string} slug */
export const repoDir = (slug) => slug.replace('/', '__')

/** @param {string} dir the briefs root @param {string} slug @param {number} n */
export const briefPath = (dir, slug, n) => join(dir, repoDir(slug), `issue-${n}.md`)

/**
 * Token-shaped text, replaced by `[redacted]`: provider tokens by their prefixes, bearer/basic auth, credentials in
 * URLs, and the value of any `NAME=value` / `name: value` whose name says it is a secret.
 */
const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]
const AUTH_HEADER = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]+)/gi

/** @param {string} text */
export function redact(text) {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
    .replace(AUTH_HEADER, '$1 [redacted]')
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(SECRET_ASSIGNMENT, (all, name, sep, value) => (value === '[redacted]' ? all : `${name}${sep}[redacted]`))
}

/** Acceptance checks: triage's, else the issue body's checkboxes. @param {Issue} issue @param {any} marker */
function acceptanceOf(issue, marker) {
  const fromTriage = marker.triage?.acceptance ?? []
  if (fromTriage.length) return fromTriage.map((/** @type {string} */ a) => String(a))
  return [...(issue.body ?? '').matchAll(/^\s*[-*] \[[ xX]\] (.+)$/gm)].map((m) => m[1].trim())
}

/** The body, cut at {@link BODY_KEPT} characters. @param {string} body */
function bodySummary(body) {
  const b = (body ?? '').trim()
  if (!b) return '_No description._'
  return b.length > BODY_KEPT
    ? `${b.slice(0, BODY_KEPT)}\n\n_(cut at ${BODY_KEPT} characters; read the rest on GitHub)_`
    : b
}

/** One line for a Markdown list. @param {string} s */
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim()

/** @param {string} s */
const fence = (s) => ['```', s.replace(/```/g, "'''"), '```']

/** @param {unknown} v @returns {Ask | null} */
function askOf(v) {
  if (!v || typeof v !== 'object') return null
  const a = /** @type {Record<string, unknown>} */ (v)
  const options = (Array.isArray(a.options) ? a.options : []).flatMap((o) =>
    o && typeof o === 'object' && typeof o.label === 'string' && o.label
      ? [{ label: o.label, detail: typeof o.detail === 'string' ? o.detail : '' }]
      : [],
  )
  const ask = {
    ...(typeof a.question === 'string' && a.question ? { question: a.question } : {}),
    ...(options.length ? { options } : {}),
    ...(typeof a.recommendation === 'string' && a.recommendation ? { recommendation: a.recommendation } : {}),
  }
  return Object.keys(ask).length ? ask : null
}

/**
 * The brief's text. Pure: everything comes from the snapshot and config; no time of writing, so an unchanged issue
 * renders the same text and is not rewritten.
 *
 * @param {{ slug: string, repoPath: string, issue: Issue, prs: PullRequest[], maxAttempts: number, maxReworks: number }} input
 * @returns {string}
 */
export function renderBrief({ slug, repoPath, issue, prs, maxAttempts, maxReworks }) {
  const marker = /** @type {any} */ (issue.stateComment?.marker ?? {})
  const history = /** @type {import('./marker.mjs').HistoryEntry[]} */ (marker.history ?? [])
  const why = issue.labels.filter((l) => l.startsWith('why:')).join(', ') || 'none'
  const mine = prs
    .filter((p) => p.closes.includes(issue.number) || branchIssue(p.branch) === issue.number)
    .sort((a, b) => a.number - b.number)
  const seen = new Set(mine.map((p) => p.number))
  const earlier = [...new Set(history.map((h) => h.pr).filter((n) => typeof n === 'number' && !seen.has(n)))]
  const branch = mine.find((p) => p.state === 'OPEN')?.branch ?? marker.branch ?? `agent/${issue.number}-<topic>`
  const acceptance = acceptanceOf(issue, marker)
  const ask = askOf(marker.ask)
  const rejected = history.filter((h) => h.reason)

  const out = [
    `# Session brief: ${slug}#${issue.number}: ${issue.title}`,
    '',
    `You are picking up ${issue.url} with a human in an interactive session. cambium, the scheduler, could not`,
    `finish it on its own and moved it to the Human Queue (q:human, ${why}). Below is what cambium knows.`,
    'Start by saying what you think went wrong and what you would try differently; do not repeat a rejected approach.',
    '',
    '## Issue',
    '',
    `- Link: ${issue.url}`,
    `- Labels: ${issue.labels.join(', ') || 'none'}`,
    ...(marker.triage?.title ? [`- Task (from triage): ${oneLine(String(marker.triage.title))}`] : []),
    '',
    bodySummary(issue.body),
    '',
    '## Acceptance checks',
    '',
    ...(acceptance.length ? acceptance.map((a) => `- [ ] ${oneLine(a)}`) : ['None written down.']),
  ]
  if (ask) {
    out.push('', '## The question')
    if (ask.question) out.push('', ask.question)
    if (ask.options)
      out.push(
        '',
        'Options:',
        '',
        ...ask.options.map((o, i) => `${i + 1}. **${oneLine(o.label)}**: ${oneLine(o.detail)}`),
      )
    if (ask.recommendation) out.push('', `Recommendation: ${ask.recommendation}`)
  }
  out.push(
    '',
    '## Where cambium left it',
    '',
    `- Graph: ${marker.graph ?? 'task'} · node ${marker.node ?? 'unknown'}`,
    `- Attempts: ${marker.attempt ?? 1} of ${maxAttempts}`,
    `- Reworks: ${marker.reworks ?? 0} of ${maxReworks}`,
    `- Failed SHA: ${marker.failedSha ?? 'none'}`,
  )
  if (marker.lastFailure) out.push('', 'Last failure:', '', ...fence(String(marker.lastFailure)))
  out.push('', '## Pull requests', '')
  if (!mine.length && !earlier.length) out.push('None.')
  for (const p of mine)
    out.push(
      `- #${p.number} ${p.state.toLowerCase()} on \`${p.branch}\`${p.headSha ? ` at ${p.headSha.slice(0, 7)}` : ''}` +
        `${p.checks ? ` · checks ${p.checks.toLowerCase()}` : ''} · ${p.url}`,
    )
  for (const n of earlier) out.push(`- #${n} (named in the history; closed or no longer read)`)
  out.push('', '## Approaches already rejected', '')
  if (!rejected.length) out.push('None recorded.')
  for (const h of rejected)
    out.push(
      `- Attempt ${h.attempt}${h.node ? ` at ${h.node}` : ''} (${h.outcome})${h.pr ? `, PR #${h.pr}` : ''}: ${oneLine(String(h.reason))}`,
    )
  out.push('', '## Marker history', '')
  if (!history.length) out.push('Empty.')
  for (const h of history)
    out.push(`- ${[h.at, h.node, `attempt ${h.attempt}`, h.outcome].filter(Boolean).join(' · ')}`)
  out.push(
    '',
    '## Repository and contract',
    '',
    `- Repo: ${slug}, checked out at ${repoPath}`,
    `- Work in a worktree under \`.claude/worktrees/\`, on the branch \`${branch}\`.`,
    '- Verify: `pnpm verify` (lint + tests). Green means committable.',
    `- Publish: \`graft publish ${branch} "<conventional commit message>" --paths <a,b> --pr "<title>" --closes ${issue.number}\`.`,
    '  Never `git commit`, `git push`, `git fetch` or `git pull`.',
    `- Done: \`graft ci wait ${branch}\`. Red: \`graft jobs <run>\`, fix, publish again.`,
    "- Labels are cambium's: once the PR is up, a human moves the issue out of q:human (or cambium picks up the green PR).",
    '',
  )
  return redact(out.join('\n'))
}

/** @type {BriefFs} */
export const realBriefFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  write(path, text) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text, { mode: 0o600 })
  },
  remove: (path) => rmSync(path, { force: true }),
  list(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
}

/**
 * Bring the briefs directory in line with the snapshots: write (or rewrite, when the text changed) each candidate's
 * brief; delete any other `issue-<n>.md` in a read repo's directory.
 *
 * @param {{
 *   dir: string, fs?: BriefFs, config: import('./config.mjs').Config,
 *   snaps: Map<string, import('./github.mjs').Snapshot>,
 * }} input
 * @returns {{ written: string[], removed: string[] }} paths
 */
export function syncBriefs({ dir, fs = realBriefFs, config, snaps }) {
  /** @type {string[]} */
  const written = []
  /** @type {string[]} */
  const removed = []
  for (const repo of config.repos) {
    const snap = snaps.get(repo.slug)
    if (!snap) continue
    const keep = new Set()
    for (const issue of snap.issues.values()) {
      if (issue.state !== 'OPEN' || !isSessionCandidate(issue)) continue
      const path = briefPath(dir, repo.slug, issue.number)
      keep.add(path)
      const text = renderBrief({
        slug: repo.slug,
        repoPath: repo.path,
        issue,
        prs: snap.prs,
        maxAttempts: config.phases.task.maxAttempts,
        maxReworks: config.phases.task.maxReworks,
      })
      if (fs.read(path) === text) continue
      fs.write(path, text)
      written.push(path)
    }
    const repoBriefs = join(dir, repoDir(repo.slug))
    for (const name of fs.list(repoBriefs)) {
      const path = join(repoBriefs, name)
      if (!/^issue-\d+\.md$/.test(name) || keep.has(path)) continue
      fs.remove(path)
      removed.push(path)
    }
  }
  return { written, removed }
}
