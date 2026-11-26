// @ts-check
import { existsSync } from 'node:fs'
import { envFilePath, writeAtomic } from '@oakgreencc/mycelium/forest'
import { DEFAULT_PRIORITY_LABELS, writeLabelGuide } from './label-guide.mjs'
import {
  QUEUE_LABELS,
  cambiumSkeleton,
  configuredRepos,
  forestConfigPath,
  gitRoot,
  myceliumSources,
  readForestFile,
  slugFromRemote,
} from './stack.mjs'

/**
 * @typedef {{
 *   env: import('./stack.mjs').Env,
 *   home: string,
 *   cwd: string,
 *   config?: string,
 *   repo?: string,
 *   dryRun: boolean,
 *   exec: import('./tools.mjs').Exec,
 *   github: import('./github.mjs').GithubClient,
 *   print: (line: string) => void,
 * }} Context
 */

/** @param {Context} ctx @returns {Promise<string | null>} */
async function originSlug(ctx) {
  const r = await ctx.exec('git', ['remote', 'get-url', 'origin'], { cwd: ctx.cwd })
  return r.code === 0 ? slugFromRemote(r.stdout) : null
}

/**
 * Idempotent: creates only what is missing. Never rewrites an existing file, except to add the `cambium` section to
 * forest.json (other sections kept) and the label-guide pointer block to the repo's CLAUDE.md or AGENTS.md. Creates an
 * empty `~/.oakgreen/env` (0600) for secrets.
 *
 * @param {Context} ctx
 * @returns {Promise<{ ok: boolean, created: string[], steps: string[] }>}
 */
export async function runSetup(ctx) {
  const { print, dryRun } = ctx
  const created = []
  const steps = []
  let ok = true

  const file = forestConfigPath(ctx)
  const existing = readForestFile(file)
  let config = existing.config
  if (existing.error) {
    print(`! ${file} is not a JSON object (${existing.error}); left as is`)
    ok = false
  } else if (existing.present) {
    print(`= "cambium" section in ${file} exists; left as is`)
  } else {
    const slug = ctx.repo ?? ctx.env.MYCELIUM_REPO ?? (await originSlug(ctx))
    config = cambiumSkeleton(slug ?? 'OWNER/NAME', gitRoot(ctx.cwd) ?? ctx.cwd)
    if (!slug) steps.push(`Set cambium.repos[0].slug in ${file}`)
    if (dryRun) print(`+ would write the "cambium" section of ${file}`)
    else {
      writeAtomic(file, `${JSON.stringify({ ...(existing.forest ?? {}), cambium: config }, null, 2)}\n`)
      print(`+ wrote the "cambium" section of ${file}`)
      created.push(file)
    }
  }
  const envFile = envFilePath({ home: ctx.home, env: ctx.env })
  if (!existsSync(envFile)) {
    if (dryRun) print(`+ would create ${envFile} (0600, for secrets)`)
    else {
      writeAtomic(envFile, '# Secrets for the oakgreen stack: KEY=value, one per line. Never in forest.json.\n', 0o600)
      print(`+ created ${envFile} (0600, for secrets)`)
      created.push(envFile)
    }
  }

  const repos = configuredRepos({ repo: ctx.repo, config, env: ctx.env }).filter((r) => r !== 'OWNER/NAME')
  if (!repos.length) steps.push('Re-run `oakgreen setup --repo owner/name` to create the queue labels')
  for (const repo of repos) {
    try {
      const have = new Set(await ctx.github.listLabels(repo))
      for (const label of QUEUE_LABELS) {
        if (have.has(label.name)) continue
        if (dryRun) print(`+ would create label ${label.name} on ${repo}`)
        else {
          await ctx.github.createLabel(repo, label)
          print(`+ created label ${label.name} on ${repo}`)
          created.push(`${repo}#${label.name}`)
        }
      }
      if (QUEUE_LABELS.every((l) => have.has(l.name))) print(`= queue labels on ${repo} all present`)
    } catch (err) {
      ok = false
      print(`! labels on ${repo}: ${/** @type {Error} */ (err).message}`)
    }
  }

  const root = gitRoot(ctx.cwd)
  const here = root ? await originSlug(ctx) : null
  if (root && here && repos.includes(here)) {
    const priorityLabels = Array.isArray(config?.priorityLabels) ? config.priorityLabels : DEFAULT_PRIORITY_LABELS
    const guide = writeLabelGuide({ root, priorityLabels, dryRun, print })
    created.push(...guide.created)
    steps.push(...guide.steps)
  } else if (repos.length) {
    steps.push(`Run oakgreen setup from a clone of ${repos.join(' or ')} to write its label guide for agents`)
  }

  steps.push(
    'Create the GitHub Apps (cambium and workers) and install them on the repo: graft setup app',
    `Set cambium.graft.app, cambium.graft.botLogin and cambium.worker.graftApp in ${file}`,
    'Start the services: oakgreen start (installs the launchd agents on first run)',
  )
  if (!myceliumSources(ctx.env).length)
    steps.push(
      `Optional: mycelium settings in the "mycelium" section of ${file}, credentials in ${envFile} (see the mycelium README), then: oakgreen start mycelium`,
    )
  print('\nRemaining human steps:')
  for (const [i, s] of steps.entries()) print(`  ${i + 1}. ${s}`)
  print('Then run: oakgreen doctor')
  return { ok, created, steps }
}
