// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveSettings } from './config.mjs'
import { cachedIssues, cachedQueues, DEFAULT_TTL_MS, graftClient, MIN_TTL_MS } from './github.mjs'
import { logPath, plist, plistPath } from './launchd.mjs'
import { createApp, DEFAULT_HOST, DEFAULT_PORT } from './server.mjs'
import { snapshotQueues } from './snapshot.mjs'
import { sessionLogs } from './sessions.mjs'
import { traceStore } from './traces.mjs'

export const HELP = `canopy — a local read-only page over cambium's heartbeat and the GitHub queues

usage: canopy [--port <n>] [--host <addr>] [--state <file>] [--queues <file>] [--traces <file>] [--logs <dir>] [--intake <file>] [--config <file>] [--repo <owner/name>]... [--cache <seconds>]
       canopy install [--dry-run]   write the launchd agent; it takes no flags, settings come from forest.json
                                    (start it: oakgreen start canopy; --dry-run prints it)

Every flag may instead be set in the "canopy" section of forest.json (port, host, state, queues, traces, logs,
intake, repos, cache, graft); a flag wins. Defaults come from the "cambium" section and ~/.oakgreen.

  --port <n>         listen port (default ${DEFAULT_PORT})
  --host <addr>      listen address (default ${DEFAULT_HOST}; loopback only unless you say otherwise)
  --state <file>     cambium heartbeat (default: cambium's paths.heartbeat, else ~/.oakgreen/cambium/state.json)
  --queues <file>    cambium's queue view, read instead of GitHub while fresh (default: cambium's paths.queues,
                     else <paths.home>/queues.json)
  --traces <file>    OTLP/JSON spans from cambium's collector (default: <paths.home>/otel/traces.jsonl)
  --logs <dir>       cambium's worker logs, for session transcripts (default: cambium's paths.logs, else
                     <paths.home>/logs)
  --intake <file>    mycelium's status file (default: $MYCELIUM_STATUS, else ~/.oakgreen/mycelium/status.json)
  --config <file>    forest.json (default: $OAKGREEN_FOREST_CONFIG_PATH, else ~/.oakgreen/forest.json)
  --repo <o/n>       repository to show queues for; repeatable (default: the config's repos, else the heartbeat's)
  --cache <seconds>  how long a GitHub answer is reused, when canopy reads GitHub itself (default ${DEFAULT_TTL_MS / 1000}, minimum ${MIN_TTL_MS / 1000})
  --graft <cmd>      graft binary (default: graft on PATH)

Reads only. Open http://<host>:<port>/ ; the page polls /api/state (and /api/traces on the Traces tab, /api/issue/<owner>/<name>/<n> for the Inbox pane).
`

/**
 * Parse flags and build the server; the caller listens. Returns a number
 * (exit code) when there is nothing to serve.
 *
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   client?: import('./github.mjs').GithubClient,
 *   out?: (s: string) => void,
 *   err?: (s: string) => void,
 *   home?: string,
 *   write?: (path: string, text: string) => void,
 * }} [deps]
 * @returns {number | { server: import('node:http').Server, host: string, port: number }}
 */
export function main(
  argv,
  {
    env = process.env,
    client,
    out = (s) => process.stdout.write(s),
    err = (s) => process.stderr.write(s),
    home,
    write,
  } = {},
) {
  let values
  let positionals
  let tokens
  try {
    ;({ values, positionals, tokens } = parseArgs({
      args: argv,
      allowPositionals: true,
      tokens: true,
      options: {
        'dry-run': { type: 'boolean' },
        port: { type: 'string' },
        host: { type: 'string' },
        state: { type: 'string' },
        queues: { type: 'string' },
        traces: { type: 'string' },
        logs: { type: 'string' },
        intake: { type: 'string' },
        config: { type: 'string' },
        repo: { type: 'string', multiple: true },
        cache: { type: 'string' },
        graft: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }))
  } catch (e) {
    err(`canopy: ${/** @type {Error} */ (e).message}\n\n${HELP}`)
    return 2
  }
  if (values.help) {
    out(HELP)
    return 0
  }
  const [verb, ...extra] = positionals
  if ((verb && verb !== 'install') || extra.length) {
    err(`canopy: unexpected argument ${verb === 'install' ? extra[0] : verb}\n\n${HELP}`)
    return 2
  }
  if (values['dry-run'] && verb !== 'install') {
    err('canopy: --dry-run only goes with install\n')
    return 2
  }
  if (verb === 'install') {
    const flags = tokens.filter((t) => t.kind === 'option' && t.name !== 'dry-run').map((t) => t.rawName)
    if (flags.length) {
      err(`canopy: install takes no serve flags (${flags.join(' ')}); set them in forest.json's "canopy" section\n`)
      return 2
    }
    return install(Boolean(values['dry-run']), { env, home, write, out })
  }
  let settings
  try {
    settings = resolveSettings(
      {
        state: values.state,
        queues: values.queues,
        traces: values.traces,
        logs: values.logs,
        intake: values.intake,
        config: values.config,
        repos: values.repo,
      },
      { env, ...(home ? { home } : {}) },
    )
  } catch (e) {
    err(`canopy: ${/** @type {Error} */ (e).message}\n`)
    return 2
  }
  const { serve } = settings
  const port = Number(values.port ?? serve.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    err(`canopy: port must be 0-65535, got ${values.port ?? JSON.stringify(serve.port)}\n`)
    return 2
  }
  const cacheS = Number(values.cache ?? serve.cache ?? DEFAULT_TTL_MS / 1000)
  if (!Number.isFinite(cacheS)) {
    err(`canopy: cache must be a number of seconds, got ${values.cache ?? JSON.stringify(serve.cache)}\n`)
    return 2
  }
  const host = values.host ?? (typeof serve.host === 'string' ? serve.host : DEFAULT_HOST)
  const gh = client ?? graftClient({ bin: values.graft ?? (typeof serve.graft === 'string' ? serve.graft : 'graft') })
  const queues = snapshotQueues({
    path: settings.queuesPath,
    github: cachedQueues({ client: gh, ttlMs: cacheS * 1000 }),
  })
  const issues = cachedIssues({ client: gh, ttlMs: cacheS * 1000 })
  const notes = settings.configError ? [settings.configError] : []
  const server = createApp({
    statePath: settings.statePath,
    repos: settings.repos,
    queues,
    issues,
    host,
    notes,
    traces: traceStore({ path: settings.tracesPath }),
    sessions: sessionLogs({ logs: settings.logsPath }),
    intakePath: settings.intakePath,
    briefs: settings.briefs,
  })
  return { server, host, port }
}

/**
 * Write the launchd agent that serves canopy. It carries no settings: canopy reads forest.json at start. Picked up by
 * `oakgreen start canopy`; `oakgreen restart` (and `oakgreen update`) then bring up new code and settings.
 *
 * @param {boolean} dryRun
 * @param {{ env: Record<string, string | undefined>, home?: string, write?: (path: string, text: string) => void,
 *   out: (s: string) => void }} io
 */
function install(dryRun, { env, home: givenHome, write, out }) {
  const home = givenHome ?? env.HOME ?? homedir()
  const text = plist({
    node: process.execPath,
    bin: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'canopy.mjs'),
    home,
    path: env.PATH ?? '/usr/bin:/bin',
    logFile: logPath(home),
    forest: env.OAKGREEN_FOREST_CONFIG_PATH,
  })
  const target = plistPath(home)
  if (dryRun) {
    out(`# would write ${target}\n${text}`)
    return 0
  }
  const put =
    write ??
    ((/** @type {string} */ p, /** @type {string} */ t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
    })
  put(target, text)
  if (!write) mkdirSync(dirname(logPath(home)), { recursive: true })
  out(`wrote ${target}\nstart it: oakgreen start canopy (settings: forest.json's "canopy" section)\n`)
  return 0
}
