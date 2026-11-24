// @ts-check
/**
 * The one config file. Every field is optional except `repos`; `loadConfig`
 * merges the file over {@link defaults} and resolves `~` in paths.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * @typedef {{
 *   enabled: boolean, time: string, from: string, to: string, check: string | null, readEveryMinutes: number,
 * }} RepoRelease
 *   The promotion PR (`engine: "graph"`): `from` (default: the repo's `baseBranch`) is promoted into `to`
 *   (default `main`) once a day at `time`. `enabled`/`time` default to the top-level `release`. Off when
 *   `from === to`. `check` (default: the repo's `requiredCheck`): the check that must be green on the `from`
 *   commit a release is cut at; `null` cuts at the tip. `readEveryMinutes` (default: the top-level `release`, 5):
 *   how often the snapshot reads the promotion part (github.mjs); between reads the last answer is kept, and a
 *   merge into `from` or `to` forces a read on the next tick. `0` reads every tick.
 * @typedef {'none' | 'green'} MergePolicy
 *   Who merges a Task PR. `none`: not cambium (a merge queue, auto-merge, or a human; past `mergeQueueMinutes`
 *   the issue goes to `q:human`). `green`: cambium, once its checks are green, through `graft pr merge --auto`
 *   (so graft's merge policy still decides). `green` needs `engine: "graph"`.
 * @typedef {{
 *   slug: string, path: string, baseBranch: string, release: RepoRelease, merge: MergePolicy,
 *   requiredCheck: string | null, phases: RepoPhases, watch: Watch[],
 * }} Repo
 *   `requiredCheck` (default `ci`): the check whose runs on `baseBranch` say whether the base is green (see
 *   base-health.mjs); `null` turns the red-base gate and repair off for the repo. `phases`: per-phase overrides of
 *   `wallClockMinutes` and `maxTurns` for this repo's workers ({@link capsFor}). `watch`: workflows whose latest
 *   run on a branch must be green (watch.mjs).
 * @typedef {Partial<Record<'task' | 'dispatch' | 'rescue', { wallClockMinutes?: number, maxTurns?: number }>>} RepoPhases
 * @typedef {{ workflow: string, branch: string, issue: boolean }} Watch
 *   `workflow`: the workflow file name (`release.yml`) or its id. `branch` (default: the repo's `baseBranch`).
 *   `issue` (default true): a failing run opens one `q:human` issue, closed once the workflow is green again.
 * @typedef {{ cap: number, wallClockMinutes: number, maxTurns: number, maxAttempts: number }} PhaseCaps
 * @typedef {PhaseCaps & { maxReworks: number }} TaskCaps
 *   `maxReworks`: how many times the PR graph sends one PR back to a worker (red CI, a conflict, changes
 *   requested) before it goes to `q:human`. Each rework gets a fresh `maxAttempts`.
 * @typedef {{
 *   host: string,
 *   engine: 'legacy' | 'graph',
 *   tickSeconds: number,
 *   stepTimeoutSeconds: number,
 *   fullReadEvery: number,
 *   repos: Repo[],
 *   phases: {
 *     task: TaskCaps, dispatch: PhaseCaps & { maxRounds: number, deferHours: number, maxDefers: number },
 *     rescue: PhaseCaps,
 *   },
 *   mergeQueueMinutes: number,
 *   mergeStallMinutes: number,
 *   watchEveryMinutes: number,
 *   merge: MergePolicy,
 *   priorityLabels: string[],
 *   release: { enabled: boolean, time: string, readEveryMinutes: number },
 *   reaper: { everyMinutes: number, staleMinutes: number, orphanDays: number },
 *   retriage: { enabled: boolean, time: string, maxSkipDays: number },
 *   intake: { adopt: boolean, ignoreLabels: string[] },
 *   rescue: RescueConfig,
 *   paths: { home: string, db: string, heartbeat: string, queues: string, logs: string },
 *   logs: { keepPerIssue: number, daemonMaxBytes: number },
 *   graft: { command: string, app: string | null, botLogin: string | null },
 *   worker: { command: string, args: string[], graftApp: string | null, fetch: boolean, env: Record<string, string> },
 *   update: { auto: boolean, checkMinutes: number },
 *   gc: GcConfig,
 *   costFlagUsd: number,
 * }} Config
 *   `fullReadEvery`: a repo whose probe shows no change reuses its last snapshot, but at most `fullReadEvery - 1`
 *   ticks running: every `fullReadEvery`th tick reads it in full regardless (tick.mjs `read`). 1: always read.
 *   `mergeStallMinutes`: an agent PR whose auto-merge has been armed this long, with green checks, while GitHub
 *   still reports it BLOCKED (a rule cambium cannot see holds it) goes to `q:human` with GitHub's state. 0: off.
 *   `watchEveryMinutes`: how often each repo's `watch` workflows are read (watch.mjs).
 *   `intake.adopt`: an open issue in no queue that cambium has never touched (no state comment, no agent PR naming
 *   it) is labelled `q:intake`, so an issue filed without the label is triaged instead of ignored (adopt.mjs).
 *   `intake.ignoreLabels`: issues with any of these labels are left alone (tracking or parent issues, say).
 *   `costFlagUsd`: an issue whose task-phase spend (cost.mjs) is over this many US dollars with no merged PR is
 *   flagged in the heartbeat, and canopy's Inbox, as a session candidate. 0 turns the flag off.
 * @typedef {{
 *   everyMinutes: number, staleHours: number, graceMinutes: number, cooldownHours: number, maxRescues: number,
 *   causeRepo: string | null,
 * }} RescueConfig
 *   The rescue graph (graphs/rescue.mjs, `engine: "graph"`, on while `phases.rescue.cap > 0`): every
 *   `everyMinutes` it looks for stuck items. A label that breaks the queue rules counts after `graceMinutes`; an
 *   item left waiting counts after `staleHours`. An item rescued in the last `cooldownHours` is left alone, and one
 *   rescued `maxRescues` times in a week goes to `q:human` without another diagnosis. `causeRepo`: a repo (owner/name)
 *   root-cause tickets may also be filed in, e.g. the one that holds cambium itself; the item's own repo always can.
 * @typedef {{ everyMinutes: number, graceMinutes: number, staleDays: number }} GcConfig
 *   Worktree garbage collection (gc.mjs): the daemon sweeps every `everyMinutes` (0: only `cambium gc`). A
 *   worktree touched within `graceMinutes` is left alone; one idle `staleDays` with work GitHub lacks is
 *   archived under `<home>/gc/`, then removed.
 */

/** @type {readonly MergePolicy[]} */
const MERGE_POLICIES = Object.freeze(['none', 'green'])

export const DEFAULT_HOME = join(homedir(), '.cambium')

/** @param {string} home @returns {Config} */
export function defaults(home = DEFAULT_HOME) {
  return {
    host: hostname(),
    engine: 'legacy',
    tickSeconds: 30,
    stepTimeoutSeconds: 20,
    fullReadEvery: 4,
    repos: [],
    phases: {
      task: { cap: 2, wallClockMinutes: 60, maxTurns: 200, maxAttempts: 3, maxReworks: 3 },
      dispatch: {
        cap: 0,
        wallClockMinutes: 15,
        maxTurns: 50,
        maxAttempts: 3,
        maxRounds: 3,
        deferHours: 6,
        maxDefers: 8,
      },
      rescue: { cap: 0, wallClockMinutes: 20, maxTurns: 80, maxAttempts: 1 },
    },
    mergeQueueMinutes: 120,
    mergeStallMinutes: 20,
    watchEveryMinutes: 5,
    merge: 'none',
    priorityLabels: ['priority:critical', 'priority:high', 'priority:medium', 'priority:low'],
    release: { enabled: false, time: '06:00', readEveryMinutes: 5 },
    reaper: { everyMinutes: 60, staleMinutes: 30, orphanDays: 3 },
    retriage: { enabled: false, time: '05:00', maxSkipDays: 14 },
    intake: { adopt: true, ignoreLabels: [] },
    rescue: { everyMinutes: 60, staleHours: 12, graceMinutes: 30, cooldownHours: 24, maxRescues: 2, causeRepo: null },
    paths: {
      home,
      db: join(home, 'cambium.db'),
      heartbeat: join(home, 'state.json'),
      queues: join(home, 'queues.json'),
      logs: join(home, 'logs'),
    },
    logs: { keepPerIssue: 20, daemonMaxBytes: 10 * 1024 * 1024 },
    graft: { command: 'graft', app: null, botLogin: null },
    worker: { command: 'claude', args: [], graftApp: null, fetch: true, env: {} },
    update: { auto: false, checkMinutes: 360 },
    gc: { everyMinutes: 60, graceMinutes: 60, staleDays: 14 },
    costFlagUsd: 10,
  }
}

/** @param {string} p */
const untilde = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p))

/** @param {any} base @param {any} over @returns {any} */
function merge(base, over) {
  if (over === undefined) return base
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) return over
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) out[k] = merge(base[k], v)
  return out
}

/** The config path: `--config`, then `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`. */
export function configPath(/** @type {string | undefined} */ flag, env = process.env) {
  return untilde(flag ?? env.CAMBIUM_CONFIG ?? join(DEFAULT_HOME, 'config.json'))
}

/** The phase caps a repo may override. */
const REPO_PHASE_KEYS = Object.freeze(['wallClockMinutes', 'maxTurns'])

/** @param {string} slug @param {any} raw @returns {RepoPhases} */
function repoPhases(slug, raw) {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`config: repo ${slug} phases must be an object`)
  /** @type {RepoPhases} */
  const out = {}
  for (const [phase, caps] of Object.entries(raw)) {
    if (!['task', 'dispatch', 'rescue'].includes(phase))
      throw new Error(`config: repo ${slug} phases.${phase}: the phases are task, dispatch and rescue`)
    for (const [k, v] of Object.entries(caps ?? {})) {
      if (!REPO_PHASE_KEYS.includes(k))
        throw new Error(`config: repo ${slug} phases.${phase}.${k}: a repo may set ${REPO_PHASE_KEYS.join(', ')}`)
      if (!(typeof v === 'number' && v > 0))
        throw new Error(`config: repo ${slug} phases.${phase}.${k} must be a number above 0, got ${JSON.stringify(v)}`)
    }
    out[/** @type {'task'} */ (phase)] = { ...caps }
  }
  return out
}

/** @param {string} slug @param {any} raw @param {string} baseBranch @returns {Watch[]} */
function repoWatch(slug, raw, baseBranch) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`config: repo ${slug} watch must be a list of { workflow, branch }`)
  return raw.map((w, i) => {
    const workflow = typeof w === 'string' ? w : w?.workflow
    if (typeof workflow !== 'string' || !workflow)
      throw new Error(`config: repo ${slug} watch[${i}] needs "workflow" (a file name like ci.yml, or its id)`)
    const branch = (typeof w === 'object' && w.branch) || baseBranch
    if (typeof branch !== 'string') throw new Error(`config: repo ${slug} watch[${i}].branch must be a branch name`)
    const issue = typeof w === 'object' && w.issue !== undefined ? w.issue : true
    if (typeof issue !== 'boolean') throw new Error(`config: repo ${slug} watch[${i}].issue must be true or false`)
    return { workflow, branch, issue }
  })
}

/**
 * One phase's caps for one repo's workers: the global `phases.<phase>`, under the repo's `phases.<phase>`.
 * @param {Config} config @param {string} slug @param {string} phase
 * @returns {PhaseCaps}
 */
export function capsFor(config, slug, phase) {
  const base = config.phases[/** @type {'task'} */ (phase)] ?? config.phases.task
  const over = config.repos.find((r) => r.slug === slug)?.phases?.[/** @type {'task'} */ (phase)]
  return over ? { ...base, ...over } : base
}

/**
 * @param {any} raw the parsed file
 * @returns {Config}
 */
export function resolveConfig(raw = {}) {
  const home = untilde(raw?.paths?.home ?? DEFAULT_HOME)
  /** @type {Config} */
  const config = merge(defaults(home), raw)
  for (const k of /** @type {const} */ (['home', 'db', 'heartbeat', 'queues', 'logs']))
    config.paths[k] = untilde(config.paths[k])
  if (!/^\d{2}:\d{2}$/.test(config.release.time)) throw new Error(`config: release.time must be HH:MM`)
  if (!/^\d{2}:\d{2}$/.test(config.retriage.time)) throw new Error(`config: retriage.time must be HH:MM`)
  if (typeof config.retriage.maxSkipDays !== 'number' || !(config.retriage.maxSkipDays >= 0))
    throw new Error(`config: retriage.maxSkipDays must be a number of days ≥ 0`)
  if (typeof config.intake.adopt !== 'boolean') throw new Error(`config: intake.adopt must be true or false`)
  if (!Array.isArray(config.intake.ignoreLabels) || config.intake.ignoreLabels.some((l) => typeof l !== 'string'))
    throw new Error(`config: intake.ignoreLabels must be a list of label names`)
  config.repos = (config.repos ?? []).map((r) => {
    if (!r?.slug || !/^[^/\s]+\/[^/\s]+$/.test(r.slug))
      throw new Error(`config: repo slug must be owner/name, got ${r?.slug}`)
    if (!r.path) throw new Error(`config: repo ${r.slug} needs "path" (a local clone)`)
    const baseBranch = r.baseBranch ?? 'main'
    const requiredCheck = r.requiredCheck === undefined ? 'ci' : r.requiredCheck
    if (requiredCheck !== null && (typeof requiredCheck !== 'string' || !requiredCheck))
      throw new Error(`config: repo ${r.slug} requiredCheck must be a check name or null`)
    /** @type {RepoRelease} */
    const release = {
      enabled: config.release.enabled,
      time: config.release.time,
      readEveryMinutes: config.release.readEveryMinutes,
      from: baseBranch,
      to: 'main',
      check: requiredCheck,
      ...r.release,
    }
    if (!/^\d{2}:\d{2}$/.test(release.time)) throw new Error(`config: repo ${r.slug} release.time must be HH:MM`)
    if (!(typeof release.readEveryMinutes === 'number' && release.readEveryMinutes >= 0))
      throw new Error(
        `config: repo ${r.slug} release.readEveryMinutes must be a number, at least 0, got ${JSON.stringify(release.readEveryMinutes)}`,
      )
    if (release.check !== null && (typeof release.check !== 'string' || !release.check))
      throw new Error(`config: repo ${r.slug} release.check must be a check name or null`)
    const merge = r.merge ?? config.merge
    if (!MERGE_POLICIES.includes(merge))
      throw new Error(`config: repo ${r.slug} merge must be "none" or "green", got ${JSON.stringify(merge)}`)
    const phases = repoPhases(r.slug, r.phases)
    const watch = repoWatch(r.slug, r.watch, baseBranch)
    return { slug: r.slug, path: untilde(r.path), baseBranch, release, merge, requiredCheck, phases, watch }
  })
  for (const k of /** @type {const} */ (['mergeStallMinutes', 'watchEveryMinutes']))
    if (!(typeof config[k] === 'number' && config[k] >= 0))
      throw new Error(`config: ${k} must be a number, at least 0, got ${JSON.stringify(config[k])}`)
  if (!(Number.isInteger(config.fullReadEvery) && config.fullReadEvery >= 1))
    throw new Error(
      `config: fullReadEvery must be a whole number of ticks, at least 1, got ${JSON.stringify(config.fullReadEvery)}`,
    )
  if (!MERGE_POLICIES.includes(config.merge))
    throw new Error(`config: merge must be "none" or "green", got ${JSON.stringify(config.merge)}`)
  const wenv = config.worker.env
  if (
    !wenv ||
    typeof wenv !== 'object' ||
    Array.isArray(wenv) ||
    Object.values(wenv).some((v) => typeof v !== 'string')
  )
    throw new Error('config: worker.env must be an object of string values')
  if (typeof config.update.auto !== 'boolean') throw new Error('config: update.auto must be true or false')
  if (!(Number(config.update.checkMinutes) >= 5)) throw new Error('config: update.checkMinutes must be at least 5')
  for (const k of /** @type {const} */ (['everyMinutes', 'graceMinutes', 'staleDays']))
    if (!(typeof config.gc[k] === 'number' && config.gc[k] >= 0))
      throw new Error(`config: gc.${k} must be a number, at least 0`)
  for (const k of /** @type {const} */ (['everyMinutes', 'staleHours', 'graceMinutes', 'cooldownHours', 'maxRescues']))
    if (!(typeof config.rescue[k] === 'number' && config.rescue[k] >= 0))
      throw new Error(`config: rescue.${k} must be a number, at least 0`)
  const causeRepo = config.rescue.causeRepo
  if (causeRepo !== null && (typeof causeRepo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(causeRepo)))
    throw new Error(`config: rescue.causeRepo must be owner/name or null, got ${JSON.stringify(causeRepo)}`)
  if (!(typeof config.costFlagUsd === 'number' && config.costFlagUsd >= 0))
    throw new Error(`config: costFlagUsd must be a number, at least 0, got ${JSON.stringify(config.costFlagUsd)}`)
  if (config.engine !== 'legacy' && config.engine !== 'graph')
    throw new Error(`config: engine must be "legacy" or "graph", got ${JSON.stringify(config.engine)}`)
  const merging = config.repos.filter((r) => r.merge === 'green')
  if (merging.length && config.engine !== 'graph')
    throw new Error(`config: merge "green" (${merging.map((r) => r.slug).join(', ')}) needs engine "graph"`)
  return config
}

/** @param {string} path */
/**
 * What the daemon bakes in at start: the host its leases name, the engine (switching it under live workers is
 * unsafe, see #42), the db/log/heartbeat paths it opened, and graft's App identity in its children's env.
 */
export const RESTART_KEYS = Object.freeze(['host', 'engine', 'paths', 'logs', 'graft'])

/**
 * A re-read config applied to the running one in place, since every collaborator holds that object. Keys in
 * {@link RESTART_KEYS} are never applied; they are reported so the daemon can say a restart is needed.
 *
 * @param {Config} live @param {Config} next
 * @returns {{ applied: string[], restart: string[] }}
 */
export function applyReload(live, next) {
  if (!next.repos.length) throw new Error('no repos')
  /** @type {Record<string, unknown>} */
  const target = live
  /** @type {Record<string, unknown>} */
  const source = next
  /** @type {string[]} */
  const applied = []
  /** @type {string[]} */
  const restart = []
  for (const k of new Set([...Object.keys(target), ...Object.keys(source)])) {
    if (JSON.stringify(target[k]) === JSON.stringify(source[k])) continue
    if (RESTART_KEYS.includes(k)) restart.push(k)
    else {
      target[k] = source[k]
      applied.push(k)
    }
  }
  return { applied, restart }
}

export function loadConfig(path) {
  if (!existsSync(path)) return resolveConfig({})
  try {
    return resolveConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    throw new Error(`${path}: ${/** @type {Error} */ (err).message}`)
  }
}
