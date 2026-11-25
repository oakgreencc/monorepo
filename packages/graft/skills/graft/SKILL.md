---

name: graft
description: Write to GitHub through graft, a GitHub App, instead of git push or gh. Use when committing, pushing, opening or merging a PR, reading, filing, commenting on or closing an issue, waiting for or reading CI, or when graft refuses a publish; and when setting up graft (App, credentials, repo bootstrap).
allowed-tools: Bash(graft *), Bash(echo *)
---

# graft

Local git is **read-only** toward GitHub: fetch, diff, merge, stash, run tests. Every **write** — commit, branch, PR, merge, comment — goes through `graft`, which has GitHub create the commit through the API so it lands **Verified** as the App. `git push`, `gh`, and personal tokens are refused by hooks; reach for the matching verb below instead.

Installed: !`graft --version 2>/dev/null || echo "NO — graft is not on PATH"`

If that line shows anything but a version number, check with `graft --version`; if that fails too, graft is not installed and nothing below works yet: the hooks and the credential helper call `graft` by name. Ask the human to install it and run setup — see [Setup](#setup).

Every verb takes `-C <dir>` and `--repo <owner/repo>` (default: the `origin` remote). `graft <verb> --help` is the source of truth for flags.

## Publishing work

1. **Branch.** Pick a fresh branch name (`agent/<topic>`). The base comes from `.graft.json` `baseBranch`, else the repo's default branch; `--base <b>` picks another base, but only one in `mergeableBases`: graft refuses to cut a branch from, or open a PR against, any other (stacked PRs cannot land). Staged work is two issues, the second blocked by the first.
2. **Validate.** `graft validate` runs the project's check and records the base it was green on. Done when it exits 0.
3. **Publish.** Uncommitted changes in the worktree → one Verified commit:

   ```
   graft publish agent/<topic> "<message>" --paths a,b --pr "<title>" --pr-body-file <f> --closes 12
   ```

   Name every path with `--paths`; `--all` means every dirty path, untracked included, on purpose. The repo's git hooks (pre-commit, commit-msg, pre-push) run before anything is sent. Done when the output shows `commit: … [Verified]` and, with `--pr`, a `pr:` URL.
4. **Follow up.** Later commits to the same branch: same `publish` command without `--pr`. The worktree advances onto each published commit automatically.
5. **Before removing the worktree.** `graft status [<branch>]` says what it holds that GitHub does not (uncommitted paths, commits no branch on GitHub contains, whether the PR merged), checked through the API — never `git fetch` to find out. `publish` and `merge` end with the same verdict line. A worktree tool that reports "discarded N commits" after publishing is counting from where the session started; trust `nothing local that GitHub does not have`.
6. **Finish.** `graft worktree done [<branch>]` first puts back any path an earlier HEAD left staged (content GitHub already holds, untouched since), then asks the same question; when GitHub holds everything it rewinds the branch to the commit the worktree was created on (the one `ExitWorktree` counts from) and fast-forwards the main checkout's base. Then `ExitWorktree` `remove` passes without `discard_changes`. `graft pr merge` run inside the PR's own worktree runs `done` right after the merge. When the PR merged another way (queue, auto-merge), run `done` yourself before the remove. The `finish-worktree` hook cannot do it for you: ExitWorktree counts commits before PreToolUse hooks run. If it exits 1 or the remove is denied, the worktree holds work GitHub lacks: never reach for `discard_changes` to get past that.

## Other writes

| Need                                             | Verb                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Branch moved under you / follow someone's branch | `graft advance <branch>` — never `reset --hard`                                                                                     |
| Merge conflict                                   | `git fetch origin <base>`, `git merge --no-commit origin/<base>`, resolve, `git add`, then `graft merge <branch>` (no local commit) |
| Merge a PR                                       | `graft pr merge <n>` (`--auto` to queue)                                                                                            |
| Update a PR from its base                        | `graft pr update <n>`                                                                                                               |
| Read an issue                                    | `graft issue read <n>` — JSON, with the `etag` an edit needs                                                                        |
| Open an issue                                    | `graft issue create --title "<t>" --body-file <f> [--labels a,b]`                                                                   |
| Comment on an issue or PR                        | `graft issue comment <n> --body-file <f>`                                                                                           |
| Close an issue                                   | `graft issue close <n> --body-file <f> [--reason completed\|not_planned\|duplicate]` — comments, then closes                        |
| Edit an issue body                               | `graft issue read <n>`, edit, `graft issue edit <n> --body-file <f> --etag <etag>` — refused if it changed since the read           |
| Assign / label                                   | `graft issue assign <n> --login <l>`; `graft issue label <n> --add a,b --remove c` (added labels must exist)                        |
| Wait for CI                                      | `graft ci wait <sha\|branch> [--check <name>]` — exit 0 green, 1 red, 2 unknowable (never treat 2 as green)                         |
| Any read                                         | `graft api GET <path>` — add `--paginate` on every list                                                                             |
| Why CI failed                                    | `graft jobs <run URL> --logs <dir>`, then read the failed job's log                                                                 |
| Projects v2                                      | `graft graphql '<query>'`                                                                                                           |
| Anything else (reviews, …)                       | `graft api <METHOD> <path> --body-file <f>`                                                                                         |

Bodies always come from a file (`--body-file -` reads stdin); an inline `--body` on `graft issue` is refused, because the shell eats backticks. Write the body with your file tool, or `echo … | graft issue comment <n> --body-file -`.

## Refusals

graft refuses before writing anything, and each refusal ends with the exact next command. Run that command. Overrides (`--allow-displacement`, `--stale-base-ok`, `--allow-large <paths>`) exist for the case the message describes; pass one only when that case is true, and say so in your report.

**Protected paths** — anything CODEOWNERS assigns an owner, plus `.graft.json`, CODEOWNERS itself, and `.claude/settings.json`. Editing or publishing one needs a human's **grant**. Stop, tell the human what you need and why, and relay the command from the refusal:

```
! graft maintainer grant "<why this session needs it>" --scope protected
```

The human runs it; a grant you run yourself is refused. Scopes: `protected` (edit/publish protected paths), `no-verify` (skip git hooks), `merge` (self-merge past local merge policy). `graft maintainer status` shows what this session holds. `.github/workflows/**` has no grant: the App cannot write it — describe the patch for the human.

For what a specific refusal means, read [references/refusals.md](references/refusals.md).

## Setup

When `graft` is missing, credentials are absent, or `graft doctor` reports ✗, read [references/setup.md](references/setup.md). Setup opens a browser and creates a GitHub App, so a human runs it.
