// @ts-check
/**
 * Configuration — two files, two owners.
 *
 *   `<repo>/.graft.json`             the PROJECT's policy: where PRs land, what
 *   (or `package.json` → `graft`)
 *                                   validates a tree, which hooks must run, what
 *                                   is protected beyond CODEOWNERS. Tracked, and
 *                                   protected by default (see protected.mjs), so
 *                                   an agent cannot loosen the policy it runs under
 *                                   without a human's grant and a code-owner review.
 *
 *   forest.json → `graft`           the MACHINE's identity: which GitHub App acts
 *   (`~/.oakgreen/forest.json`)      for which owner (forest.mjs). App keys live in
 *                                   `$GRAFT_HOME/apps/<slug>/` (`~/.oakgreen/graft`
 *                                   by default), 0600. Never tracked. The only key
 *                                   material an agent session ever holds is the
 *                                   App's, never a human's.
 *
 * Every field of the project file is optional; `DEFAULTS` is the policy of a
 * repository that ran `graft setup project` and changed nothing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertMigrated, forestPath, oakgreenDir, readForest, sectionOf } from './forest.mjs'

/** The project file, at the repository root. */
export const PROJECT_FILE = '.graft.json'

export const DEFAULTS = Object.freeze({
  /** `owner/name`. `null` reads it from the `origin` remote. */
  repo: /** @type {string | null} */ (null),

  /**
   * Where agent PRs land when `--base` is not given. `null` asks GitHub for the
   * repository's default branch. Set it when the branch that runs CI is not
   * the default one (a develop → main flow): an agent PR opened against an
   * ungated branch is the opposite of what the gates are for.
   */
  baseBranch: /** @type {string | null} */ (null),

  /**
   * Bases an agent may merge a PR into itself (`graft pr merge`). `null` means
   * `[baseBranch]`; `[]` means agents never merge — a human clicks every one.
   */
  mergeableBases: /** @type {string[] | null} */ (null),

  /**
   * The required status check on the base, by name — what "green" means for
   * the stop-the-line rule in `graft pr merge`. `null` turns that rule off.
   */
  requiredCheck: /** @type {string | null} */ (null),

  /** `graft validate` runs this in the worktree and records the base it was green on. */
  validate: {
    command: /** @type {string | null} */ (null),
  },

  /** Git hooks graft runs itself, because a publish never runs `git commit` or `git push`. */
  hooks: {
    /**
     * Repo-relative hooks directory. `null` asks git (`core.hooksPath`, else
     * `.git/hooks`). Set it when the repo tracks its hooks (`.githooks`,
     * `.husky`): a clone that never ran `git config core.hooksPath` would
     * otherwise run none of them, silently.
     */
    path: /** @type {string | null} */ (null),
    /** Which hooks run. Absent hooks are skipped unless `required`. */
    run: ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'pre-push'],
    /** Hooks whose ABSENCE refuses a publish — a gate that is missing is not a gate that passed. */
    required: /** @type {string[]} */ ([]),
  },

  protected: {
    /** Use CODEOWNERS as the manifest of protected paths. */
    codeowners: true,
    /**
     * Only CODEOWNERS lines naming one of these owners count (`@alice`,
     * `@org/team`). Empty: any line with an owner counts.
     */
    owners: /** @type {string[]} */ ([]),
    /** More patterns, CODEOWNERS syntax, protected locally whether or not GitHub enforces them. */
    extra: /** @type {string[]} */ ([]),
    /**
     * Paths no local grant can unlock, because the App cannot write them at
     * all. `.github/workflows/**` needs the Workflows permission, which the
     * App deliberately does not hold; listing it here stops an agent looking
     * for a switch that cannot exist.
     */
    impossible: ['.github/workflows/**'],
  },

  payload: {
    /** The most one publish may ADD to a single path. See gates/scope.mjs. */
    ceilingBytes: 512 * 1024,
    /** Never published, at any size. CODEOWNERS syntax. */
    neverPublish: ['*.log'],
  },

  /** Refuse to run when graft is older than this — the policy may rely on gates it lacks. */
  minVersion: /** @type {string | null} */ (null),

  /** The App (by slug, in $GRAFT_HOME/apps/) that acts for this repo. `null`: by owner, then default. */
  app: /** @type {string | null} */ (null),
})

/** @typedef {typeof DEFAULTS} ProjectConfig */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Deep merge; arrays are replaced, not concatenated — a policy list means what it says. */
export function merge(base, over) {
  if (!isObject(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue // $schema, $comment
    out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v
  }
  return out
}

/**
 * The policy can live in its own file or under the `graft` key of the root
 * `package.json`, for repos that already treat that file as a control path.
 * Exactly one place: both present is refused, since two policies that can
 * disagree are a policy nobody wrote.
 */
export const PACKAGE_FILE = 'package.json'
export const PACKAGE_KEY = 'graft'

/**
 * The names graft had while it was called agit. Read until every repo has
 * moved; any two policies present at once is refused, old or new.
 */
export const LEGACY_PROJECT_FILE = '.agit.json'
export const LEGACY_PACKAGE_KEY = 'agit'

/** Where the policy was found: `.graft.json`, `package.json`, or `null` (defaults). */
/** @typedef {typeof PROJECT_FILE | typeof PACKAGE_FILE | null} ConfigSource */

/**
 * The policy's text and source, from a reader over repo-relative paths. A
 * `package.json` with no `graft` key is not a source. Throws when both sources
 * hold a policy, or when `package.json` must be read and does not parse.
 *
 * @param {(path: string) => string | null} read
 * @returns {{ text: string | null, source: ConfigSource }}
 */
export function locateProjectConfig(read) {
  /** @type {{ text: string, source: ConfigSource, label: string }[]} */
  const found = []
  for (const file of [PROJECT_FILE, LEGACY_PROJECT_FILE]) {
    const text = read(file)
    if (text !== null && text !== undefined) found.push({ text, source: PROJECT_FILE, label: file })
  }
  const pkgText = read(PACKAGE_FILE)
  if (pkgText !== null && pkgText !== undefined) {
    let pkg
    try {
      pkg = JSON.parse(pkgText)
    } catch (err) {
      if (found.length === 1) return { text: found[0].text, source: found[0].source }
      throw new Error(`${PACKAGE_FILE}: ${/** @type {Error} */ (err).message}`)
    }
    for (const key of [PACKAGE_KEY, LEGACY_PACKAGE_KEY]) {
      if (!isObject(pkg) || pkg[key] === undefined) continue
      if (!isObject(pkg[key])) throw new Error(`${PACKAGE_FILE}: "${key}" must be an object`)
      found.push({ text: JSON.stringify(pkg[key]), source: PACKAGE_FILE, label: `${PACKAGE_FILE} "${key}"` })
    }
  }
  if (found.length > 1)
    throw new Error(
      `${found.map((f) => f.label).join(' and ')} ${found.length === 2 ? 'both' : 'all'} hold a policy; keep one`,
    )
  if (found.length === 1) return { text: found[0].text, source: found[0].source }
  return { text: null, source: null }
}

/**
 * The project config at `root`, merged over the defaults. A policy that exists
 * and does not parse THROWS: a policy that silently fell back to defaults
 * would be a policy nobody wrote.
 *
 * @param {string} root the repository (worktree) root
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(root) {
  const { text, source } = locateProjectConfig((path) => {
    const f = join(root, path)
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  })
  return parseProjectConfig(text, source ?? PROJECT_FILE)
}

/**
 * The project config from the policy's text wherever it was read — a
 * worktree, a ref, the contents API — merged over the defaults. `null` (no
 * policy) is the defaults; text that does not parse throws.
 *
 * @param {string | null} text
 * @param {string} [source] named in the error when the text does not parse
 * @returns {ProjectConfig}
 */
export function parseProjectConfig(text, source = PROJECT_FILE) {
  if (text === null || text === undefined) return /** @type {ProjectConfig} */ (merge(DEFAULTS, {}))
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${source}: ${/** @type {Error} */ (err).message}`)
  }
  return /** @type {ProjectConfig} */ (merge(DEFAULTS, raw))
}

/** The bases `graft pr merge` accepts. */
export function mergeableBases(config, baseBranch) {
  return config.mergeableBases ?? (baseBranch ? [baseBranch] : [])
}

// ---------------------------------------------------------------------------
// Machine config
// ---------------------------------------------------------------------------

/** Where App credentials and graft's caches live: `$GRAFT_HOME`, else `~/.oakgreen/graft`. */
export function graftHome(env = process.env) {
  return env.GRAFT_HOME || join(oakgreenDir({ env }), 'graft')
}

/**
 * `owners` maps a GitHub owner (user or org login, lowercased) to an App slug.
 *
 * @typedef {{ defaultApp?: string | null, owners?: Record<string, string> }} UserConfig
 */

/**
 * The machine settings: forest.json's `graft` section (`$OAKGREEN_FOREST_CONFIG_PATH` names another file). Without
 * `$GRAFT_HOME`, a machine still holding `~/.config/graft` and no section is refused (run `oakgreen config migrate`).
 * @returns {UserConfig}
 */
export function loadUserConfig(env = process.env) {
  const { forest } = readForest(forestPath(undefined, { env }))
  if (!env.GRAFT_HOME) assertMigrated('graft', forest, { env })
  return /** @type {UserConfig} */ (sectionOf(forest, 'graft'))
}

/**
 * Which App acts for `owner`: the environment, then the project's pin, then the
 * owner map, then the machine default. `null` when nothing names one — the
 * credential helper reads that as "not mine" and stays silent.
 *
 * @param {{ owner?: string, project?: { app?: string | null } | null, user?: UserConfig, env?: NodeJS.ProcessEnv }} input
 */
export function appFor({ owner, project, user = {}, env = process.env }) {
  if (env.GRAFT_APP) return env.GRAFT_APP
  if (project?.app) return project.app
  const byOwner = owner ? user.owners?.[owner.toLowerCase()] : undefined
  return byOwner ?? user.defaultApp ?? null
}

/** `{ owner, repo }` from a github.com remote URL, or `null`. */
export function parseRemote(url) {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      String(url ?? '').trim(),
    )
  return m ? { owner: m[1], repo: m[2] } : null
}
