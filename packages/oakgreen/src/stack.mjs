// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const QUEUE_LABELS = [
  { name: 'q:intake', color: 'c5def5', description: 'Queue: intake, waiting for dispatch' },
  { name: 'q:task', color: '0e8a16', description: 'Queue: ready for a task worker' },
  { name: 'q:human', color: 'd93f0b', description: 'Queue: needs a human' },
  { name: 'q:promote', color: '5319e7', description: 'Queue: waiting for promotion' },
  { name: 'running', color: 'fbca04', description: 'A worker holds the lease' },
  { name: 'why:budget', color: 'e4e669', description: 'In q:human: attempts spent' },
  { name: 'why:reject', color: 'e4e669', description: 'In q:human: rejected' },
  { name: 'why:approve', color: 'e4e669', description: 'In q:human: waiting for approval' },
  { name: 'why:triage', color: 'e4e669', description: 'In q:human: triage needs a human' },
  { name: 'why:rescue', color: 'e4e669', description: 'In q:human: the rescue graph could not unstick it' },
  // The ask:* labels: what a person in q:human is asked to do (cambium/src/ask.mjs `ASK_KINDS`, `ASK_SESSION`).
  { name: 'ask:decide', color: 'c2e0c6', description: 'In q:human: choose between options' },
  { name: 'ask:verify', color: 'c2e0c6', description: 'In q:human: check something only a person can' },
  { name: 'ask:chore', color: 'c2e0c6', description: 'In q:human: do a manual step' },
  { name: 'ask:approve', color: 'c2e0c6', description: 'In q:human: approve or reject' },
  { name: 'ask:session', color: 'c2e0c6', description: 'In q:human: best answered in a live session' },
  { name: 'wait:deferred', color: 'bfdadc', description: 'In q:intake: triage deferred it; rechecked later' },
  { name: 'wait:blocked', color: 'bfdadc', description: 'In q:intake: waits on its open blocked-by issues' },
  { name: 'red-base', color: 'b60205', description: 'Repair issue for a red base branch' },
  { name: 'rescue', color: 'f9d0c4', description: 'Root-cause ticket filed by the rescue graph' },
  { name: 'watch', color: 'd93f0b', description: 'A watched workflow is failing (cambium watch)' },
]

export const MYCELIUM_SOURCES = {
  discord: {
    any: ['MYCELIUM_DISCORD_TOKEN', 'MYCELIUM_DISCORD_CHANNELS'],
    all: [['MYCELIUM_DISCORD_TOKEN'], ['MYCELIUM_DISCORD_CHANNELS']],
  },
  asc: {
    any: ['MYCELIUM_ASC_KEY_ID', 'MYCELIUM_ASC_ISSUER_ID', 'MYCELIUM_ASC_KEY_P8', 'MYCELIUM_ASC_APP_ID'],
    all: [['MYCELIUM_ASC_KEY_ID'], ['MYCELIUM_ASC_ISSUER_ID'], ['MYCELIUM_ASC_KEY_P8'], ['MYCELIUM_ASC_APP_ID']],
  },
  play: {
    any: ['MYCELIUM_PLAY_PACKAGE', 'MYCELIUM_PLAY_KEY_JSON', 'MYCELIUM_PLAY_KEY_PATH'],
    all: [['MYCELIUM_PLAY_PACKAGE'], ['MYCELIUM_PLAY_KEY_JSON', 'MYCELIUM_PLAY_KEY_PATH']],
  },
}

/** @typedef {Record<string, string | undefined>} Env */

/** @param {string} p @param {string} home */
export const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p)

/** forest.json: `--config`, then `$OAKGREEN_FOREST_CONFIG_PATH`, then `~/.oakgreen/forest.json`. @param {{ config?: string, env: Env, home: string, cwd: string }} ctx */
export const forestConfigPath = ({ config, env, home, cwd }) =>
  resolve(cwd, expandHome(config || env.OAKGREEN_FOREST_CONFIG_PATH || '~/.oakgreen/forest.json', home))

/**
 * forest.json and its `cambium` section. `exists`: the file is there; `present`: it has the section; `error`: it does
 * not parse, or is not an object.
 * @param {string} file
 * @returns {{ exists: boolean, present: boolean, forest: Record<string, any> | null, config: any, error: string | null }}
 */
export function readForestFile(file) {
  if (!existsSync(file)) return { exists: false, present: false, forest: null, config: null, error: null }
  try {
    const forest = JSON.parse(readFileSync(file, 'utf8'))
    if (!forest || typeof forest !== 'object' || Array.isArray(forest)) throw new Error('not a JSON object')
    return { exists: true, present: forest.cambium !== undefined, forest, config: forest.cambium ?? null, error: null }
  } catch (err) {
    return { exists: true, present: false, forest: null, config: null, error: /** @type {Error} */ (err).message }
  }
}

/** @param {any} config @param {string} home */
export function heartbeatPath(config, home) {
  const paths = config?.paths ?? {}
  if (typeof paths.heartbeat === 'string') return expandHome(paths.heartbeat, home)
  return join(expandHome(typeof paths.home === 'string' ? paths.home : '~/.oakgreen/cambium', home), 'state.json')
}

/**
 * Fresh means the last tick finished within three ticks, cambium's own staleness rule.
 *
 * @param {string} file
 * @param {number} now
 * @returns {{ ok: boolean, detail: string }}
 */
export function heartbeatFreshness(file, now) {
  let beat
  try {
    beat = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, detail: `no heartbeat at ${file}` }
  }
  const at = Date.parse(beat?.tick?.finishedAt ?? '')
  const tickSeconds = Number(beat?.daemon?.tickSeconds) || 30
  if (!Number.isFinite(at)) return { ok: false, detail: `heartbeat at ${file} has no finished tick` }
  const age = Math.max(0, Math.round((now - at) / 1000))
  const ok = age <= tickSeconds * 3
  return { ok, detail: `last tick ${age}s ago (${ok ? 'within' : 'over'} ${tickSeconds * 3}s)` }
}

/** @param {string} slug */
export const isSlug = (slug) => /^[\w.-]+\/[\w.-]+$/.test(slug ?? '')

/**
 * `--repo` wins; else every repo in the cambium config; else `$MYCELIUM_REPO`.
 *
 * @param {{ repo?: string, config: any, env: Env }} ctx
 * @returns {string[]}
 */
export function configuredRepos({ repo, config, env }) {
  if (repo) return [repo]
  const fromConfig = Array.isArray(config?.repos) ? config.repos.map((/** @type {any} */ r) => r?.slug) : []
  const slugs = fromConfig.filter(isSlug)
  if (slugs.length) return slugs
  return env.MYCELIUM_REPO ? [env.MYCELIUM_REPO] : []
}

/** @param {string} start @returns {string | null} */
export function gitRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

/**
 * Where a tool's project config lives: `<tool>.json`, else the `<tool>` key of `package.json`.
 *
 * @param {string} root
 * @param {'canker' | 'deadwood'} tool
 * @returns {string | null}
 */
export function projectConfigSource(root, tool) {
  if (existsSync(join(root, `${tool}.json`))) return `${tool}.json`
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (pkg && pkg[tool] !== undefined) return `package.json "${tool}"`
  } catch {}
  return null
}

/**
 * A source is enabled once any of its variables is set; it is then checked for the rest.
 *
 * @param {Env} env
 * @returns {{ source: string, missing: string[] }[]}
 */
export function myceliumSources(env) {
  const set = (/** @type {string} */ k) => Boolean(env[k])
  return Object.entries(MYCELIUM_SOURCES)
    .filter(([, spec]) => spec.any.some(set))
    .map(([source, spec]) => ({
      source,
      missing: [
        ...spec.all.filter((alts) => !alts.some(set)).map((alts) => alts.join(' or ')),
        ...(set('MYCELIUM_REPO') ? [] : ['MYCELIUM_REPO']),
      ],
    }))
}

/** @param {string} slug @param {string} path */
export const cambiumSkeleton = (slug, path) => ({
  repos: [{ slug, path, baseBranch: 'main' }],
  phases: { task: { cap: 2, wallClockMinutes: 60, maxTurns: 200, maxAttempts: 3 } },
  graft: { command: 'graft', app: null, botLogin: null },
  worker: { command: 'claude', args: [], graftApp: null },
})

/** @param {string} url @returns {string | null} */
export function slugFromRemote(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}
