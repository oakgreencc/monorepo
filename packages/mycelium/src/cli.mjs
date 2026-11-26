// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { brokerConfig, openBroker } from './broker.mjs'
import { settingsHint, withEnvFile } from './envfile.mjs'
import { graftClient } from './github.mjs'
import { createIntake } from './intake.mjs'
import { logPath, plist, plistPath } from './launchd.mjs'
import { createNotifier } from './notify.mjs'
import { BACKFILL_HOURS, channelsFromEnv, SOURCES, pass, runLoop, sourceFromEnv } from './runner.mjs'
import { defaultStatePath, fileState, memoryState } from './state.mjs'
import { createStatus, defaultStatusPath, targetOf } from './status.mjs'
import { createTracing, NO_TRACING } from './telemetry.mjs'

export const HELP = `mycelium — intake connectors: external events become q:intake intent issues

  mycelium poll <source> [--dry-run]   one pass over one source (${SOURCES.join(', ')})
  mycelium run [--dry-run]             every configured source, each on its own interval, then the notifier
                                       and the broker
  mycelium notify [--dry-run]          one notifier pass: acknowledge new intents, post outcomes of closed ones
  mycelium broker                      one broker pass: post the outbox to Discord, read thread replies into the inbox
  mycelium install [--dry-run]         write the launchd agent for \`run\` (start it: oakgreen start mycelium)

Flags:
  --dry-run          print envelopes and the issue actions; no writes, no cursor moves
  --repo <o/r>       target repository (else $MYCELIUM_REPO)
  --state <file>     cursor file (else $MYCELIUM_STATE, else ~/.oakgreen/mycelium/state.json)

Settings come from the environment, over ~/.oakgreen/env (credentials, KEY=value), over the "mycelium"
section of ~/.oakgreen/forest.json ($OAKGREEN_FOREST_CONFIG_PATH); see the README. Spans export over
OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set; --dry-run never exports.`

/** @type {import('./intake.mjs').GithubClient} */
const offline = {
  openIntents: async () => [],
  createIssue: async () => {
    throw new Error('dry run: no writes')
  },
  comment: async () => {
    throw new Error('dry run: no writes')
  },
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: import('./http.mjs').Fetch,
 *   github?: import('./intake.mjs').GithubClient,
 *   tracing?: import('./telemetry.mjs').Tracing,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   signal?: AbortSignal,
 *   out?: (line: string) => void,
 *   err?: (line: string) => void,
 *   home?: string,
 *   write?: (path: string, text: string) => void,
 *   writeStatus?: (path: string, text: string) => void,
 * }} [deps]
 */
export async function main(argv, deps = {}) {
  const {
    env = withEnvFile(process.env).env,
    fetch = /** @type {any} */ (globalThis.fetch),
    signal,
    sleep = (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            r(undefined)
          },
          { once: true },
        )
      }),
    now = Date.now,
    out = (l) => process.stdout.write(`${l}\n`),
    err = (l) => process.stderr.write(`${l}\n`),
  } = deps
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      repo: { type: 'string' },
      state: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [verb, name] = positionals
  if (values.help || !verb || verb === 'help') {
    out(HELP)
    return verb || values.help ? 0 : 1
  }
  const dryRun = values['dry-run']
  if (verb === 'install') return install(env, dryRun, deps, out)
  const repo = values.repo ?? env.MYCELIUM_REPO
  if (!repo && !deps.github && !dryRun && verb !== 'broker')
    throw new Error('no repository: pass --repo <owner/name> or set MYCELIUM_REPO')
  const github = deps.github ?? (repo ? graftClient({ repo }) : offline)
  const state = dryRun ? memoryState() : fileState(values.state ?? defaultStatePath(env, deps.home))
  const hours = Number(env.MYCELIUM_BACKFILL_HOURS ?? BACKFILL_HOURS)
  // A dry run files nothing, so it records and exports nothing.
  const tracing = dryRun ? NO_TRACING : (deps.tracing ?? (await createTracing({ env })))
  const ctx = {
    intake: createIntake(github, { tracer: tracing.tracer }),
    state,
    backfillMs: (Number.isFinite(hours) && hours >= 0 ? hours : BACKFILL_HOURS) * 3_600_000,
    dryRun,
    print: (/** @type {any} */ r) => out(JSON.stringify(r)),
  }

  const channels = channelsFromEnv({ env, fetch, sleep })
  // Validated for every verb: a decisions channel that is also intake is refused before anything runs.
  const brokerCfg = brokerConfig(env)
  const broker =
    brokerCfg && !dryRun
      ? openBroker({ env, home: deps.home, tracer: tracing.tracer, log: (r) => err(JSON.stringify(r)) })
      : null
  const brokerJob = broker && brokerCfg ? broker.job({ fetch, sleep, config: brokerCfg }) : null
  const interval = Number(env.MYCELIUM_NOTIFY_INTERVAL_S)
  const notifier =
    Object.keys(channels).length && github.issuesSince
      ? createNotifier({
          github: /** @type {any} */ (github),
          channels,
          state,
          backfillMs: ctx.backfillMs,
          dryRun,
          print: ctx.print,
          intervalMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : undefined,
        })
      : null

  try {
    if (verb === 'notify') {
      if (!notifier)
        throw new Error('notify: no channel is enabled (set MYCELIUM_DISCORD_NOTIFY=true) or no repository')
      err(await notifier.run(now()))
      return 0
    }
    if (verb === 'broker') {
      if (!brokerJob) throw new Error('broker: no decisions channel (set MYCELIUM_DECISIONS_CHANNEL); no dry run')
      err(await brokerJob.run(now()))
      return 0
    }
    if (verb === 'poll') {
      if (!name) throw new Error(`usage: mycelium poll <source>  (${SOURCES.join(', ')})`)
      const tally = await pass(sourceFromEnv(name, { env, fetch, sleep }), { ...ctx, now: now() })
      err(`${tally.source}: ${tally.created} created, ${tally.commented} commented, ${tally.skipped} skipped`)
      return 0
    }
    if (verb === 'run') {
      /** @type {import('./runner.mjs').Source[]} */
      const sources = []
      /** @type {Record<string, string>} */
      const needs = {}
      for (const n of SOURCES) {
        try {
          sources.push(sourceFromEnv(n, { env, fetch, sleep }))
        } catch (e) {
          const message = /** @type {Error} */ (e).message
          needs[n] = message.replace(`${n}: `, '')
          err(`${message} (skipped)`)
        }
      }
      if (sources.length === 0 && !brokerJob) throw new Error('no source is configured')
      const stamp = (/** @type {string} */ l) => err(`${new Date(now()).toISOString()} ${l}`)
      const notifying = notifier ? `notify ${Object.keys(channels).join(', ')}` : 'notify off'
      const brokering = brokerJob ? `broker ${broker?.path}` : 'broker off'
      stamp(
        `mycelium up: ${repo ?? '(no repo)'}; sources ${sources.map((s) => s.name).join(', ')}; ${notifying}; ${brokering}`,
      )
      const status = dryRun
        ? null
        : createStatus({
            path: defaultStatusPath(env, deps.home),
            repo: repo ?? null,
            now,
            ...(deps.writeStatus ? { write: deps.writeStatus } : {}),
            sources: SOURCES.map((n) => {
              const s = sources.find((x) => x.name === n)
              return {
                name: n,
                configured: Boolean(s),
                needs: needs[n] ?? null,
                target: s ? targetOf(n, env) : null,
                intervalMs: s?.intervalMs ?? null,
              }
            }),
            notify: notifier ? { channels: Object.keys(channels), intervalMs: notifier.intervalMs } : null,
          })
      try {
        await runLoop(sources, {
          ...ctx,
          now,
          sleep,
          signal,
          report: stamp,
          jobs: [...(notifier ? [notifier] : []), ...(brokerJob ? [brokerJob] : [])],
          observe: (r) => status?.pass(r),
        })
      } finally {
        status?.stop()
      }
      return 0
    }
    throw new Error(`unknown verb '${verb}'\n\n${HELP}`)
  } finally {
    // Spans are batched: flush them before the process exits. Telemetry
    // trouble is reported, never the reason a command fails.
    broker?.close()
    await tracing.shutdown().catch((e) => err(`tracing: span export failed: ${e?.message || e?.code || e}`))
  }
}

/**
 * Write the launchd agent. Refused when no source is configured: KeepAlive would restart a process that exits at
 * once, every ThrottleInterval, forever.
 *
 * @param {Record<string, string | undefined>} env @param {boolean} dryRun
 * @param {{ home?: string, write?: (path: string, text: string) => void }} deps @param {(l: string) => void} out
 */
function install(env, dryRun, deps, out) {
  const home = deps.home ?? env.HOME ?? homedir()
  const text = plist({
    node: process.execPath,
    bin: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mycelium.mjs'),
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
  const configured = SOURCES.filter((n) => {
    try {
      return Boolean(sourceFromEnv(n, { env, fetch: /** @type {any} */ (null), sleep: async () => {} }))
    } catch {
      return false
    }
  })
  if (!configured.length) throw new Error(`no source is configured; write settings to ${settingsHint(env, home)} first`)
  if (!env.MYCELIUM_REPO) throw new Error(`no repository: set "repo" (MYCELIUM_REPO) in ${settingsHint(env, home)}`)
  const write =
    deps.write ??
    ((/** @type {string} */ p, /** @type {string} */ t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
    })
  write(target, text)
  if (!deps.write) mkdirSync(dirname(logPath(home)), { recursive: true })
  out(`wrote ${target} (sources: ${configured.join(', ')})\nstart it: oakgreen start mycelium`)
  return 0
}
