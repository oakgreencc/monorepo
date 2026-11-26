// @ts-check
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { envFilePath, legacyPaths, MIGRATE } from '@oakgreencc/mycelium/forest'
import { LABEL_GUIDE_PATH } from './label-guide.mjs'
import {
  QUEUE_LABELS,
  configuredRepos,
  forestConfigPath,
  gitRoot,
  heartbeatFreshness,
  heartbeatPath,
  myceliumSources,
  projectConfigSource,
  readForestFile,
} from './stack.mjs'

/**
 * @typedef {{ name: string, ok: boolean, required: boolean, detail: string, fix: string | null }} Check
 * @typedef {{
 *   env: import('./stack.mjs').Env,
 *   home: string,
 *   cwd: string,
 *   now: number,
 *   nodeVersion: string,
 *   engines: string,
 *   config?: string,
 *   repo?: string,
 *   runTool: (tool: import('./tools.mjs').Tool, args: string[], opts?: { cwd?: string }) => Promise<import('./tools.mjs').Result>,
 *   github: import('./github.mjs').GithubClient,
 *   which: (name: string) => string | null,
 * }} Context
 */

/** @param {string} v */
const parts = (v) =>
  v
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)

/**
 * Only the `>=x[.y[.z]]` form the stack's packages declare.
 *
 * @param {string} version
 * @param {string} range
 */
export function satisfies(version, range) {
  const m = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim())
  if (!m) return false
  const have = parts(version)
  const need = parts(m[1])
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0)
  return true
}

/** @param {import('./tools.mjs').Result} r */
function summarizeGraftDoctor(r) {
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const passed = lines.filter((l) => l.startsWith('✓')).length
  const failed = lines.filter((l) => l.startsWith('✗')).map((l) => l.slice(1).trim())
  if (failed.length) return `${failed.length} failing: ${failed.join('; ')}`
  if (r.code === 0 && passed) return `${passed} checks passed`
  return lines.at(-1) ?? `exit ${r.code}`
}

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 * @param {string} fix
 * @param {boolean} [required]
 * @returns {Check}
 */
const check = (name, ok, detail, fix, required = true) => ({ name, ok, required, detail, fix: ok ? null : fix })

/** @param {Context} ctx @returns {Promise<Check[]>} */
export async function runDoctor(ctx) {
  const checks = []
  checks.push(
    check(
      'node',
      satisfies(ctx.nodeVersion, ctx.engines),
      `Node ${ctx.nodeVersion} (engines ${ctx.engines})`,
      `install Node ${ctx.engines.replace('>=', '')} or newer`,
    ),
  )

  const graft = await ctx.runTool('graft', ['doctor'], { cwd: ctx.cwd })
  checks.push(
    check(
      'graft doctor',
      graft.code === 0,
      summarizeGraftDoctor(graft),
      graft.code === 127 ? 'npm install -g @oakgreencc/graft' : 'run `graft doctor` and follow its fixes',
    ),
  )

  const claude = ctx.which('claude')
  checks.push(
    check(
      'claude on PATH',
      claude != null,
      claude ?? 'not found',
      'install Claude Code: npm install -g @anthropic-ai/claude-code',
    ),
  )

  const configFile = forestConfigPath(ctx)
  const cambium = readForestFile(configFile)
  checks.push(...machineChecks(ctx, configFile, cambium))
  checks.push(
    check(
      'cambium config',
      cambium.present,
      cambium.present ? `"cambium" in ${configFile}` : `no "cambium" section in ${configFile}`,
      'oakgreen setup',
    ),
  )

  checks.push(await cambiumStatusCheck(ctx, cambium.present && !cambium.error, configFile))

  const beat = heartbeatFreshness(heartbeatPath(cambium.config, ctx.home), ctx.now)
  checks.push(check('cambium heartbeat', beat.ok, beat.detail, 'cambium start --once, or check the launchd agent'))

  checks.push(...(await labelChecks(ctx, cambium.config)))
  checks.push(...myceliumChecks(ctx.env))

  const root = gitRoot(ctx.cwd)
  for (const tool of /** @type {const} */ (['canker', 'deadwood'])) {
    const source = root ? projectConfigSource(root, tool) : null
    checks.push(
      check(
        `${tool} config`,
        source != null,
        !root
          ? `${ctx.cwd} is not in a git repository`
          : (source ?? `no ${tool}.json or package.json "${tool}" in ${root}`),
        `add ${tool}.json at the repository root`,
        false,
      ),
    )
  }
  const guide = root ? join(root, LABEL_GUIDE_PATH) : null
  const guideOk = guide != null && existsSync(guide) && readFileSync(guide, 'utf8').includes('q:intake')
  checks.push(
    check(
      'label guide',
      guideOk,
      !root
        ? `${ctx.cwd} is not in a git repository`
        : guideOk
          ? LABEL_GUIDE_PATH
          : `no ${LABEL_GUIDE_PATH} naming q:intake in ${root}`,
      'oakgreen setup, from the repository',
      false,
    ),
  )
  return checks
}

/**
 * forest.json parses, `~/.oakgreen/env` is the owner's alone (0600), and no pre-forest file is left.
 * @param {Context} ctx @param {string} file @param {ReturnType<typeof readForestFile>} forest @returns {Check[]}
 */
export function machineChecks(ctx, file, forest) {
  const where = { home: ctx.home, env: ctx.env }
  const envFile = envFilePath(where)
  const mode = existsSync(envFile) ? statSync(envFile).mode & 0o777 : null
  const old = Object.values(legacyPaths(where))
    .flat()
    .filter((p) => existsSync(p))
  return [
    check(
      'forest.json',
      forest.exists && !forest.error,
      forest.error ? `${file}: ${forest.error}` : forest.exists ? file : `missing ${file}`,
      forest.error ? `fix the JSON in ${file}` : 'oakgreen setup',
    ),
    check(
      'env file',
      mode === null || mode === 0o600,
      mode === null ? `no ${envFile} (no secrets set)` : `${envFile} mode ${mode.toString(8).padStart(4, '0')}`,
      `chmod 600 ${envFile}`,
    ),
    check('old paths', old.length === 0, old.length ? `still there: ${old.join(', ')}` : 'none left', MIGRATE),
  ]
}

/**
 * Skipped without a config: `cambium status` would create its database under the default home.
 *
 * @param {Context} ctx @param {boolean} configured @param {string} configFile @returns {Promise<Check>}
 */
async function cambiumStatusCheck(ctx, configured, configFile) {
  if (!configured) return check('cambium status', false, 'skipped: no usable cambium config', 'oakgreen setup')
  const status = await ctx.runTool('cambium', ['status', '--json', '--config', configFile], { cwd: ctx.cwd })
  if (status.code === 127) {
    return check('cambium status', false, 'cambium not installed', 'npm install -g @oakgreencc/cambium')
  }
  let report = null
  try {
    report = JSON.parse(status.stdout)
  } catch {}
  const ok = status.code === 0 && Boolean(report?.heartbeat)
  const detail = !report
    ? `exit ${status.code}: ${(status.stderr || status.stdout).trim().split('\n').at(-1) ?? ''}`
    : `mode ${report.mode}${report.heartbeat ? '' : ', no heartbeat'}`
  return check('cambium status', ok, detail, 'start the daemon: cambium install, then launchctl bootstrap')
}

/** @param {Context} ctx @param {any} config @returns {Promise<Check[]>} */
async function labelChecks(ctx, config) {
  const repos = configuredRepos({ repo: ctx.repo, config, env: ctx.env })
  if (!repos.length) {
    return [
      check(
        'queue labels',
        false,
        'no repository configured',
        'pass --repo owner/name or add repos to the cambium config',
      ),
    ]
  }
  const want = QUEUE_LABELS.map((l) => l.name)
  return Promise.all(
    repos.map(async (repo) => {
      try {
        const have = new Set(await ctx.github.listLabels(repo))
        const missing = want.filter((l) => !have.has(l))
        return check(
          `queue labels ${repo}`,
          missing.length === 0,
          missing.length ? `missing ${missing.join(' ')}` : `${want.length} present`,
          `oakgreen setup --repo ${repo}`,
        )
      } catch (err) {
        return check(`queue labels ${repo}`, false, /** @type {Error} */ (err).message, 'graft doctor, then retry')
      }
    }),
  )
}

/** @param {import('./stack.mjs').Env} env @returns {Check[]} */
function myceliumChecks(env) {
  const sources = myceliumSources(env)
  if (!sources.length) return [check('mycelium', true, 'no source enabled', '', false)]
  return sources.map(({ source, missing }) =>
    check(
      `mycelium ${source}`,
      missing.length === 0,
      missing.length ? `missing ${missing.join(', ')}` : 'configured',
      `set ${missing.join(', ')}`,
    ),
  )
}

/** @param {Check[]} checks */
export const doctorOk = (checks) => checks.every((c) => c.ok || !c.required)

/** @param {Check[]} checks */
export function formatDoctor(checks) {
  const lines = checks.map((c) => {
    const head = `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`
    return c.ok ? head : `${head}${c.required ? '' : ' (optional)'}\n    fix: ${c.fix}`
  })
  return `${lines.join('\n')}\n`
}
