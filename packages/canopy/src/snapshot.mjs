// @ts-check
/**
 * cambium's queue view (`paths.queues`, default `~/.oakgreen/cambium/queues.json`): the board cambium builds from the
 * snapshot it reads every tick. canopy shows it as is and queries GitHub itself only for the repos the file cannot
 * answer for: when it is missing, unreadable, of another version, or older than {@link STALE_TICKS} ticks (cambium
 * is down), or when it does not list the repo.
 */
import { readFile } from 'node:fs/promises'
import { STALE_TICKS } from './heartbeat.mjs'
import { combine, COLUMNS, emptyColumns } from './queues.mjs'

export const SUPPORTED_QUEUES_VERSION = 1
const DEFAULT_TICK_SECONDS = 30

/**
 * @typedef {import('./queues.mjs').RepoQueues} RepoQueues
 * @typedef {{ ok: true, repos: Map<string, RepoQueues>, ageMs: number, staleAfterMs: number }
 *   | { ok: false, reason: string }} QueuesRead
 *   `ok: false`: the file cannot stand in for GitHub, and `reason` says why in a line the page shows.
 * @typedef {import('./queues.mjs').QueueView & { source: 'cambium' | 'github' | 'mixed', fallback: string | null }} SourcedView
 *   `source`: where the queues came from. `fallback`: why canopy queried GitHub itself, or null when it did not.
 */

const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : [])

/** One repo of the file, with every part the page reads present. @param {any} r @returns {RepoQueues} */
function repoOf(r) {
  const columns = emptyColumns()
  for (const c of COLUMNS) columns[c] = arr(r?.columns?.[c])
  return {
    slug: String(r.slug),
    ok: r.ok !== false,
    error: typeof r.error === 'string' ? r.error : null,
    fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : null,
    columns,
    prs: arr(r.prs),
    stranded: arr(r.stranded),
  }
}

/**
 * Read and judge cambium's queue view. Never throws.
 *
 * @param {string} path
 * @param {{ now?: number, read?: (p: string) => Promise<string> }} [opts]
 * @returns {Promise<QueuesRead>}
 */
export async function readQueuesFile(path, { now = Date.now(), read = (p) => readFile(p, 'utf8') } = {}) {
  let raw
  try {
    raw = JSON.parse(await read(path))
  } catch (err) {
    const code = /** @type {any} */ (err)?.code
    return {
      ok: false,
      reason:
        code === 'ENOENT'
          ? `no queue view at ${path}: cambium has not written one`
          : `cannot read ${path}: ${/** @type {Error} */ (err).message}`,
    }
  }
  if (raw?.version !== SUPPORTED_QUEUES_VERSION)
    return {
      ok: false,
      reason: `${path} is version ${JSON.stringify(raw?.version ?? null)}, canopy reads ${SUPPORTED_QUEUES_VERSION}`,
    }
  const tickSeconds = Number(raw.tickSeconds) > 0 ? Number(raw.tickSeconds) : DEFAULT_TICK_SECONDS
  const staleAfterMs = STALE_TICKS * tickSeconds * 1000
  const written = Date.parse(raw.writtenAt ?? '')
  if (!Number.isFinite(written)) return { ok: false, reason: `${path} does not say when it was written` }
  const ageMs = Math.max(0, now - written)
  if (ageMs > staleAfterMs)
    return {
      ok: false,
      reason: `cambium's queue view is ${Math.round(ageMs / 1000)}s old, past the ${STALE_TICKS} ticks of ${tickSeconds}s allowed: is cambium running?`,
    }
  /** @type {Map<string, RepoQueues>} */
  const repos = new Map()
  for (const r of arr(raw.repos)) if (typeof r?.slug === 'string') repos.set(r.slug, repoOf(r))
  return { ok: true, repos, ageMs, staleAfterMs }
}

/**
 * The queues for the page: from cambium's file while it is fresh, from `github` (the cached GitHub client,
 * github.mjs `cachedQueues`) for what it cannot answer.
 *
 * @param {{
 *   path: string,
 *   github: { get(slugs: string[]): Promise<import('./queues.mjs').QueueView>, ttlMs?: number },
 *   now?: () => number,
 *   read?: (p: string) => Promise<string>,
 * }} opts
 */
export function snapshotQueues({ path, github, now = Date.now, read }) {
  return {
    ttlMs: github.ttlMs,
    /** @param {string[]} slugs @returns {Promise<SourcedView>} */
    async get(slugs) {
      const file = await readQueuesFile(path, { now: now(), ...(read ? { read } : {}) })
      const fromFile = file.ok ? slugs.filter((s) => file.repos.has(s)) : []
      const rest = slugs.filter((s) => !fromFile.includes(s))
      if (!rest.length)
        return {
          ...combine(
            fromFile.map((s) => /** @type {RepoQueues} */ (file.ok && file.repos.get(s))),
            true,
          ),
          source: 'cambium',
          fallback: null,
        }
      const fallback = file.ok
        ? `cambium's queue view does not list ${rest.join(', ')}, so canopy reads ${rest.length > 1 ? 'them' : 'it'} from GitHub`
        : `${file.reason} Reading the queues from GitHub instead.`
      const gh = await github.get(rest)
      if (!fromFile.length) return { ...gh, source: 'github', fallback }
      // Both: rebuild the view from per-repo parts, keeping the order asked for.
      const ghRepos = splitByRepo(gh)
      const parts = slugs.map((s) =>
        fromFile.includes(s)
          ? /** @type {RepoQueues} */ (file.ok && file.repos.get(s))
          : /** @type {RepoQueues} */ (ghRepos.get(s)),
      )
      return { ...combine(parts, gh.cached), source: 'mixed', fallback }
    },
  }
}

/** A combined view → its repos again. @param {import('./queues.mjs').QueueView} v */
function splitByRepo(v) {
  /** @type {Map<string, RepoQueues>} */
  const out = new Map()
  for (const r of v.repos) {
    const columns = emptyColumns()
    for (const c of COLUMNS) columns[c] = v.columns[c].filter((i) => i.repo === r.slug)
    out.set(r.slug, {
      ...r,
      columns,
      prs: v.prs.filter((p) => p.repo === r.slug),
      stranded: v.stranded.filter((s) => s.repo === r.slug),
    })
  }
  return out
}
