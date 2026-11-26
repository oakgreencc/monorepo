// @ts-check
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const SLUG = /^[\w.-]+\/[\w.-]+$/

export const expandHome = (/** @type {string} */ p, home = homedir()) =>
  p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p

/**
 * Where the heartbeat lives and which repos to read, from flags first, then
 * cambium's own config file. Only `paths` and `repos[].slug`/`path` are read from it.
 *
 * @param {{ state?: string, config?: string, repos?: string[], traces?: string, intake?: string, queues?: string, logs?: string }} flags
 * @param {{ env?: Record<string, string | undefined>, home?: string, read?: (p: string) => string }} [deps]
 * @returns {{ statePath: string, queuesPath: string, tracesPath: string, logsPath: string, intakePath: string, repos: string[],
 *   configPath: string,
 *   configError: string | null,
 *   briefs: { dir: string, paths: Record<string, string> } }}
 *   `queuesPath`: cambium's queue view (snapshot.mjs): `--queues`, then the config's `paths.queues`, then
 *   `<paths.home>/queues.json`.
 *   `logsPath`: cambium's worker logs: `--logs`, then the config's `paths.logs`, then `<paths.home>/logs`.
 *   `briefs`: where cambium writes session briefs (`<home>/briefs`) and each repo's checkout (`repos[].path`).
 */
export function resolveSettings(
  flags,
  { env = process.env, home = homedir(), read = (p) => readFileSync(p, 'utf8') } = {},
) {
  const configPath = resolve(expandHome(flags.config ?? env.CAMBIUM_CONFIG ?? '~/.cambium/config.json', home))
  /** @type {any} */
  let cfg = {}
  let configError = null
  try {
    cfg = JSON.parse(read(configPath)) ?? {}
  } catch (err) {
    const code = /** @type {any} */ (err)?.code
    if (code !== 'ENOENT' || flags.config || env.CAMBIUM_CONFIG)
      configError = `cambium config ${configPath}: ${/** @type {Error} */ (err).message}`
  }
  const homeDir = typeof cfg?.paths?.home === 'string' ? cfg.paths.home : '~/.cambium'
  const fromConfig = typeof cfg?.paths?.heartbeat === 'string' ? cfg.paths.heartbeat : join(homeDir, 'state.json')
  const statePath = resolve(expandHome(flags.state ?? fromConfig, home))
  const queuesFromConfig = typeof cfg?.paths?.queues === 'string' ? cfg.paths.queues : join(homeDir, 'queues.json')
  const queuesPath = resolve(expandHome(flags.queues ?? queuesFromConfig, home))
  // Where cambium's local collector (otel/otelcol.yaml) writes spans.
  const tracesPath = resolve(expandHome(flags.traces ?? join(homeDir, 'otel', 'traces.jsonl'), home))
  // Where cambium keeps each worker's stdout (stream-json) and prompt.
  const logsFromConfig = typeof cfg?.paths?.logs === 'string' ? cfg.paths.logs : join(homeDir, 'logs')
  const logsPath = resolve(expandHome(flags.logs ?? logsFromConfig, home))
  // mycelium's status file (mycelium's README, Status file).
  const intakePath = resolve(expandHome(flags.intake ?? env.MYCELIUM_STATUS ?? '~/.mycelium/status.json', home))

  const listed = flags.repos?.length
    ? flags.repos
    : (Array.isArray(cfg?.repos) ? cfg.repos : []).map((/** @type {any} */ r) => r?.slug).filter(Boolean)
  for (const r of listed) if (!SLUG.test(r)) throw new Error(`repo must be owner/name, got ${r}`)
  /** @type {Record<string, string>} */
  const paths = {}
  for (const r of Array.isArray(cfg?.repos) ? cfg.repos : [])
    if (isSlug(r?.slug) && typeof r?.path === 'string' && r.path) paths[r.slug] = resolve(expandHome(r.path, home))
  const briefs = { dir: resolve(expandHome(join(homeDir, 'briefs'), home)), paths }
  return {
    statePath,
    queuesPath,
    tracesPath,
    logsPath,
    intakePath,
    repos: [...new Set(/** @type {string[]} */ (listed))],
    configPath,
    configError,
    briefs,
  }
}

export const isSlug = (/** @type {unknown} */ s) => typeof s === 'string' && SLUG.test(s)
