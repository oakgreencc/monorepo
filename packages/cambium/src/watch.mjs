// @ts-check
/**
 * Watched workflows: each repo's `watch` list names (workflow, branch) pairs whose latest run must be green, such
 * as a deploy on `main` or e2e on `develop`. Every `watchEveryMinutes` cambium reads each pair's newest completed
 * run (cancelled and skipped runs say nothing, so they are passed over) and compares it with the verdict it stored.
 *
 * - **Red** (failure, timed out, startup failure, action required): a warn event, and, unless the pair says
 *   `issue: false`, one issue labelled {@link WATCH_LABEL} that names the run. With `agent` on (the default) it is
 *   a worker's task, like a red-base repair (base-health.mjs): `q:task` at the second priority label, its body
 *   the spec ({@link agentBody}: the run, its failed jobs and steps, the log tail, the commits since the last
 *   green run). A worker that cannot fix it hands it off (phases/task.mjs `HAND_OFF`) or spends its attempts:
 *   either way it lands in `q:human`, its findings on the issue. With `agent: false` it is a `q:human` issue.
 *   A repo without the watch label gets the issue without it.
 * - **Still red on a newer run:** a "Still failing" comment on the open issue, whatever queue it is in.
 * - **Green again:** an info event, and the issue cambium opened for it is closed.
 * - **No run yet, or a read that fails:** the stored verdict stands; nothing fires.
 *
 * Verdicts live in the store (`watch:<repo>:<workflow>@<branch>`), so a restart neither re-fires nor forgets an
 * open issue, and the heartbeat carries them (`repos[].watch`).
 */
import { iso, MIN } from './issue-state.mjs'
import { Q } from './labels.mjs'
import { HAND_OFF } from './phases/task.mjs'

/** Marks an issue cambium opened for a failing watched workflow. */
export const WATCH_LABEL = 'watch'

const PASSED = new Set(['success', 'neutral'])
const SILENT = new Set(['cancelled', 'skipped', 'stale'])

/**
 * @typedef {{ id: number, url: string, sha: string, conclusion: string, at: string }} WorkflowRun
 * @typedef {{ jobs: { id: number, name: string, url: string | null, steps: string[] }[], log: string | null }} RunFailure
 *   A run's failed jobs, each with its failed steps, and the raw log of the first one (null: unreadable).
 * @typedef {{ sha: string, headline: string }} Suspect
 * @typedef {{ failure: RunFailure | null, lastGreen: WorkflowRun | null, suspects: Suspect[] | null }} RedContext
 *   What the agent issue tells its worker. `failure` null: the jobs could not be read. `lastGreen`: the newest
 *   green run older than the red one, among those read. `suspects`: the commits since it, newest first (null: no
 *   green run, or the compare failed).
 * @typedef {{
 *   workflow: string, branch: string, state: 'green' | 'red' | 'unknown', run: WorkflowRun | null,
 *   issue: number | null, checkedAt: string | null, error: string | null,
 * }} WatchState
 */

/** @param {string} slug @param {{ workflow: string, branch: string }} w */
export const watchKey = (slug, w) => `watch:${slug}:${w.workflow}@${w.branch}`

/**
 * The verdict of the newest completed run that says anything, from runs newest first. Pure.
 * @param {WorkflowRun[]} runs @returns {{ state: 'green' | 'red', run: WorkflowRun } | null}
 */
export function verdictOf(runs) {
  const run = runs.find((r) => !SILENT.has(r.conclusion))
  if (!run) return null
  return { state: PASSED.has(run.conclusion) ? 'green' : 'red', run }
}

/** @param {import('./store.mjs').Store} store @param {string} key @returns {WatchState | null} */
function load(store, key) {
  try {
    return JSON.parse(store.get(key) ?? 'null')
  } catch {
    return null
  }
}

/** Every repo's watch verdicts, as the heartbeat shows them. @param {import('./tick.mjs').Deps} deps @param {string} slug */
export function watchStates(deps, slug) {
  const repo = deps.config.repos.find((r) => r.slug === slug)
  return (repo?.watch ?? []).map(
    (w) =>
      load(deps.store, watchKey(slug, w)) ?? {
        workflow: w.workflow,
        branch: w.branch,
        state: 'unknown',
        run: null,
        issue: null,
        checkedAt: null,
        error: null,
      },
  )
}

/** @param {WatchState} s @param {string} slug */
const title = (s, slug) => `Watch: \`${s.workflow}\` is failing on \`${s.branch}\` in ${slug}`

const short = (/** @type {string} */ sha) => sha.slice(0, 7)

/** The `q:human` issue's body (`agent: false`). @param {WatchState} s */
function humanBody(s) {
  const run = /** @type {WorkflowRun} */ (s.run)
  return [
    `The newest completed run of \`${s.workflow}\` on \`${s.branch}\` concluded **${run.conclusion}**: ${run.url} (${short(run.sha)}, ${run.at}).`,
    '',
    `Opened by cambium because this repo's config watches it. cambium closes this issue once a run on \`${s.branch}\` is green again.`,
  ].join('\n')
}

/** How many lines of the failed job's log the agent issue quotes. */
export const LOG_LINES = 40
const LOG_CHARS = 6000
const FENCE = '```'

/**
 * The last {@link LOG_LINES} lines of a job log, without GitHub's per-line timestamps and ANSI colour, each line
 * cut at 300 characters. Pure. @param {string | null | undefined} log @returns {string}
 */
export function logTail(log) {
  if (!log) return ''
  const lines = String(log)
    .replace(/\r/g, '')
    .split('\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, ''))
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
  while (lines.length && !lines.at(-1)?.trim()) lines.pop()
  const tail = lines.slice(-LOG_LINES).join('\n').replaceAll(FENCE, "'''")
  return tail.length > LOG_CHARS ? tail.slice(-LOG_CHARS) : tail
}

/** @param {RunFailure['jobs'][number]} j */
const jobLine = (j) =>
  `- job \`${j.name}\`${j.url ? ` (${j.url})` : ''}: ${
    j.steps.length
      ? j.steps.map((st) => `step \`${st}\``).join(', ')
      : 'no failed step (it died outside its steps: a lost runner, or a job-level timeout)'
  }`

/**
 * The agent issue's body: the worker's spec. Pure.
 * @param {WatchState} s @param {RedContext} c
 */
export function agentBody(s, { failure, lastGreen, suspects }) {
  const run = /** @type {WorkflowRun} */ (s.run)
  const jobs = failure?.jobs ?? []
  const tail = logTail(failure?.log)
  const failing = !failure
    ? ["The run's jobs could not be read: start from the run page."]
    : jobs.length
      ? jobs.map(jobLine)
      : ['No job reports a failure (a startup failure, or a run waiting on an approval): start from the run page.']
  const since = lastGreen
    ? [
        `Last green run: ${lastGreen.url} on ${short(lastGreen.sha)}.${suspects ? ' Commits since, newest first:' : ' The commits since could not be read.'}`,
        ...(suspects ? ['', ...suspects.map((c) => `- ${short(c.sha)} ${c.headline}`)] : []),
      ]
    : ['No green run among the recent ones: the cause may be older, or outside the repo.']
  return [
    `\`${s.workflow}\` is red on \`${s.branch}\`: its newest completed run concluded **${run.conclusion}** on ${short(run.sha)} (${run.sha}): ${run.url} (${run.at}).`,
    '',
    `Opened by cambium because this repo's config watches it. cambium comments here while newer runs still fail, and closes this issue once a run on \`${s.branch}\` is green again.`,
    '',
    '## Failing',
    '',
    ...failing,
    ...(tail
      ? ['', `Log tail (job \`${jobs[0]?.name}\`, last ${LOG_LINES} lines):`, '', `${FENCE}text`, tail, FENCE]
      : []),
    '',
    '## Suspects',
    '',
    ...since,
    '',
    '## Work',
    '',
    `1. Read why it failed: \`graft jobs ${run.url}\` (\`--logs <dir>\` writes the full logs). Reproduce it in your worktree where you can.`,
    '2. Fix forward when the fix is clear and small. Otherwise revert the commit that broke it, and say on the PR which one and why.',
    `3. Change only what makes \`${s.workflow}\` green; do not fold other work into this PR.`,
    '4. Hand off when the fix is not one you can push: a change under `.github/workflows/**` (the App has no Workflows permission), a secret or a setting, or an outage outside the repo. Post your findings on this issue with `graft issue comment <this issue> --body-file <file>`, the first line of the file exactly',
    `   \`${HAND_OFF}\`, then what failed, why, and the fix (as a diff, where it is a patch) for a person to apply. Then exit without a PR: cambium moves this issue to \`q:human\` at once, without spending more attempts.`,
    '5. Whatever else stops you, post what you found before you exit without a PR, so whoever takes this over starts where you stopped.',
    '',
    '## Done when',
    '',
    `- Your PR's CI is green, and once it merges the next run of \`${s.workflow}\` on \`${s.branch}\` is green (cambium then closes this issue).`,
  ].join('\n')
}

/**
 * What the agent issue tells its worker, read best effort: a failed read leaves its part out.
 * @param {import('./tick.mjs').Deps} deps @param {string} slug @param {WorkflowRun} red @param {WorkflowRun[]} runs
 * @returns {Promise<RedContext>}
 */
async function redContext(deps, slug, red, runs) {
  const at = runs.findIndex((r) => r.id === red.id)
  const lastGreen = runs.slice(at + 1).find((r) => PASSED.has(r.conclusion)) ?? null
  const where = { repo: slug }
  const msg = (/** @type {unknown} */ err) => /** @type {Error} */ (err)?.message ?? String(err)
  /** @type {RunFailure | null} */
  let failure = null
  try {
    failure = deps.github.runFailure ? await deps.github.runFailure(slug, red.id) : null
  } catch (err) {
    deps.log('warn', `watch: reading the jobs of run ${red.id}: ${msg(err)}`, where)
  }
  /** @type {Suspect[] | null} */
  let suspects = null
  if (lastGreen)
    try {
      const range = await deps.github.compareRange(slug, lastGreen.sha, red.sha)
      suspects = range.commits
        .map((c) => ({ sha: c.sha, headline: c.message.split('\n')[0] }))
        .reverse()
        .slice(0, 20)
    } catch (err) {
      deps.log('warn', `watch: comparing ${short(lastGreen.sha)}...${short(red.sha)}: ${msg(err)}`, where)
    }
  return { failure, lastGreen, suspects }
}

/**
 * The watch step: due every `watchEveryMinutes` per repo, then each pair is read and compared.
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx
 */
export async function watchWorkflows(deps, ctx) {
  const every = deps.config.watchEveryMinutes
  for (const repo of deps.config.repos) {
    if (!repo.watch.length || every <= 0) continue
    const dueKey = `watch.checkedAt:${repo.slug}`
    const last = Number(deps.store.get(dueKey) ?? 0)
    if (ctx.now - last < every * MIN) continue
    deps.store.set(dueKey, String(ctx.now))
    for (const w of repo.watch) await checkOne(deps, ctx, repo.slug, w)
  }
}

/**
 * @param {import('./tick.mjs').Deps} deps @param {import('./tick.mjs').Ctx} ctx @param {string} slug
 * @param {import('./config.mjs').Watch} w
 */
async function checkOne(deps, ctx, slug, w) {
  const key = watchKey(slug, w)
  /** @type {WatchState} */
  const prev = load(deps.store, key) ?? {
    workflow: w.workflow,
    branch: w.branch,
    state: 'unknown',
    run: null,
    issue: null,
    checkedAt: null,
    error: null,
  }
  const save = (/** @type {Partial<WatchState>} */ next) =>
    deps.store.set(key, JSON.stringify({ ...prev, ...next, checkedAt: iso(ctx.now) }))
  const where = { repo: slug }
  const name = `\`${w.workflow}\` on \`${w.branch}\``
  /** @type {WorkflowRun[]} */
  let runs
  try {
    runs = await deps.github.workflowRuns(slug, w.workflow, w.branch)
  } catch (err) {
    const error = /** @type {Error} */ (err)?.message ?? String(err)
    save({ error })
    deps.log('error', `watch ${name}: ${error}`, where)
    return
  }
  const v = verdictOf(runs)
  if (!v) return save({ error: null })
  if (v.state === 'red') {
    const fresh = prev.state !== 'red' || prev.run?.id !== v.run.id
    let issue = prev.issue
    if (prev.state !== 'red') deps.log('warn', `watch ${name} is red: ${v.run.conclusion} ${v.run.url}`, where)
    if (w.issue && issue === null) {
      const next = { ...prev, state: /** @type {const} */ ('red'), run: v.run }
      const made = w.agent
        ? await openIssue(deps, slug, next, {
            body: agentBody(next, await redContext(deps, slug, v.run, runs)),
            labels: [Q.task, deps.config.priorityLabels[1] ?? deps.config.priorityLabels[0]].filter(Boolean),
          })
        : await openIssue(deps, slug, next, { body: humanBody(next), labels: [Q.human] })
      issue = made
      if (made !== null) deps.log('warn', `watch ${name} is red; opened #${made}`, { repo: slug, issue: made })
    } else if (w.issue && issue !== null && fresh && prev.state === 'red') {
      await deps.github
        .comment(slug, issue, `Still failing: ${v.run.conclusion} on ${short(v.run.sha)}, ${v.run.url}`)
        .catch((/** @type {Error} */ err) => deps.log('error', `watch ${name}: ${err?.message ?? err}`, where))
    }
    return save({ state: 'red', run: v.run, issue, error: null })
  }
  if (prev.state === 'red') {
    deps.log('info', `watch ${name} is green again at ${short(v.run.sha)}`, where)
    if (prev.issue !== null)
      try {
        await deps.github.close(
          slug,
          prev.issue,
          `\`${w.workflow}\` is green again on \`${w.branch}\`: ${v.run.url} (${iso(ctx.now)}).`,
          { reason: 'completed' },
        )
        deps.log('info', `watch ${name}: closed #${prev.issue}`, { repo: slug, issue: prev.issue })
      } catch (err) {
        deps.log('error', `watch ${name}: closing #${prev.issue}: ${/** @type {Error} */ (err)?.message ?? err}`, where)
        return save({ state: 'green', run: v.run, error: null })
      }
  }
  save({ state: 'green', run: v.run, issue: null, error: null })
}

/**
 * One issue for a red pair, with `labels` and {@link WATCH_LABEL}; with `labels` alone when the repo has no such
 * label. null when neither works (logged), so the next due check tries again.
 * @param {import('./tick.mjs').Deps} deps @param {string} slug @param {WatchState} s
 * @param {{ body: string, labels: string[] }} spec
 */
async function openIssue(deps, slug, s, { body, labels }) {
  const issue = { title: title(s, slug), body }
  try {
    return (await deps.github.createIssue(slug, { ...issue, labels: [...labels, WATCH_LABEL] })).number
  } catch (err) {
    const msg = /** @type {Error} */ (err)?.message ?? String(err)
    if (!/does not exist|not found/i.test(msg)) {
      deps.log('error', `watch \`${s.workflow}\`: opening an issue: ${msg}`, { repo: slug })
      return null
    }
  }
  try {
    return (await deps.github.createIssue(slug, { ...issue, labels })).number
  } catch (err) {
    deps.log('error', `watch \`${s.workflow}\`: opening an issue: ${/** @type {Error} */ (err)?.message ?? err}`, {
      repo: slug,
    })
    return null
  }
}
