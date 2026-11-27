---
title: graft CLI
description: Every graft verb, its flags and its exit codes.
sidebar:
  order: 1
---

Package: `@oakgreencc/graft`. Node ≥ 22, no dependencies. The legacy command name `agit` runs the same binary.

## Common flags

| Flag | Meaning |
| --- | --- |
| `-C <dir>` | Run as if in `<dir>`. |
| `--repo <owner/repo>` | Target repository. Default: the `origin` remote. |
| `--help` | The verb's usage line. |

## Write path

Every write is a commit GitHub creates, signed and shown as **Verified** as the App.

### `graft publish`

```
graft publish <branch> <message> (--paths a,b | --all) [--base <b>] [--pr <title>]
  [--pr-body <text> | --pr-body-file <f>] [--draft] [--closes 82,196] [--no-advance]
  [--no-verify] [--allow-large a,b] [--allow-displacement] [--stale-base-ok]
```

Lands the worktree's changes to the named paths as one commit on `<branch>`.

| Flag | Meaning |
| --- | --- |
| `--paths a,b` | Paths the commit carries. |
| `--all` | Every dirty path, untracked included. |
| `--base <b>` | Branch to create `<branch>` from and open the PR against. Default: `baseBranch`, else the repository's default branch. Must be in `mergeableBases` when the publish creates the branch or opens the PR; a maintainer grant with the `merge` scope lifts this. |
| `--pr <title>` | Open a PR with this title. |
| `--pr-body`, `--pr-body-file` | PR body, inline or from a file. |
| `--draft` | Open the PR as a draft. |
| `--closes <n,…>` | Issues the PR closes. |
| `--no-advance` | Leave the worktree's HEAD where it is after publishing. |
| `--no-verify` | Skip the repository's git hooks. Needs a `no-verify` grant. |
| `--allow-large <paths>` | Exempt these paths from the payload gate. |
| `--allow-displacement` | Publish even though it reverts changes on the branch. |
| `--stale-base-ok` | Publish onto a base other than the one `graft validate` recorded. |

Git hooks run, in order, at the equivalent moments: `pre-commit`, `prepare-commit-msg`, `commit-msg`, `pre-push`. Output ends with `commit: … [Verified]`, a `pr:` URL when `--pr` was given, and the [`graft status`](#graft-status) verdict.

### `graft merge`

```
graft merge <branch> [--message <text>] [--base <b>] [--allow-large a,b] [--no-advance]
  [--no-verify] [--stale-base-ok]
```

Publishes the worktree's local merge (`git merge --no-commit`, resolved, `git add`) as a two-parent commit. No local commit needed; a merge committed locally publishes the same way. `--message` overrides `MERGE_MSG`.

### `graft advance`

```
graft advance <branch>
```

Moves HEAD onto the branch head on GitHub without discarding uncommitted work.

### `graft pr`

```
graft pr merge <n> [--method merge|squash|rebase] [--auto]
graft pr update <n>
```

| Verb | Behaviour |
| --- | --- |
| `pr merge` | Merges the PR if the [merge policy](/reference/graft/refusals/#graft-pr-merge-refusals) allows. `--auto` arms auto-merge; a PR that is already mergeable is merged at once. After a merge, run inside the PR's own worktree, it runs `graft worktree done` there. A failure there is reported and does not fail the merge. |
| `pr update` | Brings the PR up to date with its base. |

### `graft issue`

```
graft issue read <n>
graft issue create --title <t> --body-file <f> [--labels a,b]
graft issue comment <n> --body-file <f>
graft issue close <n> --body-file <f> [--reason completed|not_planned|duplicate]
graft issue edit <n> --body-file <f> --etag <etag>
graft issue assign <n> --login <login>
graft issue label <n> [--add a,b] [--remove c,d]
```

| Action | Behaviour |
| --- | --- |
| `read` | The issue as JSON, with the `etag` that `edit` needs. Exit 1 with nothing on stdout if unreadable. |
| `create` | Opens an issue. Added labels must exist. |
| `comment` | Comments on an issue or PR. |
| `close` | Comments, then closes. |
| `edit` | Replaces the body. Refused if the body changed since the read that produced `--etag`. |
| `assign` | Assigns a login. |
| `label` | Adds and removes labels. Added labels must exist. |

Bodies come only from files. `--body-file -` reads stdin. An inline `--body` is refused.

## Read path

| Verb | Usage | Behaviour |
| --- | --- | --- |
| `graft api` | `graft api <METHOD> <path> [--body <json> \| --body-file <f>] [--header <k:v>]… [--include] [--paginate] [--raw] [--out <f>]` | Any REST call as the App. JSON pretty-printed; text bodies printed as-is. `--raw`, `--paginate` and `--out` are mutually exclusive output modes. `--header` sends a request header (repeatable; not `Authorization`). `--include` prints `HTTP <status>`, the `etag` and rate-limit headers and a blank line before the body; not with `--paginate` or `--out`. With your own `If-None-Match`, a 304 exits 0 with an empty body. |
| `graft graphql` | `graft graphql '<query>' [--vars <json> \| --vars-file <f>]` | A GraphQL query as the App. |
| `graft jobs` | `graft jobs <run-id \| run URL> [--logs <dir>] [--all]` | A workflow run's jobs; `--logs` saves job logs. |
| `graft ci wait` | `graft ci wait <sha\|ref> [--check <name>] [--timeout <s>] [--interval <s>]` | One check's verdict. Default check: `requiredCheck`. |
| `graft status` | `graft status [<branch>] [--base <b>]` | What the worktree holds that GitHub does not: uncommitted paths, and local commits no branch on GitHub contains. Read through the API, no fetch. |
| `graft worktree done` | `graft worktree done [<branch>]` | If GitHub holds everything, rewinds the branch to the commit the worktree was created on and fast-forwards the main checkout's base branch. Otherwise prints what is local only, exits 1, changes nothing. `graft pr merge` runs it after merging, when run inside the PR's own worktree (its HEAD is the PR head). |
| `graft credential get` | — | git credential helper; git runs it. |

### `graft ci wait` exit codes

| Exit | Verdict |
| --- | --- |
| 0 | green |
| 1 | red |
| 2 | unknowable: newest run cancelled, skipped or neutral; timed out; or check runs unreadable three times in a row. The JSON's `reason` says which. |

No `--check` and no `requiredCheck` is a usage error.

### `graft status` verdict

The last line is `nothing local that GitHub does not have` when GitHub holds everything in the worktree.

## Gates and grants

| Verb | Usage | Behaviour |
| --- | --- | --- |
| `graft validate` | `graft validate [--base <b>] [-- <command…>]` | Runs `validate.command` (or the given command) and records the base it was green on. |
| `graft protected` | `graft protected [paths…] [--changed] [--ref <ref>]` | What CODEOWNERS and `.graft.json` protect, and why. |
| `graft maintainer` | see below | Scoped, session-bound grants. |

```
graft maintainer status
graft maintainer grant "<reason, more than one word>" [--scope protected,no-verify,merge] [--hours N] [--session <id>]
graft maintainer revoke [--session <id>]
```

| Scope | Lifts |
| --- | --- |
| `protected` (default) | Editing and publishing protected paths. The PR still needs code-owner review. |
| `no-verify` | Publishing without the repository's git hooks. |
| `merge` | `graft pr merge` past the local merge policy (base, protected paths, red base), and `graft publish` onto a base outside `mergeableBases`. |

A grant binds one session: the one it is typed into, or `--session`. Default expiry 4 hours, maximum 24. A grant run by the agent itself is refused. Grants and their log live in `<git-common-dir>/graft/`.

## Setup

| Verb | Usage | Behaviour |
| --- | --- | --- |
| `graft setup` | `graft setup [--yes]` | The App, if this repository's owner has none, then the project. |
| `graft setup app` | `graft setup app [--owner <user> \| --org <org>] [--name <app-name>] [--projects] [--no-wait] [--yes]` | Creates the GitHub App through the manifest flow, stores its key, opens the install page. Default name `<owner>-agents`. `--projects` adds organisation Projects write. |
| `graft setup app --manual` | `graft setup app --manual [--app-id <id>] [--key <pem>]` | Registers an existing App. |
| `graft setup project` | see below | Writes `.graft.json`, CODEOWNERS and `.claude/settings.json`; creates or extends the base branch ruleset. |
| `graft doctor` | `graft doctor` | Checks the machine and repository. `✗` is broken; `!` works with less protection than it appears. |
| `graft hook` | `graft hook <guard-credentials\|guard-protected\|guard-pr-writes\|sync-worktree\|finish-worktree\|session-check>` | Claude Code hook entry points. Read the event JSON on stdin. |

```
graft setup project [--config-in <.graft.json | package.json>] [--base <branch>]
  [--validate "<command>"] [--required-check <name>] [--mergeable <a,b | none>]
  [--codeowner <@handle>] [--hooks-path <dir>] [--app-branches <prefix | none>]
  [--auto-merge | --no-auto-merge] [--no-claude] [--no-doctor] [--yes]
```

Without a terminal (a `!` command in Claude Code), setup behaves as if `--yes` were given: every question takes its default.

See also: [configuration](/reference/graft/configuration/), [refusals](/reference/graft/refusals/), [GitHub App and rulesets](/reference/graft/github-app/).
