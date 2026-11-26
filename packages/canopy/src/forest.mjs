// @ts-check
/**
 * The machine layout every oakgreen service shares:
 *
 *   `~/.oakgreen/forest.json`     config, one section per service (`cambium`, `mycelium`, `canopy`, `graft`,
 *                                 `proxy`). `$OAKGREEN_FOREST_CONFIG_PATH` points to a different file. Never secrets.
 *   `~/.oakgreen/env`             secrets: `KEY=value` lines, mode 0600.
 *   `~/.oakgreen/<service>/`      each service's state, and its logs under `logs/`.
 *
 * Precedence, in every service: flag > environment variable > forest.json > default.
 *
 * cambium, canopy, graft and mycelium are published alone, so each carries this file; oakgreen's tests keep the
 * copies identical. Edit one, then copy it over the others.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** @typedef {Record<string, string | undefined>} Env */
/** @typedef {{ env?: Env, home?: string }} Where `home` over `env.HOME` over the OS's. */

export const FOREST_PATH_ENV = 'OAKGREEN_FOREST_CONFIG_PATH'
export const MIGRATE = 'oakgreen config migrate'
/** The services with a section in forest.json. */
export const SECTIONS = Object.freeze(['cambium', 'mycelium', 'canopy', 'graft', 'proxy'])

/** @param {Where} [w] */
export const homeOf = (w = {}) => w.home ?? (w.env ?? process.env).HOME ?? homedir()
/** `~/.oakgreen`. @param {Where} [w] */
export const oakgreenDir = (w = {}) => join(homeOf(w), '.oakgreen')
/** `~/.oakgreen/<service>`: its state, and its logs under `logs/`. @param {string} service @param {Where} [w] */
export const serviceDir = (service, w = {}) => join(oakgreenDir(w), service)
/** `~/.oakgreen/env`. @param {Where} [w] */
export const envFilePath = (w = {}) => join(oakgreenDir(w), 'env')

/** `~` and `~/…` against `home`; anything else resolved. @param {string} p @param {string} home */
export const untilde = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p))

/**
 * forest.json's path: `flag` (a `--config`), then `$OAKGREEN_FOREST_CONFIG_PATH`, then `~/.oakgreen/forest.json`.
 * @param {string | undefined} flag @param {Where} [w]
 */
export function forestPath(flag, w = {}) {
  const env = w.env ?? process.env
  return untilde(flag || env[FOREST_PATH_ENV] || join(oakgreenDir(w), 'forest.json'), homeOf(w))
}

/** @param {string} p @returns {string | null} */
const readIfThere = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

/**
 * forest.json parsed. `present` is false when there is no file. Throws, naming the file, when it is not a JSON
 * object.
 * @param {string} path @param {(p: string) => string | null} [read]
 * @returns {{ path: string, present: boolean, forest: Record<string, any> }}
 */
export function readForest(path, read = readIfThere) {
  const text = read(path)
  if (text == null) return { path, present: false, forest: {} }
  let forest
  try {
    forest = JSON.parse(text)
  } catch (err) {
    throw new Error(`${path}: ${/** @type {Error} */ (err).message}`)
  }
  if (!forest || typeof forest !== 'object' || Array.isArray(forest))
    throw new Error(`${path}: must be a JSON object with one section per service`)
  return { path, present: true, forest }
}

/**
 * One service's section, `{}` when absent. @param {Record<string, any>} forest @param {string} service
 * @returns {Record<string, any>}
 */
export function sectionOf(forest, service) {
  const s = forest[service]
  if (s === undefined) return {}
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`forest.json: "${service}" must be an object`)
  return s
}

/** Write a file whole: a temp file renamed over it. `mode` also applies to a file that existed. */
export function writeAtomic(
  /** @type {string} */ path,
  /** @type {string} */ text,
  /** @type {number} */ mode = 0o644,
) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

/**
 * Set one service's section, keeping the others. @param {string} path @param {string} service
 * @param {Record<string, any>} value
 */
export function writeSection(path, service, value) {
  const { forest } = readForest(path)
  forest[service] = value
  writeAtomic(path, `${JSON.stringify(forest, null, 2)}\n`)
}

/**
 * Dotenv lines: `#` comments, an optional `export `, values bare, `"double"` or `'single'` quoted (a shell
 * `'\''` inside single quotes is a literal quote, as `set -a; . file` would read it).
 *
 * @param {string} text @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw)
    if (!m) continue
    let v = m[2].trim()
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replaceAll("'\\''", "'")
    else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
    out[m[1]] = v
  }
  return out
}

/** A value as one env-file line, single-quoted. @param {string} key @param {string} value */
export const envLine = (key, value) => `${key}='${value.replaceAll("'", "'\\''")}'`

/**
 * `~/.oakgreen/env` parsed, `{}` when there is none.
 * @param {Where} [w] @param {(p: string) => string | null} [read]
 * @returns {{ path: string, present: boolean, values: Record<string, string> }}
 */
export function readEnvFile(w = {}, read = readIfThere) {
  const path = envFilePath(w)
  const text = read(path)
  return { path, present: text != null, values: text == null ? {} : parseEnvFile(text) }
}

/**
 * The files each service kept before forest.json, which `oakgreen config migrate` folds in. No code reads them;
 * {@link assertMigrated} only looks for them.
 * @param {Where} [w] @returns {Record<string, string[]>}
 */
export function legacyPaths(w = {}) {
  const env = w.env ?? process.env
  const home = homeOf(w)
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config')
  const xdgState = env.XDG_STATE_HOME || join(home, '.local', 'state')
  return {
    cambium: [join(home, '.cambium')],
    mycelium: [join(home, '.mycelium'), join(xdgState, 'mycelium')],
    canopy: [join(home, '.canopy')],
    graft: [join(xdgConfig, 'graft'), join(xdgConfig, 'agit')],
    proxy: [join(home, '.oakgreen', 'proxy.json'), join(home, '.oakgreen', 'logs')],
  }
}

/**
 * Refuse to run on a machine not yet moved over: one of the service's old files is there and forest.json has no
 * section for it. @param {string} service @param {Record<string, any>} forest @param {Where} [w]
 * @param {(p: string) => boolean} [exists]
 */
export function assertMigrated(service, forest, w = {}, exists = existsSync) {
  if (forest[service] !== undefined) return
  const old = (legacyPaths(w)[service] ?? []).filter((p) => exists(p))
  if (old.length)
    throw new Error(
      `found ${old.join(', ')} from before forest.json, and forest.json has no "${service}" section; run \`${MIGRATE}\``,
    )
}
