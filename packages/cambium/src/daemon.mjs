// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { applyReload } from './config.mjs'
import { gcRunner } from './gc.mjs'
import { graftGitHub } from './github.mjs'
import { openStore } from './store.mjs'
import { QUEUES_VERSION, writeQueues } from './queue-view.mjs'
import { daemonFeed, readSnapshots, writeSnapshots } from './snapshot-file.mjs'
import { tick } from './tick.mjs'
import { autoUpdate, realUpdater } from './update.mjs'
import { processSpawner, realProcs } from './workers.mjs'

/** @param {string} path @param {unknown} state */
export function writeHeartbeat(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/** @param {string} path @returns {import('./tick.mjs').HeartbeatState | null} */
export function readHeartbeat(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The most characters one log entry's message keeps. */
export const LOG_MSG_MAX = 1000

/**
 * A message fit for one log line: an HTML page (a 5xx from GitHub's edge, passed through an error) becomes its
 * `<title>`, whitespace runs (newlines included) become one space, and the rest is cut at {@link LOG_MSG_MAX}.
 * @param {string} msg
 */
export function oneLine(msg) {
  let s = String(msg ?? '')
  s = s.replace(/<(!doctype html|html)[\s\S]*?(<\/html>|$)/gi, (page) => {
    const title = page
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
    return title ? `(HTML page: ${title})` : '(HTML page)'
  })
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > LOG_MSG_MAX ? `${s.slice(0, LOG_MSG_MAX)}…` : s
}

/**
 * Each entry is one line ({@link oneLine}), so the log stays greppable whatever an error carried.
 * @param {{ file?: string | null, maxBytes?: number, keep?: number, now?: () => number,
 *   echo?: (line: string) => void }} [opts]
 */
export function makeLogger({
  file = null,
  maxBytes = 10 * 1024 * 1024,
  keep = 100,
  now = Date.now,
  echo = console.log,
} = {}) {
  /** @type {import('./tick.mjs').Event[]} */
  const ring = []
  if (file) mkdirSync(dirname(file), { recursive: true })
  /** @type {import('./tick.mjs').Deps['log']} */
  const log = (level, raw, where = {}) => {
    const msg = oneLine(raw)
    const event = { at: new Date(now()).toISOString(), level, msg, ...where }
    ring.push(event)
    if (ring.length > keep) ring.shift()
    const at = where.repo ? ` ${where.repo}${where.issue ? `#${where.issue}` : ''}` : ''
    const line = `${event.at} ${level.padEnd(5)}${at} ${msg}`
    echo(line)
    if (!file) return
    try {
      if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
      appendFileSync(file, `${line}\n`)
    } catch {}
  }
  return { log, events: () => [...ring] }
}

/**
 * @param {import('./config.mjs').Config} config
 * @param {{ echo?: (line: string) => void }} [opts]
 * @returns {import('./tick.mjs').Deps & { store: import('./store.mjs').Store }}
 */
export function realDeps(config, { echo } = {}) {
  const store = openStore(config.paths.db)
  const { log, events } = makeLogger({
    file: join(config.paths.logs, 'cambium.log'),
    maxBytes: config.logs.daemonMaxBytes,
    echo,
  })
  const spawner = processSpawner({ config })
  /** @type {import('./queue-view.mjs').QueuesFile | null} */
  let lastQueues = /** @type {any} */ (readHeartbeat(config.paths.queues))
  if (lastQueues?.version !== QUEUES_VERSION) lastQueues = null
  return {
    config,
    clock: { now: Date.now },
    github: graftGitHub({ config }),
    store,
    spawner,
    procs: realProcs,
    gc: gcRunner({ config, store, spawner, procs: realProcs, now: Date.now }, log),
    briefs: { dir: join(config.paths.home, 'briefs') },
    log,
    events,
    heartbeat: (state) => writeHeartbeat(config.paths.heartbeat, state),
    queues: {
      prev: () => lastQueues,
      write: (view) => {
        writeQueues(config.paths.queues, view)
        lastQueues = view
      },
    },
    snapshots: { write: (file) => writeSnapshots(config.paths.snapshots, file) },
    daemonFeed: daemonFeed({
      readHeartbeat: () => readHeartbeat(config.paths.heartbeat),
      readSnapshots: () => readSnapshots(config.paths.snapshots),
      now: Date.now,
    }),
    daemonStartedAt: Date.now(),
    pid: process.pid,
    updater: realUpdater(),
  }
}

/**
 * @param {import('./store.mjs').Store} store @param {import('./workers.mjs').Procs} procs @param {number} pid
 */
export function acquireLock(store, procs, pid) {
  const holder = Number(store.get('daemon.pid'))
  if (holder && holder !== pid && procs.alive(holder))
    throw new Error(`another cambium daemon is running (pid ${holder})`)
  store.set('daemon.pid', String(pid))
}

/**
 * Before each tick, `reload` re-reads the config and {@link applyReload} applies what changed. A file that does
 * not load keeps the running config; that warning, and "restart to apply" for a restart-only key, is logged once
 * per distinct message rather than every tick.
 *
 * @param {import('./tick.mjs').Deps} deps
 * @param {{
 *   signal?: AbortSignal, wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>, once?: boolean,
 *   reload?: () => import('./config.mjs').Config, env?: Record<string, string | undefined>,
 * }} [opts]
 *   After each tick, with `update.auto`, {@link autoUpdate} may install a newer cambium; the loop then ends so
 *   the process exits and launchd starts the new version.
 */
export async function runDaemon(
  deps,
  { signal, wait = (ms, s) => sleep(ms, undefined, { signal: s }), once = false, reload, env = process.env } = {},
) {
  let n = 0
  /** @type {string | null} */
  let warned = null
  const reloadConfig = () => {
    if (!reload) return
    /** @type {string | null} */
    let warning = null
    try {
      const { applied, restart } = applyReload(deps.config, reload())
      if (applied.length) deps.log('info', `config reloaded: ${applied.join(', ')}`)
      if (restart.length) warning = `config: ${restart.join(', ')} changed; restart cambium to apply`
    } catch (err) {
      warning = `config not reloaded, keeping the running one: ${/** @type {Error} */ (err)?.message ?? err}`
    }
    if (warning && warning !== warned) deps.log('warn', warning)
    warned = warning
  }
  deps.log('info', `cambium up on ${deps.config.host}: ${deps.config.repos.map((r) => r.slug).join(', ')}`)
  while (!signal?.aborted) {
    if (n > 0) reloadConfig()
    deps.tickNumber = ++n
    try {
      await tick(deps)
    } catch (err) {
      deps.log('error', `tick ${n}: ${/** @type {Error} */ (err)?.message ?? err}`)
    }
    // Every span is ended within its tick; export them now rather than when the batch fills.
    await deps.telemetry?.flush().catch((err) => deps.log('warn', `telemetry flush: ${err?.message ?? err}`))
    if (deps.updater && !signal?.aborted) {
      const installed = await autoUpdate(deps, { updater: deps.updater, env, now: deps.clock.now() })
      if (installed) break
    }
    if (once) break
    try {
      await wait(deps.config.tickSeconds * 1000, signal)
    } catch {
      break
    }
  }
  deps.log('info', 'cambium stopping; workers keep running and are re-adopted on restart')
  return n
}
