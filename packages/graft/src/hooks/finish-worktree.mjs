// @ts-check
/**
 * PreToolUse/ExitWorktree hook — run `graft worktree done` before a remove, so
 * nobody has to remember it.
 *
 *   graft hook finish-worktree
 *
 * ExitWorktree `remove` counts the branch's commits past the SHA it recorded at
 * EnterWorktree, and every graft worktree goes past it with published history
 * (src/worktree.mjs). `graft worktree done` rewinds the branch once GitHub holds
 * everything, but only when an agent remembers to run it first. Agents forget,
 * then ask the human whether to pass `discard_changes` over work that is already
 * merged. Running `done` here makes the rewind part of the remove.
 *
 * - Only `action: "remove"` without `discard_changes`. `keep` moves nothing,
 *   and an explicit discard has already been decided.
 * - The event's cwd must be in a linked worktree. `done` refuses the main
 *   checkout, and that refusal is no opinion here.
 * - Something local only (an unpublished commit, an uncommitted path): the
 *   remove is denied with `done`'s report, which names what would be lost.
 *   ExitWorktree would refuse anyway, with only a count.
 * - Anything else (no network, no App, an older repo) has no opinion: the call
 *   goes through and ExitWorktree's own guard still applies.
 *
 * Only a backstop. ExitWorktree counts commits while it validates its input,
 * which happens before PreToolUse hooks run, so a branch with commits is
 * refused before this hook runs. The rewind that matters happens at merge time
 * (src/cli/worktree.mjs `finishAfterMerge`, called by `graft pr merge`).
 */
import { run as worktree } from '../cli/worktree.mjs'

/**
 * @param {any} event
 * @param {{ done?: typeof worktree }} [deps]
 * @returns {Promise<string | null>}
 */
export async function finish(event, { done = worktree } = {}) {
  const input = event?.tool_input ?? {}
  if (input.action !== 'remove' || input.discard_changes === true) return null
  const cwd = event?.cwd
  if (typeof cwd !== 'string' || !cwd) return null
  /** @type {string[]} */
  const said = []
  let code
  try {
    code = await done(['done', '-C', cwd], { say: (line) => said.push(line) })
  } catch {
    return null
  }
  if (code === 0) return null
  return ['graft worktree done: this worktree holds work GitHub does not have, so it was not removed.', ...said].join(
    '\n',
  )
}

/** A guard (see hooks/index.mjs): its message denies the remove. */
export const event = 'PreToolUse'

/** @param {any} input */
export const decide = (input) => finish(input)
