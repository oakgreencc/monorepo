// @ts-check
/**
 * `graft worktree done [<branch>]` — finish a worktree whose work is all on
 * GitHub, so `ExitWorktree remove` passes without `discard_changes`.
 *
 *   0. put back strays — paths an earlier HEAD left in the index, whose
 *      content GitHub holds (src/worktree.mjs `tidy`) — so they do not read as
 *      local work;
 *   1. ask `graft status`'s question (src/status.mjs); anything local only →
 *      print the report, exit 1, change nothing;
 *   2. rewind the branch to the commit the worktree was created on
 *      (src/worktree.mjs explains why that is the commit ExitWorktree counts
 *      from);
 *   3. fetch the base the way graft fetches (origin over `graft credential`)
 *      and fast-forward the main checkout's base onto it, under the
 *      sync-worktree rules (ff-only, never a dirty checkout), so the merged
 *      work is in local `main` too.
 */

import { has, positionals } from '../context.mjs'
import { PublishError } from '../errors.mjs'
import { syncMain } from '../hooks/sync-worktree.mjs'
import { dirtyPaths } from '../publish/publish.mjs'
import { localOnly, onGitHub, statusLines, verdict } from '../status.mjs'
import { rewind, tidy } from '../worktree.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

const USAGE =
  'usage: graft worktree done [<branch>] [-C <dir>] [--repo <owner/repo>]\n\n' +
  'Run when the work is merged, before ExitWorktree remove (or git worktree remove). If GitHub holds\n' +
  'everything in this worktree, rewinds its branch to the commit the worktree was created on — the\n' +
  "commit ExitWorktree counts from — and fast-forwards the main checkout's base branch. Anything\n" +
  'local only: prints what, exits 1, changes nothing. <branch> is the branch you published to.'

/**
 * @param {string[]} argv
 * @param {{ client?: import('../github/app.mjs').Client, say?: (line: string) => void }} [deps]
 */
export async function run(argv, { client: given, say = console.log } = {}) {
  if (has(argv, '--help')) {
    say(USAGE)
    return 0
  }
  const [sub, branch, ...extra] = positionals(argv, COMMON_VALUE_FLAGS)
  if (sub !== 'done' || extra.length) throw new PublishError(USAGE)
  const ctx = contextFrom(argv, { client: given ?? null })
  const { git } = ctx
  const root = /** @type {string} */ (ctx.root)
  const dirs = git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split('\n')
  if (dirs[0] === dirs[1])
    throw new PublishError(`${root} is the main checkout, not a linked worktree: nothing to finish.`)

  const { owner, repo } = ctx.repo()
  const client = await ctx.client()
  const base = await ctx.baseBranch()
  let local = null
  try {
    local = git(['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null
  } catch {} // detached
  const refs = [base, branch, local].filter((r) => r != null)
  const tidied = await tidy({
    git,
    dirty: dirtyPaths(git),
    held: (sha) => onGitHub({ client, owner, repo, sha, refs }),
  })
  if (tidied.length)
    say(
      `Put back ${tidied.length} path${tidied.length === 1 ? '' : 's'} an earlier HEAD left behind (GitHub holds them):\n` +
        tidied.map((p) => `  ${p}`).join('\n'),
    )
  const status = await localOnly({ git, client, owner, repo, base, branch: branch ?? null })
  const out = rewind({ git, status })
  if (!out.rewound && out.why === 'local-only') {
    for (const line of statusLines(status)) say(line)
    say('Not finished: publish it (graft publish) or confirm with the user that it may be discarded.')
    return 1
  }
  say(verdict(status))
  if (out.rewound)
    say(
      `Rewound ${status.local ?? 'HEAD'} ${out.from.slice(0, 7)} → ${out.to.slice(0, 7)}, the commit this worktree was created on.`,
    )
  else if (out.why === 'unknown-entry')
    say('Could not tell which commit this worktree was created on, so its branch was left where it is.')

  try {
    git(['fetch', '--quiet', 'origin', base])
    const main = syncMain(root, base, git(['rev-parse', 'FETCH_HEAD']).trim())
    if (main) say(main)
  } catch (err) {
    say(`Could not bring the main checkout's ${base} up to date: ${/** @type {Error} */ (err)?.message ?? err}`)
  }
  say('Done: remove it with ExitWorktree action "remove" (no discard_changes), or git worktree remove.')
  return 0
}

/**
 * After `graft pr merge` lands a PR: when the command ran inside that PR's own
 * linked worktree (HEAD is the PR head), finish the worktree now with `done`,
 * so `ExitWorktree remove` passes later.
 *
 * This cannot wait for the finish-worktree hook. ExitWorktree checks its commit
 * count while it validates its input, and that happens before PreToolUse hooks
 * run. So a branch the hook rewinds has already been counted and refused. The
 * merge is the first moment the rewind is safe: before it, the published commit
 * is the worktree's content.
 *
 * Best effort. A failure is reported and never fails the merge. Anywhere else
 * (the main checkout, another branch, no repository) it does nothing.
 *
 * @param {{ git: (args: string[]) => string, root: string | null, headSha: string, branch: string,
 *   argv?: string[], client?: import('../github/app.mjs').Client,
 *   done?: typeof run, say?: (line: string) => void }} o
 * @returns {Promise<'finished' | 'skipped' | 'failed'>}
 */
export async function finishAfterMerge({
  git,
  root,
  headSha,
  branch,
  argv = [],
  client,
  done = run,
  say = console.log,
}) {
  if (!root) return 'skipped'
  try {
    const dirs = git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split('\n')
    if (dirs[0] === dirs[1]) return 'skipped'
    if (git(['rev-parse', 'HEAD']).trim() !== headSha) return 'skipped'
  } catch {
    return 'skipped'
  }
  const repo = argv.indexOf('--repo')
  const extra = repo >= 0 && argv[repo + 1] ? ['--repo', argv[repo + 1]] : []
  say(`Finishing this worktree now that its PR is merged (graft worktree done ${branch}):`)
  try {
    if ((await done(['done', branch, '-C', root, ...extra], { client, say })) === 0) return 'finished'
  } catch (err) {
    say(`  could not: ${/** @type {Error} */ (err)?.message ?? err}`)
  }
  say(`Not finished: run \`graft worktree done ${branch}\` before ExitWorktree remove.`)
  return 'failed'
}
