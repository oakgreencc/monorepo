// @ts-check
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { withEnvFile } from '@oakgreencc/mycelium/envfile'
import { doctorOk, formatDoctor, runDoctor } from './doctor.mjs'
import { runMigrate } from './migrate.mjs'
import { graftGithub } from './github.mjs'
import { createProxy, DEFAULT_PORT as PROXY_PORT, installProxy, loadRoutes } from './proxy.mjs'
import { runServices } from './services.mjs'
import { runSetup } from './setup.mjs'
import { TOOLS, defaultExec, defaultSpawn, isTool, toolCommand, toolRunner, which } from './tools.mjs'
import { realUpdater, runUpdate } from './update.mjs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const USAGE = `oakgreen ${PKG.version} — the oakgreen stack in one command

  oakgreen doctor [--json] [--repo owner/name] [--config <file>]
  oakgreen setup [--dry-run] [--repo owner/name] [--config <file>]
  oakgreen services [--json]    the stack's launchd agents (otelcol, cambium, mycelium, canopy, proxy) and whether they run
  oakgreen start [service...]   install (if needed), enable and start each (default: all that can be)
  oakgreen stop [service...]    stop each and keep it stopped across logins, until start
  oakgreen restart [service...] new process for each (default: all installed), e.g. after an npm update
  oakgreen reload [service...]  also re-read each agent's plist (its env), waiting for the old one to stop
  oakgreen update [--check]     install the latest oakgreen (and its tools), restart running services, then doctor
  oakgreen proxy [--port n]     serve http://<name>.localhost/ (canopy, jaeger, forest.json's proxy routes) on :80
  oakgreen proxy install [--port n] [--dry-run]   write its launchd agent (oakgreen start does this)
  oakgreen <tool> [args...]     run ${Object.keys(TOOLS).join(', ')}

  oakgreen config migrate [--dry-run]   move this machine's old per-service files into ~/.oakgreen

--config is forest.json (default $OAKGREEN_FOREST_CONFIG_PATH, then ~/.oakgreen/forest.json): the stack's config,
one section per service. Secrets live in ~/.oakgreen/env (0600); state and logs in ~/.oakgreen/<service>/.
`

/**
 * @typedef {{
 *   env?: import('./stack.mjs').Env,
 *   home?: string,
 *   cwd?: string,
 *   now?: () => number,
 *   nodeVersion?: string,
 *   stdout?: (s: string) => void,
 *   stderr?: (s: string) => void,
 *   exec?: import('./tools.mjs').Exec,
 *   spawn?: import('./tools.mjs').Spawn,
 *   resolve?: (id: string) => string,
 *   which?: (name: string) => string | null,
 *   github?: import('./github.mjs').GithubClient,
 *   uid?: number,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   updater?: import('./update.mjs').Updater,
 *   write?: (path: string, text: string) => void,
 *   listen?: (server: import('node:http').Server, port: number) => Promise<number>,
 * }} Ports
 */

const OPTIONS = /** @type {const} */ ({
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  repo: { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
})

/**
 * @param {string[]} argv
 * @param {Ports} [ports]
 * @returns {Promise<number>}
 */
export async function main(argv, ports = {}) {
  const {
    env = process.env,
    home = homedir(),
    cwd = process.cwd(),
    now = Date.now,
    nodeVersion = process.versions.node,
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
    exec = defaultExec,
    spawn = defaultSpawn,
    resolve,
  } = ports
  const commandFor = (/** @type {import('./tools.mjs').Tool} */ t) => toolCommand(t, resolve ? { resolve } : {})
  const runTool = toolRunner(exec, commandFor)
  const [verb, ...rest] = argv

  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    stdout(USAGE)
    return verb ? 0 : 1
  }
  if (verb === '--version' || verb === '-v') {
    stdout(`${PKG.version}\n`)
    return 0
  }
  if (isTool(verb)) {
    const c = commandFor(verb)
    try {
      return await spawn(c.cmd, [...c.args, ...rest], { cwd })
    } catch (err) {
      const e = /** @type {NodeJS.ErrnoException} */ (err)
      if (e.code !== 'ENOENT') throw err
      stderr(`oakgreen: ${verb} not found; install it: npm install -g ${TOOLS[verb]}\n`)
      return 127
    }
  }
  if (['services', 'start', 'stop', 'restart', 'reload'].includes(verb)) {
    const flags = rest.filter((a) => a.startsWith('-'))
    const bad = flags.filter((f) => !(verb === 'services' && f === '--json'))
    if (bad.length) {
      stderr(`oakgreen ${verb}: unknown option ${bad.join(' ')}\n`)
      return 2
    }
    return runServices(
      /** @type {import('./services.mjs').Verb} */ (verb),
      rest.filter((a) => !a.startsWith('-')),
      {
        exec,
        home,
        uid: ports.uid ?? process.getuid?.() ?? 0,
        platform: ports.platform,
        exists: ports.exists,
        sleep: ports.sleep,
        now,
        json: flags.includes('--json'),
        runTool: (tool, args) => runTool(tool, args, { cwd }),
        installSelf: async () => {
          let out = ''
          try {
            const code = installProxy([], {
              home,
              path: env.PATH ?? '/usr/bin:/bin',
              write: ports.write,
              out: (s) => (out += s),
            })
            return { code, stdout: out, stderr: '' }
          } catch (err) {
            return { code: 1, stdout: out, stderr: /** @type {Error} */ (err).message }
          }
        },
      },
      stdout,
      stderr,
    )
  }
  if (verb === 'config') {
    const [sub, ...flags] = rest
    const bad = flags.filter((f) => f !== '--dry-run')
    if (sub !== 'migrate' || bad.length) {
      stderr(`usage: oakgreen config migrate [--dry-run]\n`)
      return 2
    }
    return runMigrate({
      home,
      env,
      dryRun: flags.includes('--dry-run'),
      exec,
      uid: ports.uid ?? process.getuid?.() ?? 0,
      print: (line) => stdout(`${line}\n`),
    })
  }
  if (verb === 'proxy')
    return proxyCommand(rest, { home, env, stdout, stderr, write: ports.write, listen: ports.listen })
  if (verb === 'update') {
    const bad = rest.filter((a) => a !== '--check')
    if (bad.length) {
      stderr(`oakgreen update: unknown argument ${bad.join(' ')}\n`)
      return 2
    }
    try {
      const r = await runUpdate(
        { check: rest.includes('--check') },
        {
          updater: ports.updater ?? realUpdater({ exec, spawn, cwd, current: PKG.version }),
          services: {
            exec,
            home,
            uid: ports.uid ?? process.getuid?.() ?? 0,
            exists: ports.exists,
            sleep: ports.sleep,
            now,
          },
          platform: ports.platform,
          sleep: ports.sleep,
          out: stdout,
        },
      )
      if (!r.ok) stderr(`oakgreen update: ${r.error}\n`)
      return r.ok ? 0 : 1
    } catch (err) {
      stderr(`oakgreen update: ${/** @type {Error} */ (err)?.message ?? err}\n`)
      return 1
    }
  }
  if (verb !== 'doctor' && verb !== 'setup') {
    stderr(`oakgreen: unknown command '${verb}'\n\n${USAGE}`)
    return 2
  }

  let values
  try {
    ;({ values } = parseArgs({ args: rest, options: OPTIONS, strict: true }))
  } catch (err) {
    stderr(`oakgreen ${verb}: ${/** @type {Error} */ (err).message}\n`)
    return 2
  }
  if (values.help) {
    stdout(USAGE)
    return 0
  }
  const github = ports.github ?? graftGithub((tool, args) => runTool(tool, args, { cwd }))
  // mycelium's settings (forest.json, ~/.oakgreen/env) count as its environment, as they do for mycelium itself.
  // A machine not yet migrated, or a broken forest.json, is doctor's to report: the plain environment stands in.
  let merged = env
  try {
    merged = withEnvFile(env, { home, config: values.config }).env
  } catch {}
  const shared = { env: merged, home, cwd, config: values.config, repo: values.repo, github }

  if (verb === 'doctor') {
    const checks = await runDoctor({
      ...shared,
      now: now(),
      nodeVersion,
      engines: PKG.engines.node,
      runTool,
      which: ports.which ?? ((name) => which(name, { env })),
    })
    const ok = doctorOk(checks)
    stdout(values.json ? `${JSON.stringify({ ok, checks }, null, 2)}\n` : formatDoctor(checks))
    return ok ? 0 : 1
  }

  const result = await runSetup({
    ...shared,
    dryRun: values['dry-run'],
    exec,
    print: (line) => stdout(`${line}\n`),
  })
  return result.ok ? 0 : 1
}

/**
 * `oakgreen proxy [--port n]` serves until killed; `oakgreen proxy install [--port n] [--dry-run]` writes the agent.
 * @param {string[]} args
 * @param {{ home: string, env: import('./stack.mjs').Env, stdout: (s: string) => void, stderr: (s: string) => void,
 *   write?: (path: string, text: string) => void, listen?: (server: import('node:http').Server, port: number) => Promise<number> }} io
 * @returns {Promise<number>}
 */
async function proxyCommand(args, { home, env, stdout, stderr, write, listen = serveForever }) {
  const install = args[0] === 'install'
  let values
  try {
    ;({ values } = parseArgs({
      args: install ? args.slice(1) : args,
      options: {
        port: { type: 'string' },
        ...(install ? { 'dry-run': { type: 'boolean', default: false } } : {}),
      },
      strict: true,
    }))
  } catch (err) {
    stderr(`oakgreen proxy: ${/** @type {Error} */ (err).message}\n`)
    return 2
  }
  const port = values.port === undefined ? PROXY_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    stderr(`oakgreen proxy: --port must be 0-65535, got ${values.port}\n`)
    return 2
  }
  if (install) {
    const flags = values.port === undefined ? [] : ['--port', String(port)]
    return installProxy(flags, {
      home,
      path: env.PATH ?? '/usr/bin:/bin',
      dryRun: !!values['dry-run'],
      write,
      out: stdout,
    })
  }
  let loaded
  try {
    loaded = loadRoutes({ home, env })
  } catch (err) {
    stderr(`oakgreen proxy: ${/** @type {Error} */ (err).message}\n`)
    return 1
  }
  const { routes, errors } = loaded
  for (const e of errors) stderr(`oakgreen proxy: ${e}\n`)
  const server = createProxy({ routes, port })
  const suffix = port === 80 ? '' : `:${port}`
  server.once('listening', () => {
    const list = Object.entries(routes).map(([n, p]) => `  http://${n}.localhost${suffix}/ → 127.0.0.1:${p}`)
    stdout(`oakgreen proxy on :${port} (loopback clients only)\n${list.join('\n')}\n`)
  })
  try {
    return await listen(server, port)
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err)
    const why =
      e.code === 'EADDRINUSE'
        ? `port ${port} is in use (lsof -nP -iTCP:${port} -sTCP:LISTEN)`
        : e.code === 'EACCES'
          ? `not allowed to bind port ${port}`
          : e.message
    stderr(`oakgreen proxy: ${why}\n`)
    return 1
  }
}

/** Listen on the wildcard (macOS allows :80 unprivileged only there); resolve when the server closes. */
function serveForever(/** @type {import('node:http').Server} */ server, /** @type {number} */ port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('close', () => resolve(0))
    server.listen({ port, host: '::', ipv6Only: false })
  })
}
