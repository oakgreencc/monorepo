// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertMigrated, FOREST_PATH_ENV, forestPath, readForest, sectionOf } from './forest.mjs'

const SLUG = /^[\w.-]+\/[\w.-]+$/

export const expandHome = (/** @type {string} */ p, home = homedir()) =>
  p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p

/**
 * canopy's settings, from forest.json (forest.mjs): flags first, then the environment, then its `canopy` section,
 * then what cambium's `cambium` section implies, then the defaults under `~/.oakgreen`.
 *
 * The `canopy` section may set `port`, `host`, `cache` (seconds), `graft`, `repos`, and the paths `state`,
 * `queues`, `traces`, `logs`, `intake`. From the `cambium` section only `paths` and `repos[].slug`/`path` are read.
 *
 * @param {{ state?: string, config?: string, repos?: string[], traces?: string, intake?: string, queues?: string, logs?: string }} flags
 * @param {{ env?: Record<string, string | undefined>, home?: string, read?: (p: string) => string | null,
 *   exists?: (p: string) => boolean }} [deps]
 *   `read` may return null or throw ENOENT for a missing file.
 * @returns {{ statePath: string, queuesPath: string, tracesPath: string, logsPath: string, intakePath: string, repos: string[],
 *   configPath: string,
 *   configError: string | null,
 *   serve: { port?: unknown, host?: unknown, cache?: unknown, graft?: unknown },
 *   briefs: { dir: string, paths: Record<string, string> } }}
 *   `queuesPath`: cambium's queue view (snapshot.mjs): `--queues`, then `canopy.queues`, then cambium's
 *   `paths.queues`, then `<paths.home>/queues.json`.
 *   `logsPath`: cambium's worker logs: `--logs`, then `canopy.logs`, then cambium's `paths.logs`, then
 *   `<paths.home>/logs`.
 *   `briefs`: where cambium writes session briefs (`<home>/briefs`) and each repo's checkout (`repos[].path`).
 *   `serve`: the `canopy` section's port, host, cache and graft, for the flags to override.
 *   Throws on a machine still holding the pre-forest files (run `oakgreen config migrate`).
 */
export function resolveSettings(
  flags,
  { env = process.env, home = env.HOME ?? homedir(), read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {},
) {
  const configPath = forestPath(flags.config, { env, home })
  const readOrNull = (/** @type {string} */ p) => {
    try {
      return read(p)
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'ENOENT') return null
      throw err
    }
  }
  /** @type {Record<string, any>} */
  let forest = {}
  let configError = null
  try {
    const r = readForest(configPath, readOrNull)
    forest = r.forest
    if (!r.present && (flags.config || env[FOREST_PATH_ENV])) configError = `forest.json ${configPath}: not found`
  } catch (err) {
    configError = /** @type {Error} */ (err).message
  }
  for (const service of ['canopy', 'cambium']) assertMigrated(service, forest, { env, home }, exists)
  /** @type {any} */
  let cfg = {}
  /** @type {any} */
  let own = {}
  try {
    cfg = sectionOf(forest, 'cambium')
    own = sectionOf(forest, 'canopy')
  } catch (err) {
    configError = `${configPath}: ${/** @type {Error} */ (err).message}`
  }
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : undefined)
  const at = (/** @type {string} */ p) => resolve(expandHome(p, home))
  const homeDir = str(cfg?.paths?.home) ?? '~/.oakgreen/cambium'
  const statePath = at(flags.state ?? str(own.state) ?? str(cfg?.paths?.heartbeat) ?? join(homeDir, 'state.json'))
  const queuesPath = at(flags.queues ?? str(own.queues) ?? str(cfg?.paths?.queues) ?? join(homeDir, 'queues.json'))
  // Where cambium's local collector (otel/otelcol.yaml) writes spans.
  const tracesPath = at(flags.traces ?? str(own.traces) ?? join(homeDir, 'otel', 'traces.jsonl'))
  // Where cambium keeps each worker's stdout (stream-json) and prompt.
  const logsPath = at(flags.logs ?? str(own.logs) ?? str(cfg?.paths?.logs) ?? join(homeDir, 'logs'))
  // mycelium's status file (mycelium's README, Status file).
  const intakePath = at(
    flags.intake ??
      str(env.MYCELIUM_STATUS) ??
      str(own.intake) ??
      str(forest.mycelium?.status) ??
      '~/.oakgreen/mycelium/status.json',
  )

  const ownRepos = Array.isArray(own.repos) ? own.repos : []
  const listed = flags.repos?.length
    ? flags.repos
    : ownRepos.length
      ? ownRepos
      : (Array.isArray(cfg?.repos) ? cfg.repos : []).map((/** @type {any} */ r) => r?.slug).filter(Boolean)
  for (const r of listed) if (!SLUG.test(r)) throw new Error(`repo must be owner/name, got ${r}`)
  /** @type {Record<string, string>} */
  const paths = {}
  for (const r of Array.isArray(cfg?.repos) ? cfg.repos : [])
    if (isSlug(r?.slug) && typeof r?.path === 'string' && r.path) paths[r.slug] = at(r.path)
  const briefs = { dir: at(join(homeDir, 'briefs')), paths }
  return {
    statePath,
    queuesPath,
    tracesPath,
    logsPath,
    intakePath,
    repos: [...new Set(/** @type {string[]} */ (listed))],
    configPath,
    configError,
    serve: { port: own.port, host: own.host, cache: own.cache, graft: own.graft },
    briefs,
  }
}

export const isSlug = (/** @type {unknown} */ s) => typeof s === 'string' && SLUG.test(s)
