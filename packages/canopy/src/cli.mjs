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
import { traceStore } from './traces.mjs'

export const HELP = `canopy — a local read-only page over cambium's heartbeat and the GitHub queues

usage: canopy [--port <n>] [--host <addr>] [--state <file>] [--queues <file>] [--traces <file>] [--intake <file>] [--config <file>] [--repo <owner/name>]... [--cache <seconds>]
       canopy install [--dry-run] [same flags]   write the launchd agent, serving with those flags
                                                 (start it: oakgreen start canopy; --dry-run prints it)

  --port <n>         listen port (default ${DEFAULT_PORT})
  --host <addr>      listen address (default ${DEFAULT_HOST}; loopback only unless you say otherwise)
  --state <file>     cambium heartbeat (default: paths.heartbeat from the cambium config, else ~/.cambium/state.json)
  --queues <file>    cambium's queue view, read instead of GitHub while fresh (default: paths.queues from the
                     cambium config, else <paths.home>/queues.json)
  --traces <file>    OTLP/JSON spans from cambium's collector (default: <paths.home>/otel/traces.jsonl)
  --intake <file>    mycelium's status file (default: $MYCELIUM_STATUS, else ~/.mycelium/status.json)
  --config <file>    cambium config (default: $CAMBIUM_CONFIG, else ~/.cambium/config.json)
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
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    err(`canopy: --port must be 0-65535, got ${values.port}\n`)
    return 2
  }
  const cacheS = values.cache === undefined ? DEFAULT_TTL_MS / 1000 : Number(values.cache)
  if (!Number.isFinite(cacheS)) {
    err(`canopy: --cache must be a number of seconds, got ${values.cache}\n`)
    return 2
  }
  let settings
  try {
    settings = resolveSettings(
      {
        state: values.state,
        queues: values.queues,
        traces: values.traces,
        intake: values.intake,
        config: values.config,
        repos: values.repo,
      },
      { env },
    )
  } catch (e) {
    err(`canopy: ${/** @type {Error} */ (e).message}\n`)
    return 2
  }
  if (verb === 'install') {
    // The flags were checked above; the agent serves with them exactly as given.
    const drop = new Set(
      tokens
        .filter((t) => t.kind === 'positional' || (t.kind === 'option' && t.name === 'dry-run'))
        .map((t) => t.index),
    )
    const args = argv.filter((_, i) => !drop.has(i))
    return install(args, Boolean(values['dry-run']), { env, home, write, out })
  }
  const host = values.host ?? DEFAULT_HOST
  const gh = client ?? graftClient({ bin: values.graft ?? 'graft' })
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
    intakePath: settings.intakePath,
    briefs: settings.briefs,
  })
  return { server, host, port }
}

/**
 * Write the launchd agent that serves canopy with `args`. Picked up by `oakgreen start canopy`; `oakgreen restart`
 * (and `oakgreen update`) then bring up new code without touching it again.
 *
 * @param {string[]} args @param {boolean} dryRun
 * @param {{ env: Record<string, string | undefined>, home?: string, write?: (path: string, text: string) => void,
 *   out: (s: string) => void }} io
 */
function install(args, dryRun, { env, home: givenHome, write, out }) {
  const home = givenHome ?? env.HOME ?? homedir()
  const text = plist({
    node: process.execPath,
    bin: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'canopy.mjs'),
    args,
    home,
    path: env.PATH ?? '/usr/bin:/bin',
    logFile: logPath(home),
    config: env.CAMBIUM_CONFIG,
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
  out(`wrote ${target}${args.length ? ` (serving with ${args.join(' ')})` : ''}\nstart it: oakgreen start canopy\n`)
  return 0
}
