// @ts-check
/**
 * `oakgreen update`: install the registry's latest oakgreen over this one, then restart the running services.
 *
 * oakgreen depends on every stack tool, so a new oakgreen brings new graft, cambium, mycelium, ... with it, nested
 * in its own node_modules. A tool also installed on its own (`<prefix>/lib/node_modules/@oakgreencc/<tool>`) is a
 * separate copy, and it is the one on PATH and in the launchd agents `cambium install` wrote; so each such copy older
 * than the version the latest oakgreen pins is upgraded to that version in the same `npm install` (never
 * downgraded). That also runs when oakgreen itself is current, so a second `oakgreen update` heals tools an older
 * oakgreen left behind.
 *
 * It updates only a global npm install (`<prefix>/lib/node_modules/oakgreen`), into that same prefix, so PATH and the
 * launchd agents' paths stay valid. A source checkout or `npm link` is left alone. Afterwards each service that is
 * running gets a new process (SIGTERM; KeepAlive starts it on the new code); a stopped one stays stopped.
 *
 * A release publishes oakgreen and its tools together, but the registry's CDN can serve oakgreen's new manifest
 * before a tool version it pins, and npm then fails with ETARGET. So before installing, every exact version the install
 * needs is looked up on the registry; while one is missing it waits and looks again ({@link REGISTRY_WAITS}), and if it
 * is still missing it stops before touching the install. npm runs with `--prefer-online` so its own packument cache
 * cannot hide a version the registry already has, and a "no such version" from npm is retried on the same schedule.
 *
 * Every update (not `--check`) ends with the installed oakgreen's `oakgreen doctor`, run as a new process so it is
 * the new version's checks, to show config the new version wants changed. Its result does not change the exit code.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVICES, restart, statusOf } from './services.mjs'
import { TOOLS } from './tools.mjs'

export const PACKAGE = 'oakgreen'
export const REGISTRY = 'https://registry.npmjs.org'
export const SCOPE = '@oakgreencc'

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Seconds to wait before each new look at the registry for a version it does not serve yet (~4 minutes in all). */
export const REGISTRY_WAITS = [10, 20, 30, 60, 60, 60]

/** npm's error when the registry does not (yet) have a version. */
const NOT_ON_REGISTRY = /ETARGET|E404|notarget|No matching version/i

/**
 * @typedef {{
 *   current: string,
 *   installOf: () => { prefix: string, dir: string } | null,
 *   latest: () => Promise<Manifest>,
 *   globals: (prefix: string) => Record<string, string>,
 *   install: (prefix: string, specs: string[]) => Promise<void>,
 *   versions: () => Record<string, string | null>,
 *   missing: (specs: string[]) => Promise<string[]>,
 *   doctor: () => Promise<number>,
 * }} Updater
 * @typedef {{ version: string, dependencies: Record<string, string> }} Manifest
 * @typedef {{ name: string, from: string, to: string }} Stale
 */

/**
 * The npm prefix and package directory when this is a global npm install, else null.
 * @param {string} [dir] the package directory (default: this one, symlinks resolved)
 */
export function installOf(dir = PKG_DIR) {
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {}
  const m = /^(.*)\/lib\/node_modules\/oakgreen\/?$/.exec(real)
  return m ? { prefix: m[1], dir: real } : null
}

/** `a` is a later x.y.z than `b` (pre-release tags are ignored). @param {string} a @param {string} b */
export function newer(a, b) {
  const parts = (/** @type {string} */ v) => String(v).split('-')[0].split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0
  }
  return false
}

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SEMVER = /^\d+\.\d+\.\d+/

/**
 * The registry's `latest` manifest: its version and dependencies (published with exact versions).
 * @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [o]
 * @returns {Promise<Manifest>}
 */
export async function latestManifest({ fetch = globalThis.fetch, registry = REGISTRY } = {}) {
  const res = await fetch(`${registry}/${PACKAGE}/latest`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${PACKAGE}`)
  const j = /** @type {any} */ (await res.json())
  const v = j?.version
  if (typeof v !== 'string' || !SEMVER.test(v)) throw new Error(`registry gave no version for ${PACKAGE}`)
  return { version: v, dependencies: { ...(j.dependencies ?? {}) } }
}

/**
 * The stack tools installed on their own in a global prefix, by name: `{ '@oakgreencc/cambium': '0.0.38' }`.
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
export function globalTools(prefix) {
  const dir = join(prefix, 'lib', 'node_modules', SCOPE)
  /** @type {Record<string, string>} */
  const out = {}
  let names = /** @type {string[]} */ ([])
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    try {
      const v = JSON.parse(readFileSync(join(dir, n, 'package.json'), 'utf8'))?.version
      if (typeof v === 'string') out[`${SCOPE}/${n}`] = v
    } catch {}
  }
  return out
}

/**
 * Standalone tools older than the version oakgreen pins. Ranges (anything not a plain x.y.z) are skipped.
 * @param {Record<string, string>} pinned oakgreen's dependencies
 * @param {Record<string, string>} installed {@link globalTools}
 * @returns {Stale[]}
 */
export function staleTools(pinned, installed) {
  return Object.entries(installed)
    .filter(([name, from]) => {
      const to = pinned[name]
      return typeof to === 'string' && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(to) && newer(to, from)
    })
    .map(([name, from]) => ({ name, from, to: pinned[name] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** @param {string} file @returns {string | null} */
function versionIn(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))?.version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * The version of oakgreen and of each stack tool, read from disk now (so after an install it is the new one). A tool
 * resolves to its standalone global copy when there is one (that is the copy on PATH and in its launchd agent), else
 * the copy bundled with oakgreen. The proxy service is oakgreen itself.
 * @param {{ dir?: string, prefix?: string | null }} [o] oakgreen's package directory and global prefix
 * @returns {Record<string, string | null>}
 */
export function toolVersions({ dir = PKG_DIR, prefix = installOf(dir)?.prefix ?? null } = {}) {
  const standalone = prefix ? globalTools(prefix) : {}
  const req = createRequire(join(dir, 'package.json'))
  /** @type {Record<string, string | null>} */
  const out = { [PACKAGE]: versionIn(join(dir, 'package.json')) }
  for (const [name, pkg] of Object.entries(TOOLS)) {
    let bundled = null
    try {
      bundled = versionIn(req.resolve(`${pkg}/package.json`))
    } catch {}
    out[name] = standalone[pkg] ?? bundled
  }
  return out
}

/** `  cambium  0.0.45` lines for {@link toolVersions}. @param {Record<string, string | null>} v */
export function versionLines(v) {
  return Object.entries(v).map(([name, ver]) => `  ${name.padEnd(8)} ${ver ?? 'not installed'}\n`)
}

/** `name@x.y.z` → `[name, version]`. @param {string} spec */
const splitSpec = (spec) => {
  const at = spec.lastIndexOf('@')
  return /** @type {[string, string]} */ ([spec.slice(0, at), spec.slice(at + 1)])
}

/**
 * The `name@version` specs the registry does not serve (404). Any other answer counts as served, so a registry
 * hiccup is left to npm to report.
 * @param {string[]} specs
 * @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [o]
 * @returns {Promise<string[]>}
 */
export async function missingOnRegistry(specs, { fetch = globalThis.fetch, registry = REGISTRY } = {}) {
  const found = await Promise.all(
    specs.map(async (spec) => {
      const [name, version] = splitSpec(spec)
      try {
        const res = await fetch(`${registry}/${name.replace('/', '%2f')}/${version}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        return res.status !== 404
      } catch {
        return true
      }
    }),
  )
  return specs.filter((_, i) => !found[i])
}

/**
 * Every exact version an install of `specs` pulls from the registry: the specs, plus oakgreen's exact-pinned tools
 * when oakgreen is one of them.
 * @param {string[]} specs
 * @param {Manifest} latest
 */
export function neededSpecs(specs, latest) {
  const out = new Set(specs)
  if (specs.includes(`${PACKAGE}@${latest.version}`))
    for (const [name, v] of Object.entries(latest.dependencies))
      if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) out.add(`${name}@${v}`)
  return [...out]
}

/** npm next to this Node (nvm, Homebrew and the official installer put it there), else npm on PATH. */
export function npmBin(node = process.execPath) {
  const beside = join(dirname(node), 'npm')
  return existsSync(beside) ? beside : 'npm'
}

/**
 * The real updater.
 * @param {{ exec: import('./tools.mjs').Exec, spawn: import('./tools.mjs').Spawn, cwd: string, current: string,
 *   fetch?: typeof globalThis.fetch }} o
 * @returns {Updater}
 */
export function realUpdater({ exec, spawn, cwd, current, fetch }) {
  return {
    current,
    installOf: () => installOf(),
    latest: () => latestManifest({ fetch }),
    globals: globalTools,
    install: async (prefix, specs) => {
      const r = await exec(npmBin(), ['install', '--global', '--prefer-online', '--prefix', prefix, ...specs])
      if (r.code !== 0) throw new Error(`npm install ${specs.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`)
    },
    versions: () => toolVersions(),
    missing: (specs) => missingOnRegistry(specs, { fetch }),
    // The bin on disk now, so after an install it is the new version's doctor.
    doctor: () =>
      spawn(process.execPath, [join(installOf()?.dir ?? PKG_DIR, 'bin', 'oakgreen.mjs'), 'doctor'], { cwd }),
  }
}

/**
 * `oakgreen update [--check]`.
 *
 * @param {{ check: boolean }} opts
 * @param {{ updater: Updater, services: import('./services.mjs').Ports, platform?: string, out: (s: string) => void,
 *   sleep?: (ms: number) => Promise<unknown> }} io
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runUpdate({ check }, io) {
  const r = await update({ check }, io)
  if (!check && r.installed !== false) await doctor(io)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/** Runs the installed `oakgreen doctor`. @param {{ updater: Updater, out: (s: string) => void }} io */
async function doctor({ updater, out }) {
  out('\nchecking this machine with the installed oakgreen: oakgreen doctor\n')
  const code = await updater.doctor().catch((/** @type {Error} */ err) => {
    out(`✗ oakgreen doctor did not run: ${err?.message ?? err}\n`)
    return null
  })
  if (code !== null && code !== 0) out('oakgreen doctor found something to change; `oakgreen setup` fixes most of it\n')
}

/**
 * The update itself. `installed: false` when it stopped before the install was in its new state (nothing done, or
 * the install failed), so there is nothing new for doctor to check.
 * @param {{ check: boolean }} opts
 * @param {{ updater: Updater, services: import('./services.mjs').Ports, platform?: string, out: (s: string) => void,
 *   sleep?: (ms: number) => Promise<unknown> }} io
 * @returns {Promise<{ ok: boolean, error?: string, installed?: boolean }>}
 */
async function update({ check }, { updater, services, platform, out, sleep = defaultSleep }) {
  const latest = await updater.latest()
  const self = newer(latest.version, updater.current)
  const where = updater.installOf()
  const stale = where ? staleTools(latest.dependencies, updater.globals(where.prefix)) : []
  const showVersions = () => {
    out('versions:\n')
    for (const l of versionLines(updater.versions())) out(l)
  }
  if (!self && !stale.length) {
    out(`oakgreen ${updater.current} is up to date\n`)
    showVersions()
    return { ok: true }
  }
  const lines = [
    ...(self ? [`oakgreen ${updater.current} → ${latest.version}`] : []),
    ...stale.map((t) => `${t.name} ${t.from} → ${t.to}`),
  ]
  if (check) {
    for (const l of lines) out(`${l} available\n`)
    showVersions()
    out('run `oakgreen update`\n')
    return { ok: true }
  }
  if (!where)
    return {
      ok: false,
      installed: false,
      error: `oakgreen ${updater.current} → ${latest.version} available, but this oakgreen is not a global npm install (<prefix>/lib/node_modules/oakgreen); update it the way it was installed`,
    }
  const specs = [...(self ? [`${PACKAGE}@${latest.version}`] : []), ...stale.map((t) => `${t.name}@${t.to}`)]
  const needed = neededSpecs(specs, latest)
  for (let attempt = 0; ; attempt++) {
    const missing = await updater.missing(needed)
    if (!missing.length) break
    if (attempt >= REGISTRY_WAITS.length)
      return {
        ok: false,
        installed: false,
        error: `the npm registry does not serve ${missing.join(' ')} yet (a release can take a few minutes to reach it); nothing was installed, run \`oakgreen update\` again shortly`,
      }
    out(`… the registry does not serve ${missing.join(' ')} yet; looking again in ${REGISTRY_WAITS[attempt]}s\n`)
    await sleep(REGISTRY_WAITS[attempt] * 1000)
  }
  out(`installing ${specs.join(' ')} into ${where.prefix}…\n`)
  for (let attempt = 0; ; attempt++) {
    try {
      await updater.install(where.prefix, specs)
      break
    } catch (err) {
      const msg = /** @type {Error} */ (err)?.message ?? String(err)
      if (!NOT_ON_REGISTRY.test(msg) || attempt >= REGISTRY_WAITS.length)
        return { ok: false, installed: false, error: msg }
      out(`… npm cannot find a version yet; trying again in ${REGISTRY_WAITS[attempt]}s\n`)
      await sleep(REGISTRY_WAITS[attempt] * 1000)
    }
  }
  for (const l of lines) out(`✓ ${l}\n`)
  showVersions()
  if ((platform ?? process.platform) !== 'darwin') return { ok: true }
  let ok = true
  for (const s of SERVICES) {
    const st = await statusOf(services, s)
    if (!st.loaded || st.pid === null) continue
    out(`… ${s.name.padEnd(8)} restarting onto the new version\n`)
    const r = await restart(services, s)
    out(`${r.ok ? '✓' : '✗'} ${s.name.padEnd(8)} ${r.detail}\n`)
    ok &&= r.ok
  }
  return ok ? { ok } : { ok, error: 'installed, but a service did not restart; see above' }
}
