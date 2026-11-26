// @ts-check
/**
 * mycelium's settings: the `MYCELIUM_*` environment variables, read from three places. The process environment wins
 * over `~/.oakgreen/env` (secrets, `KEY=value`), which wins over forest.json's `mycelium` section (everything else).
 *
 * The section holds the same settings in camelCase without the prefix: `"repo"` is `MYCELIUM_REPO`,
 * `"discordChannels"` is `MYCELIUM_DISCORD_CHANNELS`. Values are strings, numbers or booleans; a list joins with
 * commas. A credential named there is refused: it belongs in `~/.oakgreen/env`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { assertMigrated, envFilePath, forestPath, readEnvFile, readForest, sectionOf } from './forest.mjs'

export { envFilePath, parseEnvFile } from './forest.mjs'

/** @typedef {Record<string, string | undefined>} Env */

/** Credentials: only ever in `~/.oakgreen/env` (or the environment). */
export const SECRET_KEYS = Object.freeze([
  'MYCELIUM_DISCORD_TOKEN',
  'MYCELIUM_ASC_KEY_ID',
  'MYCELIUM_ASC_ISSUER_ID',
  'MYCELIUM_ASC_KEY_P8',
  'MYCELIUM_PLAY_KEY_JSON',
  'MYCELIUM_DEVICELOG_USER',
  'MYCELIUM_DEVICELOG_PASSWORD',
  'MYCELIUM_DEVICELOG_TOTP_SECRET',
])

/** What forest.json's `mycelium` section may hold. */
export const SETTING_KEYS = Object.freeze([
  'MYCELIUM_REPO',
  'MYCELIUM_STATE',
  'MYCELIUM_STATUS',
  'MYCELIUM_BACKFILL_HOURS',
  'MYCELIUM_NOTIFY_INTERVAL_S',
  'MYCELIUM_DISCORD_CHANNELS',
  'MYCELIUM_DISCORD_GUILD',
  'MYCELIUM_DISCORD_NOTIFY',
  'MYCELIUM_DECISIONS_CHANNEL',
  'MYCELIUM_BROKER_DB',
  'MYCELIUM_BROKER_INTERVAL_S',
  'MYCELIUM_ASC_APP_ID',
  'MYCELIUM_PLAY_PACKAGE',
  'MYCELIUM_PLAY_KEY_PATH',
  'MYCELIUM_DISCORD_INTERVAL_S',
  'MYCELIUM_ASC_INTERVAL_S',
  'MYCELIUM_TESTFLIGHT_INTERVAL_S',
  'MYCELIUM_PLAY_INTERVAL_S',
  'MYCELIUM_VITALS_INTERVAL_S',
  'MYCELIUM_DEVICELOG_API',
  'MYCELIUM_DEVICELOG_CLIENT_ID',
  'MYCELIUM_DEVICELOG_POOL_ID',
  'MYCELIUM_DEVICELOG_STAGE',
  'MYCELIUM_DEVICELOG_CRASHES',
  'MYCELIUM_DEVICELOG_INTERVAL_S',
])

/** `discordChannels` → `MYCELIUM_DISCORD_CHANNELS`. @param {string} key */
export const envKeyOf = (key) => `MYCELIUM_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`

/** `MYCELIUM_DISCORD_CHANNELS` → `discordChannels`. @param {string} name */
export const forestKeyOf = (name) =>
  name
    .replace(/^MYCELIUM_/, '')
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

/**
 * forest.json's `mycelium` section as environment variables. Throws on a credential or a key mycelium does not know.
 * @param {Record<string, unknown>} section @returns {Record<string, string>}
 */
export function sectionEnv(section) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(section)) {
    const name = envKeyOf(key)
    if (SECRET_KEYS.includes(name))
      throw new Error(`forest.json: mycelium.${key} is a credential; set ${name} in ~/.oakgreen/env instead`)
    if (!SETTING_KEYS.includes(name)) throw new Error(`forest.json: mycelium.${key} is not a mycelium setting`)
    if (Array.isArray(value)) out[name] = value.map(String).join(',')
    else if (['string', 'number', 'boolean'].includes(typeof value)) out[name] = String(value)
    else throw new Error(`forest.json: mycelium.${key} must be a string, number, boolean or list`)
  }
  return out
}

/**
 * The environment over `~/.oakgreen/env` over forest.json's `mycelium` section. `file` is the env file read, or
 * null when there is none. Throws on a machine still holding `~/.mycelium` (run `oakgreen config migrate`).
 *
 * @param {Env} env
 * @param {{ home?: string, config?: string, read?: (p: string) => string | null, exists?: (p: string) => boolean }} [o]
 * @returns {{ env: Env, file: string | null, forest: string }}
 */
export function withEnvFile(env, o = {}) {
  const where = { env, home: o.home }
  const read = o.read ?? ((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null))
  const path = forestPath(o.config, where)
  const { forest } = readForest(path, read)
  assertMigrated('mycelium', forest, where, o.exists ?? existsSync)
  const file = readEnvFile(where, read)
  /** @type {Env} */
  const merged = { ...sectionEnv(sectionOf(forest, 'mycelium')), ...file.values }
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') merged[k] = v
  return { env: merged, file: file.present ? file.path : null, forest: path }
}

/** Where `mycelium install` tells you to put settings. @param {Env} env @param {string} [home] */
export const settingsHint = (env, home) =>
  `forest.json's "mycelium" section (${forestPath(undefined, { env, home })}), credentials in ${envFilePath({ env, home })}`
