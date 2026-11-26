// @ts-check
/**
 * `oakgreen config migrate`: move a machine from the per-service files onto `~/.oakgreen` (forest.mjs).
 *
 *   ~/.cambium/config.json              → forest.json `cambium` (paths under ~/.cambium follow the state)
 *   ~/.cambium/*                        → ~/.oakgreen/cambium/*
 *   ~/.mycelium/env                     → forest.json `mycelium` (settings) and ~/.oakgreen/env (the rest)
 *   ~/.mycelium/*, $XDG_STATE_HOME/mycelium/*  → ~/.oakgreen/mycelium/*
 *   canopy's launchd flags              → forest.json `canopy`
 *   ~/.canopy/*                         → ~/.oakgreen/canopy/*
 *   ~/.config/graft/config.json         → forest.json `graft`
 *   ~/.config/graft/*                   → ~/.oakgreen/graft/* (App keys 0600, their directories 0700)
 *   ~/.oakgreen/proxy.json              → forest.json `proxy`
 *   ~/.oakgreen/logs/*                  → ~/.oakgreen/proxy/logs/*
 *
 * Files move by rename, so their bytes do not change. The otelcol config and agent are rewritten to the new paths;
 * the other agents that name an old path are removed, for `oakgreen start` to write afresh. Nothing is overwritten:
 * a destination that exists, or a section forest.json already has, stops the whole migration before it changes
 * anything. So does a service whose files would move while launchd has it loaded.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { forestKeyOf, SETTING_KEYS } from '@oakgreencc/mycelium/envfile'
import {
  envFilePath,
  envLine,
  forestPath,
  legacyPaths,
  oakgreenDir,
  parseEnvFile,
  readForest,
  writeAtomic,
} from '@oakgreencc/mycelium/forest'
import { SERVICES, plistOf, statusOf } from './services.mjs'

/**
 * @typedef {{ kind: 'move', from: string, to: string }
 *   | { kind: 'rewrite', path: string, text: string }
 *   | { kind: 'unlink', path: string, why: string }} Step
 * @typedef {{
 *   forest: Record<string, any>, forestPath: string, folded: string[],
 *   env: Record<string, string>, envPath: string,
 *   steps: Step[], services: Set<string>, conflicts: string[], cleanup: string[],
 * }} Plan
 *   `folded`: the sections added to forest.json, with where each came from. `env`: lines added to the env file.
 *   `services`: the launchd agents that must not be loaded. `cleanup`: old directories removed once empty.
 */

/** Agents whose plist names a pre-forest path. */
const OLD_IN_PLIST = ['/.cambium', '/.mycelium', '/.canopy', '/.oakgreen/logs', 'MYCELIUM_ENV', 'CAMBIUM_CONFIG']

/** @param {string} p */
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    throw new Error(`${p}: ${/** @type {Error} */ (err).message}`)
  }
}

/** @param {string} dir @returns {string[]} */
const entries = (dir) => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).sort() : [])

/**
 * The plan for this machine; reads only.
 * @param {{ home: string, env: Record<string, string | undefined> }} where @returns {Plan}
 */
export function planMigration({ home, env }) {
  const w = { home, env }
  const og = oakgreenDir(w)
  const fPath = forestPath(undefined, w)
  const { forest: current } = readForest(fPath)
  const forest = structuredClone(current)
  const ePath = envFilePath(w)
  const haveEnv = existsSync(ePath) ? parseEnvFile(readFileSync(ePath, 'utf8')) : {}
  /** @type {Plan} */
  const plan = {
    forest,
    forestPath: fPath,
    folded: [],
    env: {},
    envPath: ePath,
    steps: [],
    services: new Set(),
    conflicts: [],
    cleanup: [],
  }
  const legacy = legacyPaths(w)
  const fold = (/** @type {string} */ section, /** @type {any} */ value, /** @type {string} */ from) => {
    if (current[section] !== undefined) {
      plan.conflicts.push(`forest.json already has a "${section}" section; ${from} was not folded in`)
      return
    }
    forest[section] = value
    plan.folded.push(`${section} ← ${from}`)
  }
  /** @type {Set<string>} */
  const planned = new Set()
  /** Every entry of `from` but `skip`, into `to`. */
  const moveAll = (/** @type {string} */ from, /** @type {string} */ to, /** @type {string[]} */ skip = []) => {
    for (const name of entries(from)) {
      if (skip.includes(name)) continue
      const dest = join(to, name)
      if (existsSync(dest) || planned.has(dest))
        plan.conflicts.push(`${dest} exists; ${join(from, name)} was not moved`)
      else plan.steps.push({ kind: 'move', from: join(from, name), to: dest })
      planned.add(dest)
    }
    if (existsSync(from)) plan.cleanup.push(from)
  }
  const oldFile = (/** @type {string} */ path) =>
    plan.steps.push({ kind: 'unlink', path, why: 'folded into forest.json' })

  // cambium
  const [cambiumDir] = legacy.cambium
  const cambiumCfg = join(cambiumDir, 'config.json')
  if (existsSync(cambiumCfg)) {
    fold('cambium', repath(readJson(cambiumCfg), home), cambiumCfg)
    oldFile(cambiumCfg)
  }
  if (entries(cambiumDir).some((n) => n !== 'config.json')) plan.services.add('cambium')
  if (entries(cambiumDir).includes('otel')) plan.services.add('otelcol')
  moveAll(cambiumDir, join(og, 'cambium'), ['config.json'])
  const otelYaml = join(cambiumDir, 'otel', 'otelcol.yaml')
  if (existsSync(otelYaml))
    plan.steps.push({
      kind: 'rewrite',
      path: join(og, 'cambium', 'otel', 'otelcol.yaml'),
      text: readFileSync(otelYaml, 'utf8').replaceAll('/.cambium/', '/.oakgreen/cambium/'),
    })
  const otelPlist = plistOf(home, 'com.oakgreencc.otelcol')
  if (existsSync(otelPlist) && readFileSync(otelPlist, 'utf8').includes('/.cambium/')) {
    plan.services.add('otelcol')
    plan.steps.push({
      kind: 'rewrite',
      path: otelPlist,
      text: readFileSync(otelPlist, 'utf8')
        .replaceAll('/.cambium/otel/otelcol.log', '/.oakgreen/cambium/logs/otelcol.log')
        .replaceAll('/.cambium/', '/.oakgreen/cambium/'),
    })
  }

  // mycelium
  const [myceliumDir, myceliumState] = legacy.mycelium
  const myceliumEnv = join(myceliumDir, 'env')
  if (existsSync(myceliumEnv)) {
    /** @type {Record<string, string>} */
    const settings = {}
    for (const [k, v] of Object.entries(parseEnvFile(readFileSync(myceliumEnv, 'utf8')))) {
      if (SETTING_KEYS.includes(k)) settings[forestKeyOf(k)] = v
      else if (haveEnv[k] === undefined) plan.env[k] = v
      else if (haveEnv[k] !== v)
        plan.conflicts.push(`${ePath} already sets ${k} to another value; ${myceliumEnv} not folded`)
    }
    fold('mycelium', settings, myceliumEnv)
    oldFile(myceliumEnv)
  }
  if (entries(myceliumDir).some((n) => n !== 'env') || entries(myceliumState).length) plan.services.add('mycelium')
  moveAll(myceliumDir, join(og, 'mycelium'), ['env'])
  moveAll(myceliumState, join(og, 'mycelium'))

  // canopy
  const canopyPlist = plistOf(home, 'com.oakgreencc.canopy')
  if (existsSync(canopyPlist)) {
    const flags = canopyFlags(readFileSync(canopyPlist, 'utf8'))
    if (Object.keys(flags).length) {
      fold('canopy', flags, `the flags in ${canopyPlist}`)
      plan.services.add('canopy')
      plan.steps.push({ kind: 'unlink', path: canopyPlist, why: 'its flags now live in forest.json' })
    }
  }
  const [canopyDir] = legacy.canopy
  if (entries(canopyDir).length) plan.services.add('canopy')
  if (existsSync(canopyDir) && forest.canopy === undefined && current.canopy === undefined) forest.canopy = {}
  moveAll(canopyDir, join(og, 'canopy'))

  // graft
  for (const graftDir of legacy.graft) {
    const cfg = join(graftDir, 'config.json')
    if (existsSync(cfg)) {
      fold('graft', readJson(cfg), cfg)
      oldFile(cfg)
    }
    if (existsSync(graftDir) && forest.graft === undefined && current.graft === undefined) forest.graft = {}
    moveAll(graftDir, join(og, 'graft'), ['config.json'])
  }

  // proxy
  const [proxyJson, proxyLogs] = legacy.proxy
  if (existsSync(proxyJson)) {
    fold('proxy', readJson(proxyJson), proxyJson)
    oldFile(proxyJson)
  }
  if (entries(proxyLogs).length) plan.services.add('proxy')
  moveAll(proxyLogs, join(og, 'proxy', 'logs'))

  // Agents still naming an old path: removed, so `oakgreen start` writes them afresh.
  for (const name of ['cambium', 'mycelium', 'canopy', 'proxy']) {
    const plist = plistOf(home, `com.oakgreencc.${name}`)
    if (!existsSync(plist) || plan.steps.some((s) => s.kind === 'unlink' && s.path === plist)) continue
    const text = readFileSync(plist, 'utf8')
    if (!OLD_IN_PLIST.some((s) => text.includes(s))) continue
    plan.services.add(name)
    plan.steps.push({ kind: 'unlink', path: plist, why: `names an old path; oakgreen start ${name} writes a new one` })
  }
  return plan
}

/**
 * cambium's `paths` that pointed into `~/.cambium` point into `~/.oakgreen/cambium`, where the state moves.
 * @param {any} config @param {string} home
 */
function repath(config, home) {
  const paths = config?.paths
  if (!paths || typeof paths !== 'object') return config
  const out = { ...paths }
  for (const [k, v] of Object.entries(paths)) {
    if (typeof v !== 'string') continue
    for (const old of ['~/.cambium', join(home, '.cambium')])
      if (v === old || v.startsWith(`${old}/`)) out[k] = `~/.oakgreen/cambium${v.slice(old.length)}`
  }
  return { ...config, paths: out }
}

/** Serve flags from canopy's old plist, as its forest.json section. @param {string} text @returns {Record<string, any>} */
export function canopyFlags(text) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''
  const unxml = (/** @type {string} */ s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1])).slice(2)
  /** @type {Record<string, any>} */
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i])
    if (!m) continue
    const value = m[2] ?? args[++i]
    if (value === undefined) break
    const key = m[1]
    if (key === 'config') continue
    if (key === 'repo') out.repos = [...(out.repos ?? []), value]
    else if (key === 'port' || key === 'cache') out[key] = Number(value)
    else out[key] = value
  }
  return out
}

/** Rename; across filesystems, copy then remove. @param {string} from @param {string} to */
function move(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EXDEV') throw err
    cpSync(from, to, { recursive: true, preserveTimestamps: true })
    rmSync(from, { recursive: true })
  }
}

/** App keys 0600 and their directories 0700, wherever they landed. @param {string} graftHome */
function lockApps(graftHome) {
  const apps = join(graftHome, 'apps')
  if (!existsSync(apps)) return
  chmodSync(graftHome, 0o700)
  chmodSync(apps, 0o700)
  for (const slug of readdirSync(apps)) {
    const dir = join(apps, slug)
    if (!statSync(dir).isDirectory()) continue
    chmodSync(dir, 0o700)
    for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600)
  }
}

/** Remove `dir` and its directories if nothing is left in them. @param {string} dir */
function removeIfEmpty(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return
  for (const name of readdirSync(dir)) removeIfEmpty(join(dir, name))
  if (!readdirSync(dir).length) rmdirSync(dir)
}

/**
 * @param {Plan} plan @returns {string[]} what the plan does, one line each
 */
export function describePlan(plan) {
  const lines = []
  for (const f of plan.folded) lines.push(`fold   ${plan.forestPath}: ${f}`)
  const keys = Object.keys(plan.env)
  if (keys.length) lines.push(`secret ${plan.envPath} (0600): ${keys.join(', ')}`)
  for (const s of plan.steps)
    if (s.kind === 'move') lines.push(`move   ${s.from} → ${s.to}`)
    else if (s.kind === 'rewrite') lines.push(`write  ${s.path} (paths under ~/.oakgreen)`)
    else lines.push(`remove ${s.path} (${s.why})`)
  return lines
}

/**
 * @param {{
 *   home: string, env: Record<string, string | undefined>, dryRun: boolean,
 *   exec: import('./tools.mjs').Exec, uid: number, print: (line: string) => void,
 * }} o
 * @returns {Promise<number>} the exit code
 */
export async function runMigrate({ home, env, dryRun, exec, uid, print }) {
  let plan
  try {
    plan = planMigration({ home, env })
  } catch (err) {
    print(`oakgreen config migrate: ${/** @type {Error} */ (err).message}`)
    return 1
  }
  if (plan.conflicts.length) {
    for (const c of plan.conflicts) print(`! ${c}`)
    print('Nothing changed. Resolve these, then run oakgreen config migrate again.')
    return 1
  }
  const lines = describePlan(plan)
  const forestChanged =
    plan.folded.length > 0 || JSON.stringify(plan.forest) !== JSON.stringify(readForest(plan.forestPath).forest)
  if (!lines.length && !forestChanged) {
    print('Nothing to migrate: no pre-forest files on this machine.')
    return 0
  }
  /** @type {string[]} */
  const loaded = []
  for (const s of SERVICES.filter((x) => plan.services.has(x.name))) {
    const st = await statusOf({ exec, home, uid }, s)
    if (st.loaded) loaded.push(s.name)
  }
  for (const line of lines) print(line)
  if (loaded.length) {
    print(`! running: ${loaded.join(', ')}. Stop first: oakgreen stop ${loaded.join(' ')}`)
    print('Nothing changed.')
    return 1
  }
  if (dryRun) {
    print('(dry run: nothing changed)')
    return 0
  }

  writeAtomic(plan.forestPath, `${JSON.stringify(plan.forest, null, 2)}\n`)
  if (Object.keys(plan.env).length || !existsSync(plan.envPath)) {
    const before = existsSync(plan.envPath) ? readFileSync(plan.envPath, 'utf8') : ''
    const added = Object.entries(plan.env).map(([k, v]) => envLine(k, v))
    const text = [before.replace(/\n*$/, ''), ...added].filter(Boolean).join('\n')
    writeAtomic(plan.envPath, text ? `${text}\n` : '', 0o600)
  }
  for (const s of plan.steps) if (s.kind === 'move') move(s.from, s.to)
  for (const s of plan.steps)
    if (s.kind === 'rewrite') {
      mkdirSync(dirname(s.path), { recursive: true })
      writeFileSync(s.path, s.text)
    }
  if (plan.services.has('otelcol')) mkdirSync(join(oakgreenDir({ home, env }), 'cambium', 'logs'), { recursive: true })
  lockApps(join(oakgreenDir({ home, env }), 'graft'))
  for (const s of plan.steps) if (s.kind === 'unlink' && existsSync(s.path)) unlinkSync(s.path)
  for (const dir of plan.cleanup) removeIfEmpty(dir)
  const left = plan.cleanup.filter((d) => existsSync(d))
  for (const d of left) print(`! ${d} is not empty; look inside, then remove it`)
  print(
    `Migrated. Start the services again: oakgreen start${plan.services.size ? ` ${[...plan.services].join(' ')}` : ''}`,
  )
  return left.length ? 1 : 0
}
