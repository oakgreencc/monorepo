// @ts-check
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { isSlug } from './config.mjs'
import { costByDay, withCosts } from './cost.mjs'
import { readHeartbeat as defaultReadHeartbeat } from './heartbeat.mjs'
import { readIntake as defaultReadIntake, intakeActivity } from './intake.mjs'
import { PAGE } from './page.mjs'
import { emptyColumns } from './queues.mjs'
import { SESSION_ID } from './sessions.mjs'
import { summarize, traceDetail, traceIndex, traceList } from './traces.mjs'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4317
export const POLL_MS = 5000
/** Days of cost-by-phase the page shows, today included. */
export const COST_DAYS_SHOWN = 7

/**
 * @typedef {{
 *   statePath: string,
 *   repos: string[],
 *   queues: { get(slugs: string[]): Promise<import('./queues.mjs').QueueView & { source?: string, fallback?: string | null }>, ttlMs?: number },
 *   readHeartbeat?: (path: string) => Promise<import('./heartbeat.mjs').Heartbeat>,
 *   intakePath?: string,
 *   readIntake?: (path: string, o: { now: number }) => Promise<import('./intake.mjs').IntakeStatus>,
 *   now?: () => number,
 *   host?: string,
 *   notes?: string[],
 *   traces?: import('./traces.mjs').TraceStore,
 *   sessions?: import('./sessions.mjs').SessionLogs,
 *   issues?: { get(slug: string, number: number): Promise<import('./github.mjs').IssueRead> },
 *   briefs?: Briefs,
 * }} AppOptions
 * @typedef {{ dir: string, paths: Record<string, string>, exists?: (path: string) => boolean }} Briefs
 *   cambium's session briefs: `<dir>/<owner>__<repo>/issue-<n>.md`, written for the `q:human` items worth an
 *   interactive session. `paths`: each repo's checkout, for the `cd` in the command.
 */

/** A POSIX shell word: as is when safe, else single-quoted. @param {string} s */
export const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * The session brief cambium wrote for this item, and the command that starts a session with it; null when there is
 * none (not a session candidate, or cambium has not written it yet).
 *
 * @param {Briefs} briefs @param {{ repo: string, number: number }} item
 * @returns {{ path: string, command: string } | null}
 */
export function briefOf({ dir, paths, exists = existsSync }, { repo, number }) {
  const path = join(dir, repo.replace('/', '__'), `issue-${number}.md`)
  if (!exists(path)) return null
  const run = `claude "$(cat ${shellWord(path)})"`
  const cwd = paths[repo]
  return { path, command: cwd ? `cd ${shellWord(cwd)} && ${run}` : run }
}

/**
 * The command that starts or resumes a decision in claude (the plugin's `/oakgreen:decide`), in the repo's checkout
 * when cambium's config says where it is.
 *
 * @param {Record<string, string>} paths @param {{ repo: string, number: number }} item
 */
export function decideCommandOf(paths, { repo, number }) {
  const run = `claude "/oakgreen:decide ${repo}#${number}"`
  const cwd = paths[repo]
  return cwd ? `cd ${shellWord(cwd)} && ${run}` : run
}

/** A decision item: `ask:decide`, or a `decide` summary from cambium's queue view. @param {import('./queues.mjs').Item} i */
const isDecide = (i) => i.labels.includes('ask:decide') || !!i.decide

/** What mycelium filed is worked out again once this old, as the Graphs flow is. */
const ACTIVITY_FRESH_MS = 15_000
/** @type {WeakMap<import('./traces.mjs').TraceFile, { at: number, activity: ReturnType<typeof intakeActivity> }>} */
const activities = new WeakMap()
/** @param {import('./traces.mjs').TraceFile | undefined} f @param {number} now */
function activityOf(f, now) {
  if (f?.status !== 'ok') return null
  const hit = activities.get(f)
  if (hit && now >= hit.at && now - hit.at < ACTIVITY_FRESH_MS) return hit.activity
  const activity = intakeActivity(f.traces, now)
  activities.set(f, { at: now, activity })
  return activity
}

/** Repos named on the command line or in cambium's config, else the ones the heartbeat lists. */
const reposFor = (/** @type {string[]} */ fixed, /** @type {import('./heartbeat.mjs').Heartbeat} */ hb) =>
  fixed.length ? fixed : [...new Set((hb.data?.repos ?? []).map((/** @type {any} */ r) => r.slug).filter(isSlug))]

/**
 * The `/api/state` document.
 *
 * @param {AppOptions} opts
 */
export async function buildState({
  statePath,
  repos,
  queues,
  readHeartbeat = defaultReadHeartbeat,
  now = Date.now,
  notes = [],
  traces,
  briefs,
  intakePath,
  readIntake = defaultReadIntake,
}) {
  const [heartbeat, traceFile, intake] = await Promise.all([
    readHeartbeat(statePath),
    traces?.read(),
    intakePath ? readIntake(intakePath, { now: now() }) : null,
  ])
  const slugs = reposFor(repos, heartbeat)
  const read = slugs.length
    ? await queues.get(slugs)
    : {
        repos: [],
        columns: emptyColumns(),
        prs: [],
        stranded: [],
        fetchedAt: null,
        cached: false,
        source: null,
        fallback: null,
      }
  const github = withCosts(read, heartbeat.data)
  // Copies: the queue answer is cached and shared between requests.
  const human = github.columns.human.map((i) => {
    const brief = briefs ? briefOf(briefs, i) : null
    const decideCommand = isDecide(i) ? decideCommandOf(briefs?.paths ?? {}, i) : null
    return brief || decideCommand
      ? { ...i, ...(brief ? { brief } : {}), ...(decideCommand ? { decideCommand } : {}) }
      : i
  })
  return {
    now: new Date(now()).toISOString(),
    pollMs: POLL_MS,
    cacheMs: queues.ttlMs ?? null,
    notes: slugs.length
      ? notes
      : [...notes, 'no repositories to read: pass --repo owner/name or set repos in cambium config'],
    heartbeat,
    github: { ...github, columns: { ...github.columns, human } },
    traces: traceFile ? traceIndex(traceFile, now()) : null,
    intake: intake && { ...intake, activity: activityOf(traceFile, now()) },
    cost: { days: costByDay(heartbeat.data, now(), COST_DAYS_SHOWN), flagUsd: heartbeat.data?.costFlagUsd ?? null },
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

/** Hostname of a Host header, without port or IPv6 brackets. */
export function hostnameOf(/** @type {string | undefined} */ header) {
  if (!header) return ''
  const h = header.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  return h.replace(/:\d+$/, '')
}

/**
 * Request handler. Refuses foreign Host headers so a page elsewhere cannot
 * read local paths through DNS rebinding.
 *
 * @param {AppOptions} opts
 * @returns {import('node:http').RequestListener}
 */
export function createHandler(opts) {
  const allowed = new Set([...LOOPBACK, ...(opts.host ? [opts.host.toLowerCase()] : [])])
  const anyHost = opts.host === '0.0.0.0' || opts.host === '::'
  return async (req, res) => {
    const send = (/** @type {number} */ status, /** @type {string} */ type, /** @type {string} */ body) => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (!anyHost && !allowed.has(hostnameOf(req.headers.host)))
      return send(403, 'text/plain; charset=utf-8', 'forbidden host\n')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'read-only\n')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/' || path === '/index.html') return send(200, 'text/html; charset=utf-8', PAGE)
    const json = async (/** @type {() => Promise<unknown>} */ fn, missing = 'no such trace') => {
      try {
        const body = await fn()
        if (body === null) return send(404, 'application/json; charset=utf-8', JSON.stringify({ error: missing }))
        return send(200, 'application/json; charset=utf-8', JSON.stringify(body))
      } catch (err) {
        return send(
          500,
          'application/json; charset=utf-8',
          JSON.stringify({ error: /** @type {Error} */ (err).message }),
        )
      }
    }
    if (path === '/api/state') return json(() => buildState(opts))
    const { traces } = opts
    if (traces && path === '/api/traces') return json(async () => traceList(await traces.read()))
    const one = /^\/api\/traces\/([0-9a-f]{32})$/.exec(path)
    if (traces && one) return json(async () => traceDetail(await traces.read(), one[1]))
    const ses = /^\/api\/traces\/([0-9a-f]{32})\/sessions\/([0-9a-f-]{36})$/.exec(path)
    if (traces && opts.sessions && ses && SESSION_ID.test(ses[2])) {
      const { sessions } = opts
      // Only a session the trace names: the page is not a general-purpose reader of local files.
      return json(async () => {
        const f = await traces.read()
        const spans = f.traces.get(ses[1])
        if (!spans?.some((s) => s.name === 'claude.session' && s.attrs['claude.session_id'] === ses[2])) return null
        const { repo, issue } = summarize(ses[1], spans)
        return sessions.find({ repo, issue, sessionId: ses[2] })
      }, 'no such session in this trace')
    }
    const issue = /^\/api\/issue\/([\w.-]+)\/([\w.-]+)\/([1-9]\d{0,9})$/.exec(path)
    if (opts.issues && issue) {
      const { issues, readHeartbeat = defaultReadHeartbeat } = opts
      const slug = `${issue[1]}/${issue[2]}`
      // Only the repos canopy watches: the page is not a general-purpose proxy onto graft.
      return json(async () => {
        if (!reposFor(opts.repos, await readHeartbeat(opts.statePath)).includes(slug)) return null
        const read = await issues.get(slug, Number(issue[3]))
        return read.issue ? read : null
      }, `no such issue in a watched repo: ${slug}#${issue[3]}`)
    }
    return send(404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

/** @param {AppOptions} opts */
export const createApp = (opts) => createServer(createHandler(opts))
