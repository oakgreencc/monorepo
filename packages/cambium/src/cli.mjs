// @ts-check
/**
 * The verbs. `main(argv, io)` returns an exit code; every side effect beyond
 * the config, the store and the heartbeat file goes through `io`, so tests
 * drive it with fakes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, loadConfig } from './config.mjs'
import { collectGarbage, describe } from './gc.mjs'
import { acquireLock, readHeartbeat, realDeps, runDaemon } from './daemon.mjs'
import { plist, plistPath } from './launchd.mjs'
import { openStore } from './store.mjs'
import { finish, newCtx, startTask } from './tick.mjs'
import { REPO_GRAPHS, runIssue } from './graph-engine.mjs'
import { heartbeatFresh } from './snapshot-file.mjs'
import { createTelemetry } from './tracing.mjs'
import { defaultExec, realUpdater, runUpdate, VERSION } from './update.mjs'

export { VERSION }

export const HELP = `cambium ${VERSION} — the scheduler daemon

  cambium start [--once]                foreground daemon: one tick every tickSeconds
  cambium status [--json]               last heartbeat, mode, workers
  cambium pause                         read + heartbeat only: no transitions, no starts
  cambium resume                        back to running
  cambium drain                         reconcile and watch, start no new workers
  cambium run task --issue <n> [--repo <owner/name>]
                                        claim one q:task issue, run its worker in the foreground, transition
  cambium run <task|pr|dispatch> --issue <n> [--repo <owner/name>] [--follow]
                                        engine "graph": advance the issue in the foreground to the first wait
                                        that is not ready; --follow keeps polling until the graph ends.
                                        dispatch: triage a q:intake issue with a foreground triage worker
  cambium run release-prepare [--repo <owner/name>]
                                        engine "graph": open or refresh the promotion PR now (the day's run)
  cambium run release-promote [--repo <owner/name>] [--issue <pr>]
                                        engine "graph": merge each approved q:promote promotion PR (or only <pr>)
  cambium run rescue [--repo <owner/name>] [--issue <n>]
                                        engine "graph": list the stuck issues and PRs (changes nothing); with
                                        --issue, rescue that one now with a foreground rescue worker
  cambium gc [--dry-run] [--repo <owner/name>]
                                        remove worktrees GitHub holds all of; archive (to ~/.cambium/gc) then
                                        remove stale ones; skip live workers and live Claude Code sessions
  cambium install [--dry-run]           write the launchd agent (KeepAlive); --dry-run prints it
  cambium update [--check] [--version <v>]
                                        install the latest (or <v>) from npm into this global install, then
                                        restart the launchd agent onto it; --check only reports

Common: --config <file> (default $CAMBIUM_CONFIG, then ~/.cambium/config.json)`

/** @param {string[]} argv @param {string} name */
const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
/** @param {string[]} argv @param {string} name */
const has = (argv, name) => argv.includes(name)

/**
 * Run `fn` with `deps.telemetry` set (from the OTEL_* vars in `io.env`, a no-op without them, unless the deps
 * already carry one), shutting it down afterwards so queued spans are exported before the process exits.
 *
 * @template T
 * @param {import('./tick.mjs').Deps} deps @param {IO} io @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTelemetry(deps, io, fn) {
  const own = !deps.telemetry
  if (own) deps.telemetry = await createTelemetry({ env: io.env })
  try {
    return await fn()
  } finally {
    if (own) await deps.telemetry?.shutdown().catch(() => {})
  }
}

/**
 * @typedef {{
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   env: NodeJS.ProcessEnv,
 *   deps?: (config: import('./config.mjs').Config) => import('./tick.mjs').Deps,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   updater?: import('./update.mjs').Updater,
 *   exec?: import('./update.mjs').Exec,
 *   uid?: number,
 * }} IO
 */

/** @param {string[]} argv @param {IO} io @returns {Promise<number>} */
export async function main(argv, io) {
  const [verb, ...rest] = argv
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    io.out(HELP)
    return verb ? 0 : 1
  }
  if (verb === 'version' || verb === '--version') {
    io.out(VERSION)
    return 0
  }
  if (verb === 'update') {
    try {
      const r = await runUpdate(
        { check: has(rest, '--check'), version: flag(rest, '--version') },
        {
          updater: io.updater ?? realUpdater(),
          exec: io.exec ?? defaultExec,
          uid: io.uid ?? process.getuid?.() ?? 0,
          out: io.out,
        },
      )
      return r.ok ? 0 : fail(io, /** @type {string} */ (r.error))
    } catch (err) {
      return fail(io, `update: ${/** @type {Error} */ (err)?.message ?? err}`)
    }
  }
  const cfgPath = configPath(flag(rest, '--config'), io.env)
  const config = loadConfig(cfgPath)
  const depsFor = io.deps ?? ((c) => realDeps(c, { echo: io.out }))

  switch (verb) {
    case 'start': {
      if (!config.repos.length) return fail(io, `no repos in ${cfgPath}; see the README for the config file`)
      const deps = depsFor(config)
      acquireLock(deps.store, deps.procs, deps.pid ?? process.pid)
      await withTelemetry(deps, io, () =>
        runDaemon(deps, {
          signal: io.signal,
          once: has(rest, '--once'),
          reload: () => loadConfig(cfgPath),
          env: io.env,
        }),
      )
      return 0
    }
    case 'status':
      return status(config, io, has(rest, '--json'))
    case 'pause':
    case 'resume':
    case 'drain': {
      const store = openStore(config.paths.db)
      store.setMode(verb === 'pause' ? 'paused' : verb === 'drain' ? 'draining' : 'running')
      io.out(`mode: ${store.mode()}`)
      store.close()
      return 0
    }
    case 'run':
      return runOne(config, rest, io, depsFor)
    case 'gc':
      return gc(config, rest, io, depsFor)
    case 'install':
      return install(cfgPath, config, io, has(rest, '--dry-run'))
  }
  return fail(io, `unknown verb "${verb}"\n\n${HELP}`)
}

/**
 * @param {import('./config.mjs').Config} config @param {string[]} argv @param {IO} io
 * @param {(c: import('./config.mjs').Config) => import('./tick.mjs').Deps} depsFor
 */
async function gc(config, argv, io, depsFor) {
  const repo = flag(argv, '--repo')
  if (repo && !config.repos.some((r) => r.slug === repo)) return fail(io, `no repo ${repo} in the config`)
  const deps = depsFor(config)
  const dryRun = has(argv, '--dry-run')
  try {
    const out = await collectGarbage({ ...deps, now: deps.clock.now }, { dryRun, repo })
    for (const o of out) io.out(describe(o))
    if (!out.length) io.out('no worktrees')
    else if (dryRun) io.out('(dry run: nothing changed)')
    return 0
  } finally {
    deps.store.close?.()
  }
}

/** @param {IO} io @param {string} msg */
function fail(io, msg) {
  io.err(`cambium: ${msg}`)
  return 1
}

/** The mode, without creating the db or its directory when absent. @param {string} path */
function readMode(path) {
  if (!existsSync(path)) return 'running'
  const store = openStore(path)
  try {
    return store.mode()
  } finally {
    store.close()
  }
}

/** @param {import('./config.mjs').Config} config @param {IO} io @param {boolean} json */
function status(config, io, json) {
  const hb = readHeartbeat(config.paths.heartbeat)
  const mode = readMode(config.paths.db)
  const now = (io.now ?? Date.now)()
  const age = hb ? Math.round((now - Date.parse(hb.tick?.finishedAt)) / 1000) : Number.NaN
  const stale = !heartbeatFresh(hb, now)
  if (json) {
    io.out(JSON.stringify({ mode, heartbeat: hb }, null, 2))
    return stale ? 1 : 0
  }
  io.out(`mode: ${mode}`)
  if (!hb) {
    io.out(`no heartbeat at ${config.paths.heartbeat} (daemon never ticked)`)
    return 1
  }
  io.out(
    `last tick #${hb.tick.n} ${age}s ago on ${hb.host} (pid ${hb.pid})${stale ? ' — STALE: daemon not ticking' : ''}`,
  )
  const c = hb.counts
  io.out(
    `queues: intake ${c.intake} · task ${c.task} · human ${c.human} · promote ${c.promote} · running ${c.running} · in review ${c.review}`,
  )
  io.out(`workers: ${c.workers}/${hb.caps.task}`)
  for (const w of hb.workers)
    io.out(
      `  ${w.repo}#${w.issue} ${w.phase} attempt ${w.attempt} pid ${w.pid}${w.alive ? '' : ' (gone)'} ` +
        `${Math.round(w.elapsedMs / 60000)}/${Math.round(w.wallClockMs / 60000)} min · ${w.logs.stdout}`,
    )
  for (const s of hb.steps.filter((s) => !s.ok)) io.out(`  step ${s.name} failed: ${s.error}`)
  return stale ? 1 : 0
}

/**
 * `run task --issue N`: one Task phase in the foreground, with the daemon's
 * claim and transitions, so the daemon sees the same state afterwards. On
 * `engine: "graph"`, `run <graph> --issue N [--follow]` runs the graph runtime
 * in the foreground instead (graph-engine.mjs `runIssue`).
 *
 * @param {import('./config.mjs').Config} config @param {string[]} argv @param {IO} io
 * @param {(config: import('./config.mjs').Config) => import('./tick.mjs').Deps} depsFor
 */
async function runOne(config, argv, io, depsFor) {
  const issueFlag = flag(argv, '--issue')
  const n = Number(issueFlag)
  const graph = argv[0]
  const optional = REPO_GRAPHS.has(graph) && issueFlag === undefined
  if (!graph || graph.startsWith('-') || (!optional && (!Number.isInteger(n) || n <= 0)))
    return fail(
      io,
      'usage: cambium run <graph> --issue <n> [--repo <owner/name>] [--follow]\n' +
        '       cambium run <release-prepare|release-promote> [--repo <owner/name>] [--issue <pr>]\n' +
        '       cambium run rescue [--repo <owner/name>] [--issue <n>]',
    )
  const follow = has(argv, '--follow')
  if (config.engine === 'legacy' && (graph !== 'task' || follow))
    return fail(io, `engine "legacy" runs only \`run task --issue <n>\`; set "engine": "graph" for graphs and --follow`)
  const slug = flag(argv, '--repo') ?? (config.repos.length === 1 ? config.repos[0].slug : undefined)
  if (!slug || !config.repos.some((r) => r.slug === slug))
    return fail(
      io,
      `--repo must name one of the configured repos: ${config.repos.map((r) => r.slug).join(', ') || '(none)'}`,
    )
  const deps = depsFor(config)
  if (config.engine === 'graph') {
    const r = await withTelemetry(deps, io, () =>
      runIssue(deps, {
        graph,
        slug,
        number: optional ? undefined : n,
        follow,
        out: io.out,
        sleep: io.sleep,
        signal: io.signal,
      }),
    )
    return r.ok ? 0 : fail(io, /** @type {string} */ (r.error))
  }
  if (deps.store.worker(slug, n)) return fail(io, `${slug}#${n} already has a tracked worker`)
  const snap = await deps.github.read(slug)
  const issue = snap.issues.get(n)
  if (issue?.state !== 'OPEN' || !issue.labels.includes('q:task'))
    return fail(io, `${slug}#${n} is not an open q:task issue`)
  if (issue.labels.includes('running')) return fail(io, `${slug}#${n} is already running`)
  const started = await startTask(deps, newCtx(deps), slug, issue, snap, { foreground: true })
  if (!started) return fail(io, `${slug}#${n} was not started; see its state comment`)
  io.out(`worker pid ${started.pid} in ${started.worktree}\n  stdout ${started.stdout}\n  stderr ${started.stderr}`)
  const code = await started.exited
  io.out(`worker exited ${code}`)
  const worker = deps.store.worker(slug, n)
  if (!worker) return 0
  const ctx = newCtx(deps)
  await finish(deps, ctx, worker, await deps.github.read(slug))
  const after = (await deps.github.read(slug)).issues.get(n)
  io.out(
    `${slug}#${n}: ${after?.stateComment?.marker.stage ?? 'closed'} · labels ${after?.labels.join(', ') || '(none)'}`,
  )
  return 0
}

/**
 * @param {string} cfgPath @param {import('./config.mjs').Config} config @param {IO} io @param {boolean} dryRun
 */
function install(cfgPath, config, io, dryRun) {
  const home = io.env.HOME ?? homedir()
  const text = plist({
    node: process.execPath,
    bin: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cambium.mjs'),
    configPath: cfgPath,
    logsDir: config.paths.logs,
    home,
    path: io.env.PATH ?? '/usr/bin:/bin',
  })
  const target = plistPath(home)
  if (dryRun) {
    io.out(`# would write ${target}\n${text}`)
    return 0
  }
  if (!config.repos.length) return fail(io, `no repos in ${cfgPath}; write the config first (README)`)
  if (!existsSync(cfgPath)) return fail(io, `${cfgPath} does not exist`)
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(config.paths.logs, { recursive: true })
  writeFileSync(target, text)
  io.out(
    `wrote ${target}\nload it:   launchctl bootstrap gui/$(id -u) ${target}\nunload it: launchctl bootout gui/$(id -u)/${'com.oakgreencc.cambium'}`,
  )
  return 0
}
