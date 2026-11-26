---
title: graft configuration
description: The .graft.json project policy, its defaults, and where graft keeps machine state.
sidebar:
  order: 2
---

## Location

The project policy is `.graft.json` at the repository root, or the same object under a `"graft"` key in the root `package.json`. Only one may exist; both present is refused. Either is a [protected path](/reference/glossary/#protected-path).

With the `package.json` form, graft protects the `"graft"` key, not the whole file. GitHub cannot enforce a key, so `graft doctor` warns unless CODEOWNERS also owns `/package.json`.

Legacy names are still read: `.agit.json`, the `"agit"` key, `AGIT_*` variables.

The machine settings (which App acts for which owner) are the `graft` section of `~/.oakgreen/forest.json` (`$OAKGREEN_FOREST_CONFIG_PATH` names another file): `defaultApp`, and `owners`, a map of lowercased owner login to App slug. `graft setup app` writes it. Without `$GRAFT_HOME`, no `graft` section while `~/.config/graft` is still there makes graft refuse and name `oakgreen config migrate`.

## Fields

Every field is optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | `null` | `owner/name`. `null`: from the `origin` remote. |
| `baseBranch` | `null` | Where agent PRs land without `--base`. `null`: the repository's default branch. |
| `mergeableBases` | `null` | Bases `graft pr merge` may merge into, and the only bases `graft publish` cuts a new branch from or opens a PR against. `null`: `[baseBranch]`. `[]`: none. |
| `requiredCheck` | `null` | Check that defines a green base, for `graft pr merge` and `graft ci wait`. `null` turns the red-base rule off. |
| `validate.command` | `null` | Command `graft validate` runs. |
| `hooks.path` | `null` | Repo-relative hooks directory. `null`: git's `core.hooksPath`, else `.git/hooks`. |
| `hooks.run` | `["pre-commit", "prepare-commit-msg", "commit-msg", "pre-push"]` | Hooks graft runs during a publish. Absent ones are skipped. |
| `hooks.required` | `[]` | Hooks whose absence refuses a publish. |
| `protected.codeowners` | `true` | Use CODEOWNERS as the list of protected paths. |
| `protected.owners` | `[]` | Only CODEOWNERS lines naming one of these owners count. Empty: any owner. |
| `protected.extra` | `[]` | More protected patterns, CODEOWNERS syntax, enforced locally only. |
| `protected.impossible` | `[".github/workflows/**"]` | Paths the App cannot write; no grant unlocks them. |
| `payload.ceilingBytes` | `524288` | Most one publish may add to a single path. |
| `payload.neverPublish` | `["*.log"]` | Patterns never published, at any size. |
| `minVersion` | `null` | Oldest graft allowed to act on this repository. An older graft refuses every verb, and its session-start hook says so. |
| `app` | `null` | App slug that acts for this repository. `null`: by owner, then default. |

## Example

```json
{
  "baseBranch": "develop",
  "mergeableBases": ["develop"],
  "requiredCheck": "ci",
  "validate": { "command": "npm run ci" },
  "hooks": { "path": ".githooks", "required": ["pre-push"] },
  "protected": { "owners": ["@you"], "extra": [], "impossible": [".github/workflows/**"] },
  "payload": { "ceilingBytes": 524288, "neverPublish": ["*.log"] },
  "minVersion": "0.1.0"
}
```

## Always-protected paths

Whatever CODEOWNERS says, these are protected: `.graft.json` (or the `"graft"` key), CODEOWNERS, `.claude/settings.json`.

## State locations

| State | Location | Tracked |
| --- | --- | --- |
| Project policy | `.graft.json` | yes |
| Machine settings (`defaultApp`, `owners`) | `graft` section of `~/.oakgreen/forest.json` | no |
| Protected paths | CODEOWNERS | yes |
| App identity and private key | `$GRAFT_HOME/apps/<slug>/`, default `~/.oakgreen/graft/apps/<slug>/` (mode 0600, directory 0700) | no |
| Token cache | `~/.oakgreen/graft/cache/` (mode 0600) | no |
| REST answer cache (by ETag) | `~/.oakgreen/graft/cache/http/`; entries unused for 7 days are pruned | no |
| Rulesets written for manual import | `~/.oakgreen/graft/rulesets/<owner>-<repo>-<base>.json` | no |
| Maintainer grants (`maintainer/<session>.json`) and log (`maintainer.log`) | `<git-common-dir>/graft/` | no, shared by a clone's worktrees |
| Validation receipt | `<git-dir>/graft/validated-base.json` | no, per worktree |

## Environment

| Variable | Meaning |
| --- | --- |
| `GRAFT_APP` | App slug to act as, overriding the owner mapping. |
| `GRAFT_HOME` | Where App keys and caches live. Default `~/.oakgreen/graft`. |
| `OAKGREEN_FOREST_CONFIG_PATH` | The `forest.json` holding the machine settings. Default `~/.oakgreen/forest.json`. |
| `GRAFT_HTTP_CACHE` | `0` turns the REST answer cache off. With it on, a repeated GET asks GitHub only whether the answer changed; an unchanged answer is served from the cache and costs no rate limit. |
